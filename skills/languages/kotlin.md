# Skill: Kotlin for Regulated Fintech

**Write regulation-compliant Kotlin for mobile-banking backends (Spring Boot / Ktor) and Android clients, with correct password hashing, envelope encryption, PII-safe logging, coroutine-safe money movement, and hardware-backed on-device key storage.** Load this skill whenever the task touches money, accounts, cards, personal data, or authentication in a Kotlin codebase — server **or** Android.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Kotlin-specific *how* for both server and Android; the refusal policy defines the red lines that override everything here.

## When to use

- Mobile-banking **backends** written in Kotlin on **Spring Boot 3.x** (Spring Security, Spring Data) or **Ktor 2.x/3.x** server, handling transfers, payments, ledger, onboarding (KYC), or auth.
- **Android** banking/payment apps (Kotlin + Jetpack/Compose) that handle PAN, CVV, IBAN, national IDs, passwords, tokens, or biometrics.
- Any Kotlin code that stores or processes passwords, card data, IBANs, national IDs (TCKN/SSN), or other PII.
- Persistence with **Exposed**, **Spring Data JPA/R2DBC**, or **Room** (Android) where concurrent balance updates are possible.
- Code using **coroutines** around transactions or crypto, where structured concurrency and thread/connection affinity matter for correctness.

Server and Android differ sharply on key storage, logging sinks, and trust assumptions (the device is adversarial). Both halves are covered below; apply the half that matches your target. If the task is storage-engine specific (column encryption, TDE, RLS), also load the matching database skill under `skills/databases/`.

## Logging — what goes where

### Server (Spring Boot / Ktor)

Log through **SLF4J** as the facade. On the JVM the idiomatic Kotlin wrapper is [`io.github.oshai:kotlin-logging`](https://github.com/oshai/kotlin-logging) (`private val log = KotlinLogging.logger {}`), which delegates to SLF4J/Logback and gives you lazy `log.info { "..." }` lambdas (the string is only built if the level is enabled). Back it with **Logback** (Spring Boot default; Ktor's common choice) emitting **structured JSON** via [`logstash-logback-encoder`](https://github.com/logfellow/logstash-logback-encoder) so a SIEM can index and a regulator can query.

Attach a correlation/trace id via **MDC** (`org.slf4j.MDC`). With coroutines, MDC does **not** propagate across suspension/dispatch automatically — use `kotlinx-coroutines-slf4j`'s `MDCContext` element (`withContext(MDCContext()) { ... }`) or the trace id is lost on the thread hop. Spring Boot + Micrometer Tracing wires this for you on the servlet path.

**Which events, which sink, which level**

| Event | Level | Sink |
|---|---|---|
| Auth success / failure, password change, role change | `INFO` / `WARN` | security audit stream (append-only) |
| Money movement (transfer, debit, credit, reversal) | `INFO` | audit store (DB table or WORM log), not just the app log |
| Authorization denials, cross-customer access attempt | `WARN` | security audit stream |
| Validation rejects of financial input | `INFO` | app log |
| Unhandled exceptions, integration failures | `ERROR` | app log + alerting |
| `DEBUG`/`TRACE` request/response bodies | **off in prod** | — (these leak PII) |

**What is MASKED before it hits any sink** — PAN (show only last 4), CVV (never — see below), passwords, OAuth/JWT/session tokens, API keys, full national IDs (TCKN, SSN), IBAN (mask all but last 4), auth headers, OTPs.

Mask at the **structured-field level**, not only with a pattern regex, so nested JSON fields are caught:

```xml
<!-- Logback JSON: mask structured fields by key with logstash-logback-encoder -->
<encoder class="net.logstash.logback.encoder.LogstashEncoder">
  <jsonGeneratorDecorator class="net.logstash.logback.mask.MaskingJsonGeneratorDecorator">
    <path>pan</path>
    <path>cvv</path>
    <path>password</path>
    <path>token</path>
    <path>nationalId</path>
    <path>iban</path>
    <defaultMask>****</defaultMask>
  </jsonGeneratorDecorator>
</encoder>
```

```xml
<!-- Defense-in-depth regex for a PAN-like run that slips into a free-text message -->
<pattern>%replace(%msg){'\b(\d[ -]*?){12,15}(\d{4})\b', '****-****-****-$2'}%n</pattern>
```

Model PII so it cannot be logged by accident. A Kotlin value class / data class holding card data should override `toString()`:

```kotlin
@JvmInline
value class Pan(private val value: String) {
    fun last4() = value.takeLast(4)
    override fun toString() = "PAN(****${last4()})"   // interpolation can never leak the full PAN
}
```

Beware: a Kotlin **`data class` auto-generates a `toString()` that prints every property** — a `data class Card(val pan: String, val cvv: String)` will dump both if interpolated into a log line. Never make PAN/CVV/password plain properties of a `data class`; wrap them in a masking type or keep them out of the class.

**What is NEVER logged:** CVV/CVC, full PAN, full track/magstripe/chip data, PIN or PIN block, plaintext passwords or password hashes, private keys, symmetric data keys, full OAuth/refresh tokens, full national IDs. (Refusal policy FCS-PAN-001/FCS-SAD-001/FCS-LOG-001.)

**Log integrity:** money-movement and security events must be tamper-evident — a dedicated append-only DB table with no `UPDATE`/`DELETE` grant to the app role, a **WORM** sink (S3 Object Lock), or hash-chained audit rows (`row.hash = SHA-256(prevHash || canonical(row))`). NTP-sync the hosts. PCI-DSS v4.0.1 Req. 10 and SOX both require this.

### Android (the device is adversarial — treat logs as world-readable)

`android.util.Log` (and `Timber`) write to **logcat**. On a rooted or debuggable device logcat is readable by other processes and by anyone with ADB, and it is captured in bug reports. **Nothing sensitive may ever reach logcat** — no PAN, no CVV, no PIN, no password, no token, no full national ID, no session cookie, no balance tied to an identity. This is non-negotiable (OWASP MASVS-STORAGE-2 / MASTG).

- Strip logs from release builds. Timber: plant a `DebugTree()` **only** in `if (BuildConfig.DEBUG)`; plant a no-op or crash-reporter tree in release.
- Remove `Log.d/v` from release with ProGuard/R8 (`-assumenosideeffects class android.util.Log { ... }`) — but this is a backstop, not a licence to log secrets in debug.
- Never log full request/response bodies of banking APIs. If you use an OkHttp `HttpLoggingInterceptor`, set it to `NONE` in release and redact `Authorization`/`Cookie`/`Set-Cookie` headers even in debug.
- Server-side audit is the source of truth for the mobile flow; the Android client sends events to the backend audit stream, it does not keep its own security log on disk.

## Workflow — payment / transfer / onboarding

### Server step order (Spring or Ktor)

1. **Authenticate & authorize** — Spring: `@PreAuthorize("hasAuthority('transfer.execute')")`; Ktor: `authenticate("auth-jwt") { ... }` + an explicit ownership check. Confirm the caller controls the source account. Fail closed.
2. **Validate at the boundary** — explicit currency; amount as `BigDecimal` or a minor-unit `Long` — **never `Double`/`Float`** (core rule). Kotlin `require(...)` / Bean Validation.
3. **Idempotency gate** — require a client `Idempotency-Key`; look it up first and return the stored result on a repeat. Persist the key in the **same transaction** as the effect with a unique constraint, so a concurrent retry collides rather than double-spends.
4. **Approval gates** — maker-checker / dual control, limit thresholds, SCA step-up, sanctions/AML hold **before** funds move. Onboarding: KYC/sanctions screening must pass before the account is usable (FCS-AML-001).
5. **Execute inside ONE DB transaction** — debit, credit, ledger rows, and the **audit record** commit atomically or roll back together.
6. **Audit record** — actor, action, server-UTC time, source, destination, amount+currency, idempotency key, before/after balances. Append-only.
7. **Emit event / notify** — only **after commit**.

**Coroutines + transactions — the critical Kotlin pitfall.** A JDBC/JPA transaction is bound to a **thread** (connection + `ThreadLocal`). A coroutine can suspend and resume on a **different** thread, which silently breaks transaction/connection affinity. Rules:

- **Spring + JPA (blocking):** keep the transactional unit on one thread. Put `@Transactional` on a plain (non-`suspend`) method, or confine blocking JDBC work to `Dispatchers.IO` and do **not** suspend in the middle of it. Do not split one transaction across multiple `async` coroutines.
- **Spring Data R2DBC / reactive:** use `TransactionalOperator` (reactive transactions do propagate through the reactive context) rather than thread-bound `@Transactional`.
- **Exposed (common with Ktor):** use **`newSuspendedTransaction(Dispatchers.IO) { ... }`** for coroutine code — it keeps the transaction pinned to one connection across suspensions. Plain `transaction { }` inside a coroutine is a bug.

```kotlin
// Exposed + coroutines: the whole money move is one suspended transaction
suspend fun transfer(cmd: TransferCommand): TransferResult =
    newSuspendedTransaction(Dispatchers.IO) {
        // idempotency short-circuit
        Ledger.select { Ledger.idemKey eq cmd.idempotencyKey }.firstOrNull()?.let {
            return@newSuspendedTransaction it.toResult()
        }
        // deterministic lock order avoids deadlock on crossing transfers
        val (firstId, secondId) = listOf(cmd.sourceId, cmd.destId).sorted()
        val rows = Accounts.select { Accounts.id inList listOf(firstId, secondId) }
            .forUpdate()                                // SELECT ... FOR UPDATE
            .associateBy { it[Accounts.id].value }
        val src = rows.getValue(cmd.sourceId); val dst = rows.getValue(cmd.destId)
        require(src[Accounts.currency] == cmd.currency && src[Accounts.balanceMinor] >= cmd.amountMinor)
        Accounts.update({ Accounts.id eq cmd.sourceId }) { it[balanceMinor] = src[balanceMinor] - cmd.amountMinor }
        Accounts.update({ Accounts.id eq cmd.destId })   { it[balanceMinor] = dst[balanceMinor] + cmd.amountMinor }
        Ledger.insert { it[idemKey] = cmd.idempotencyKey; /* amount, currency, actor, utc ts ... */ }  // unique idemKey
        TransferResult.ok(cmd.idempotencyKey)
    }
```

**Concurrency / locking model:**
- **Optimistic (low-contention):** a `version` column; `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`; retry on zero rows affected. In JPA use `@Version`.
- **Pessimistic (hot balance rows):** `SELECT ... FOR UPDATE` (Exposed `.forUpdate()`, JPA `@Lock(PESSIMISTIC_WRITE)`), with a lock timeout, locking accounts in deterministic id order to avoid deadlock.
- Isolation `READ_COMMITTED` or stronger; never `READ_UNCOMMITTED` for money math.

### Android (client) onboarding/payment flow

The phone is **untrusted**: all authorization, limits, SCA, and idempotency are enforced **server-side**. The client's job is to collect input safely, authenticate the user to the device-bound key, and call the backend.

1. **Device/app integrity** before sensitive flows — Play Integrity API (and/or root/tamper detection; see Country/context note below). Treat a failed/absent attestation as a reason to degrade or block, not to trust a local flag.
2. **User presence** — unlock a Keystore key behind biometric/PIN (`BiometricPrompt` + `setUserAuthenticationRequired`).
3. **Idempotency key generated client-side**, sent with the request; the **server** enforces it. The client must tolerate retry (poor mobile networks) without assuming success.
4. **Never compute balances or approve transfers locally** as the source of truth; render server results.
5. Hold session/refresh tokens only in hardware-backed storage (below), scoped so they are invalidated on new biometric enrolment.

## Hashing & encryption

### Hashed one-way (passwords) — SERVER ONLY

Passwords are verified on the **server**, never hashed-and-trusted on the device.

**Spring Boot:** use Spring Security's `PasswordEncoder`. Preferred **Argon2id** via `Argon2PasswordEncoder` (needs **BouncyCastle** `org.bouncycastle:bcprov-jdk18on`).

- **OWASP Password Storage minimum:** Argon2id with **m = 19456 KiB (≥19 MiB), t = 2, p = 1**. ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html))
- Spring's `Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()` defaults to **memory 16384 KiB** — **below** OWASP's 19456 minimum. In regulated fintech construct it explicitly.

```kotlin
// Argon2id tuned to meet/exceed OWASP: saltLen=16, hashLen=32, p=1, memory=19456 KiB, iterations=2
val encoder: PasswordEncoder = Argon2PasswordEncoder(16, 32, 1, 19456, 2)

@Bean
fun passwordEncoder(): PasswordEncoder {
    val encoders = mapOf(
        "argon2" to Argon2PasswordEncoder(16, 32, 1, 19456, 2),
        "bcrypt" to BCryptPasswordEncoder(12),
    )
    return DelegatingPasswordEncoder("argon2", encoders)   // stores {argon2}$... prefix for migration
}
```

**Ktor (no built-in hasher — you add a library):**
- Argon2id via [`de.mkammerer:argon2-jvm`](https://github.com/phxql/argon2-jvm) (`Argon2Factory.create(ARGON2id)`, `hash(t, mKiB, p, password)` → encoded string, `verify(hash, password)`), or
- bcrypt via [`at.favre.lib:bcrypt`](https://github.com/patrickfav/bcrypt) (actively maintained; preferred over the old `org.mindrot:jbcrypt`), cost **≥12**.

```kotlin
// Ktor: Argon2id with argon2-jvm, parameters at/above OWASP
val argon2 = Argon2Factory.create(Argon2Factory.Argon2Types.ARGON2id)
val hash: String = argon2.hash(2, 19456, 1, password)   // t=2, m=19456 KiB, p=1
val ok: Boolean = argon2.verify(hash, password)
argon2.wipeArray(password)                               // zero the char[] when done
```

- **bcrypt** truncates input at **72 bytes** — pre-hash long/Unicode passwords (SHA-256 → Base64) before bcrypt, or use Argon2.
- **PBKDF2** only where **FIPS 140** forbids Argon2/bcrypt — then ≥600,000 HMAC-SHA256 iterations (OWASP).
- **Forbidden:** MD5, SHA-1, plain SHA-256/512 for passwords, unsalted or reversible schemes (refusal FCS-SECRET-001/FCS-CRYPTO-001). Do **not** hash passwords on the Android client.

### Encrypted two-way — SERVER

Data you must recover (PAN\*, IBAN, national ID). Use **JCA (`javax.crypto`)** with **AES-256-GCM**:

> \*PAN: the right answer is usually **don't store it** — tokenize via the processor (network token / gateway `payment_method` id). Store CVV **never** (PCI-DSS). Encrypt PAN only if you are a PCI-scoped entity that must retain it.

- Transform **`AES/GCM/NoPadding`**; IV **96-bit random** per message from `SecureRandom` (**never reuse an IV with a key**); tag **128-bit** (`GCMParameterSpec(128, iv)`); prepend the IV (not secret).

```kotlin
private val rng = SecureRandom()

fun encrypt(dataKey: ByteArray /*256-bit*/, plaintext: ByteArray, aad: ByteArray?): ByteArray {
    val iv = ByteArray(12).also { rng.nextBytes(it) }        // unique per message
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(dataKey, "AES"), GCMParameterSpec(128, iv))
    aad?.let { cipher.updateAAD(it) }                        // bind context, e.g. accountId
    val ct = cipher.doFinal(plaintext)
    return ByteBuffer.allocate(iv.size + ct.size).put(iv).put(ct).array()
}
```

**Key management — envelope encryption with a KMS/HSM:** master key in **AWS KMS / Azure Key Vault / GCP KMS / HashiCorp Vault Transit / Thales HSM** — never in the JVM, config, or source. `GenerateDataKey` → use the plaintext data key in-memory, store the encrypted data key beside the ciphertext, decrypt via KMS at read time. **Zero** the plaintext data key (`dataKey.fill(0)`) after use. **Rotate** master keys and re-wrap on schedule; support decrypting old-key data during rotation. Crypto-shredding (drop the data key) satisfies "right to erasure".

**Forbidden (FCS-CRYPTO-001):** hardcoded keys/IVs, static/reused IVs, `AES/ECB/*`, `DES`/`3DES`, `Cipher.getInstance("AES")` with no mode (**defaults to ECB** — a trap), home-rolled crypto, `Random`/`Math.random()`/`kotlin.random.Random` for keys/IVs (use `SecureRandom`), disabling TLS/cert validation (FCS-TLS-001). TLS 1.2+ everywhere.

### Encrypted two-way — ANDROID (hardware-backed, the big difference)

On-device secrets (session/refresh tokens, cached encrypted PII, the key that protects a local DB) must be protected by a key that **never leaves hardware**. Use the **Android Keystore**: keys live in the TEE or a **StrongBox** secure element and are non-exportable; you get a handle, not the bytes.

```kotlin
// Generate an AES-256-GCM key bound to this device's hardware, user-auth gated
val spec = KeyGenParameterSpec.Builder(
    "bank_data_key",
    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256)
    .setUserAuthenticationRequired(true)                 // require biometric/PIN to USE the key
    .setUserAuthenticationParameters(30, KeyProperties.AUTH_BIOMETRIC_STRONG) // API 30+
    .setInvalidatedByBiometricEnrollment(true)           // new fingerprint => key invalid (anti-tamper)
    .setUnlockedDeviceRequired(true)                     // usable only while device unlocked (API 28+)
    .setIsStrongBoxBacked(true)                          // secure element if present; catch & retry false
    .build()

val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
kg.init(spec); kg.generateKey()
// Use via BiometricPrompt.authenticate(CryptoObject(cipher)) so the key only unlocks after presence.
```

- **`setIsStrongBoxBacked(true)`** can throw `StrongBoxUnavailableException` on devices without a secure element — catch it and retry with `false` (TEE), don't fail the app.
- Decryption that touches customer data should sit behind **`BiometricPrompt`** with a `CryptoObject`, so the key is only usable after a fresh user-presence check.
- **EncryptedSharedPreferences / Jetpack Security `security-crypto`: deprecated.** The stable **1.1.0** release (July 30, 2025) shipped with **every API deprecated** (`MasterKey.Builder`, `EncryptedSharedPreferences`, `EncryptedFile`), and the old `MasterKeys` helper was removed earlier. It still *functions*, so legacy code is fine short-term, but **new code should not adopt it**. Google's direction is **Jetpack DataStore + Google Tink** (`tink-android`) for key-value secrets, or **direct Android Keystore** use as above. Do not follow pre-2025 tutorials that present `MasterKeys`/EncryptedSharedPreferences as current.
- **Never** hardcode a key in the APK, in `strings.xml`, in `BuildConfig`, in `gradle.properties`, or in native `.so` — it is trivially extractable. The only root of trust on device is the Keystore-held key.
- For a local encrypted DB (e.g. **SQLCipher** for Room), store the SQLCipher passphrase as a Keystore-wrapped blob, never in prefs as plaintext.
- TLS: use the platform trust store + **certificate/public-key pinning** (Network Security Config `<pin-set>` or OkHttp `CertificatePinner`). **Never** ship a `TrustManager` that accepts all certs or a `HostnameVerifier` returning `true` (FCS-TLS-001).

## Country differences (how the same Kotlin code changes)

Keep these as **policy/config per tenant or region** (a `RegionPolicy` bean / feature flags), not `if (country == ...)` scattered through business logic. Same server code, same app, controls toggled by region.

- **EU — GDPR, PSD2, DORA.** PSD2 **SCA**: two-factor + **dynamic linking** (bind auth to amount+payee) — a step-up gate in the transfer workflow and, on Android, a `BiometricPrompt`/Keystore signature over the transaction details. GDPR: lawful basis, data-subject erasure (crypto-shred by dropping the data key), log minimization. **DORA** (in force Jan 2025): ICT resilience, incident reporting, tested resilience — your audit/log integrity and retention must satisfy it.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + segregation of duties on financial-reporting paths (maker-checker, locked-down ledger/audit tables). GLBA Safeguards Rule: encryption of customer financial data at rest/in transit + access logging. CCPA/CPRA: consumer access/delete, same deletion design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (GDPR-like) governs personal data and explicit consent. **BDDK data-localization**: banking data of Turkish customers must be stored/processed **in Turkey** — KMS, DB, backups in-region; make residency a deploy/config boundary. **MASAK**: AML/suspicious-transaction reporting — sanctions/AML hold and reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits): encrypted PII, masked in logs/logcat, validate the checksum.
- **UK — FCA, UK GDPR, PRA.** FCA operational-resilience + reporting; UK GDPR mirrors EU GDPR; SCA still applies under UK PSRs. Same SCA and PII-deletion machinery as EU, different reporting endpoints/retention.

## Good example

```kotlin
// SERVER (Spring Boot + Spring Security): transfer done right
@Service
class TransferService(
    private val accounts: AccountRepository,
    private val ledger: LedgerRepository,
    private val audit: AuditService,
) {
    @Transactional                                   // one thread, one tx — no suspend inside
    @PreAuthorize("hasAuthority('transfer.execute') and @ownership.owns(#cmd.sourceId)")
    fun transfer(cmd: TransferCommand): TransferResult {
        require(cmd.amountMinor > 0) { "amount must be positive" }        // minor units, never Double

        ledger.findByIdempotencyKey(cmd.idempotencyKey)?.let { return it.toResult() }  // idempotent retry

        val (firstId, secondId) = listOf(cmd.sourceId, cmd.destId).sorted()            // deadlock-free order
        val a = accounts.findForUpdate(firstId) ?: error("missing")                     // SELECT ... FOR UPDATE
        val b = accounts.findForUpdate(secondId) ?: error("missing")
        val src = if (a.id == cmd.sourceId) a else b
        val dst = if (src === a) b else a

        require(src.currency == cmd.currency && src.balanceMinor >= cmd.amountMinor) { "insufficient funds" }

        src.debit(cmd.amountMinor); dst.credit(cmd.amountMinor)
        ledger.save(LedgerEntry.of(cmd))                                                // unique idempotency key
        audit.record(                                                                   // atomic with the money move
            AuditEvent(
                actor = SecurityContextHolder.getContext().authentication.name,
                action = "transfer", amountMinor = cmd.amountMinor, currency = cmd.currency,
                from = cmd.sourceId, to = cmd.destId, idempotencyKey = cmd.idempotencyKey,
                at = Instant.now(),
            )
        )
        return TransferResult.ok(cmd.idempotencyKey)     // CVV/PAN never touched; passwords hashed with Argon2id
    }
}
```

```kotlin
// ANDROID: store a session token in a hardware-backed, biometric-gated Keystore key — no plaintext prefs
class SecureTokenStore(private val context: Context) {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry("session_key", null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val builder = KeyGenParameterSpec.Builder(
            "session_key", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .setUnlockedDeviceRequired(true)
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(try { builder.setIsStrongBoxBacked(true).build() }
                catch (e: Exception) { builder.setIsStrongBoxBacked(false).build() })
        return kg.generateKey()
    }

    fun encrypt(token: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return c.iv + c.doFinal(token)        // 12-byte IV prepended; decrypt behind BiometricPrompt(CryptoObject)
        // token is NEVER written to SharedPreferences/logcat; no PAN/CVV stored on device at all
    }
}
```

## Bad example

```kotlin
// ❌ SERVER: every line crosses a red line — refuse to write this.
@PostMapping("/pay")
fun pay(@RequestParam pan: String, @RequestParam cvv: String, amount: Double): String {

    log.info { "charging card $pan cvv $cvv amount $amount" }   // logs PAN+CVV — FCS-PAN-001/FCS-SAD-001/FCS-LOG-001

    user.password = password                                    // plaintext password — FCS-SECRET-001
    user.passwordMd5 = DigestUtils.md5Hex(password)             // broken hash — FCS-SECRET-001/FCS-CRYPTO-001

    val c = Cipher.getInstance("AES")                           // defaults to AES/ECB — FCS-CRYPTO-001
    val k = SecretKeySpec("hardcoded-secret".toByteArray(), "AES")  // hardcoded key — FCS-SECRET-002/FCS-CRYPTO-001

    transaction {                                               // NOT newSuspendedTransaction in a coroutine
        account.balance = account.balance - amount              // Double money, no version,
        dest.balance = dest.balance + amount                    // no idempotency, no lock, no audit — FCS-AUDIT-001
    }
    return "ok"
}
```

```kotlin
// ❌ ANDROID: plaintext secrets on a device you don't control — refuse.
Log.d("pay", "pan=$pan cvv=$cvv token=$sessionToken")           // logcat leak — FCS-PAN-001/FCS-SAD-001/FCS-LOG-001 (MASVS-STORAGE)
prefs.edit().putString("session_token", sessionToken).apply()   // plaintext SharedPreferences — FCS-SECRET-002
val KEY = "0123456789abcdef0123456789abcdef"                     // hardcoded key in the APK — FCS-SECRET-002/FCS-CRYPTO-001
// deprecated path many tutorials still show:
EncryptedSharedPreferences.create(...)                          // deprecated API; use Keystore/DataStore+Tink
```

Red lines crossed: storing/logging PAN & CVV (PCI-DSS, FCS-PAN-001/FCS-SAD-001/FCS-LOG-001), plaintext/MD5 passwords (FCS-SECRET-001/FCS-CRYPTO-001), AES-ECB + hardcoded key (FCS-SECRET-002/FCS-CRYPTO-001), floating-point money (core), wrong coroutine transaction (`transaction` not `newSuspendedTransaction` → broken connection affinity), no idempotency/lock/audit on money movement (FCS-AUDIT-001), plaintext secrets and hardcoded keys on an untrusted device (FCS-SECRET-002), secrets in logcat (MASVS-STORAGE). The compliant alternatives are the *Good example* above, tokenization of the card via the processor, and hardware-backed Keystore storage on Android. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md).
