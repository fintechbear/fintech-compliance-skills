---
name: java
description: Write regulation-compliant Java for core banking and payment systems built on Spring Boot / Spring Security, with correct hashing, envelope encryption, PII-safe logging, and audited, concurrency-safe money movement.
triggers: java, write code, implement, coding
---

# Skill: Java for Regulated Fintech

**Write regulation-compliant Java for core banking and payment systems built on Spring Boot / Spring Security, with correct hashing, envelope encryption, PII-safe logging, and audited, concurrency-safe money movement.** Load this skill whenever the task touches money, accounts, cards, personal data, or authentication in a Java/Spring Boot codebase.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Java-specific *how*; the refusal policy defines the red lines that override everything here.

## When to use

- Core banking, ledger, payment, transfer, or onboarding (KYC) services written in Java (8/11/17/21) on Spring Boot 2.7 / 3.x with Spring Security.
- Any Java code that stores or processes passwords, card data (PAN/CVV), IBANs, national IDs, or other PII.
- Persistence with JPA / Hibernate (Spring Data JPA) where concurrent balance updates are possible.
- Services that must produce an audit trail and PII-safe logs for regulators (PCI-DSS, GDPR/DORA, SOX/GLBA, KVKK/BDDK, FCA).

If the task is storage-engine specific (column encryption, TDE, RLS), also load the matching database skill under `skills/databases/`.

## Logging — what goes where

Java fintech services should log through **SLF4J** as the facade, backed by **Logback** (Spring Boot default) or **Log4j2**. Emit **structured JSON** so a SIEM can index and a regulator can query.

**Structured logging libraries**
- Logback + [`logstash-logback-encoder`](https://github.com/logfellow/logstash-logback-encoder) (`net.logstash.logback.encoder.LogstashEncoder` / `LoggingEventCompositeJsonEncoder`).
- Log4j2 with `JsonTemplateLayout`.
- Always attach a correlation/trace id via **MDC** (`org.slf4j.MDC.put("traceId", ...)`) — with Spring Cloud Sleuth / Micrometer Tracing this is automatic.

**Which events, which sink, which level**

| Event | Level | Sink |
|---|---|---|
| Auth success / failure, password change, role change | `INFO` / `WARN` | security audit stream (append-only) |
| Money movement (transfer, debit, credit, reversal) | `INFO` | audit store (DB table or WORM log), not just the app log |
| Authorization denials, access to another customer's data attempt | `WARN` | security audit stream |
| Validation rejects of financial input | `INFO` | app log |
| Unhandled exceptions, integration failures | `ERROR` | app log + alerting |
| `DEBUG`/`TRACE` request/response bodies | **off in prod** | — (these leak PII) |

**What is MASKED before it hits any sink** — PAN (show only last 4), CVV (never — see below), passwords, OAuth/JWT/session tokens, API keys, full national IDs (e.g. TCKN, SSN), IBAN (mask all but last 4), auth headers, OTPs.

Two Java-native masking mechanisms:

```xml
<!-- Logback: %replace conversion word — regex substitution in the pattern, zero Java code.
     Masks a predictable PAN-like 13–19 digit run. One %replace masks ONE pattern;
     nest or chain for multiple. -->
<pattern>%replace(%msg){'\b(\d[ -]*?){12,15}(\d{4})\b', '****-****-****-$2'}%n</pattern>
```

```xml
<!-- Logback JSON: mask structured fields by key with logstash-logback-encoder -->
<encoder class="net.logstash.logback.encoder.LogstashEncoder">
  <jsonGeneratorDecorator class="net.logstash.logback.mask.MaskingJsonGeneratorDecorator">
    <path>pan</path>
    <path>cvv</path>
    <path>password</path>
    <path>token</path>
    <path>nationalId</path>
    <defaultMask>****</defaultMask>
    <!-- value-based masking by regex is also supported via <value>…</value> -->
  </jsonGeneratorDecorator>
</encoder>
```

For **Log4j2**, use a `RewritePolicy` (`org.apache.logging.log4j.core.appender.rewrite.RewriteAppender` + a custom `RewritePolicy`) to scrub the message/`MapMessage` before it reaches the appender. Do **not** rely only on a pattern-layout regex for JSON payloads — mask at the structured-field level so nested fields are caught.

Defense in depth: never pass raw PII into the log call in the first place. Masking is the safety net, not the primary control.

**What is NEVER logged:** CVV/CVC, full PAN, full track/magstripe/chip data, PIN or PIN block, plaintext passwords or password hashes, private keys, symmetric data keys, full OAuth/refresh tokens, full national IDs. (Refusal policy rules 1, 3, 4.)

**Log integrity:** money-movement and security events must be tamper-evident. Options: a dedicated append-only DB table with no `UPDATE`/`DELETE` grant to the app role; ship logs to a **WORM** sink (e.g. S3 Object Lock, write-once bucket) outside the app's delete authority; or hash-chain audit rows (`row.hash = SHA-256(prevHash || canonical(row))`) so a deleted/edited row breaks the chain. Clock-sync the hosts (NTP) so timestamps are trustworthy. PCI-DSS v4.0.1 Req. 10 and SOX both require this.

## Workflow — payment / transfer / onboarding

Canonical money-movement step order in a Spring service:

1. **Authenticate & authorize** — `@PreAuthorize("hasAuthority('transfer.execute')")` on the service method; confirm the caller owns/controls the source account. Fail closed.
2. **Validate at the boundary** — Bean Validation (`jakarta.validation` / `javax.validation`: `@NotNull`, `@Positive`, `@DecimalMin`), explicit currency, amount as `BigDecimal` or minor-unit `long` — **never `double`/`float`** (core rule).
3. **Idempotency gate** — require a client `Idempotency-Key`; look it up first. If seen, return the stored result instead of re-executing. Persist the key in the same transaction as the effect, with a unique constraint, so a concurrent retry collides rather than double-spends.
4. **Approval gates** — enforce maker-checker / dual control and limit thresholds (e.g. SCA step-up, sanctions/AML hold) **before** funds move. For onboarding: KYC/sanctions screening must pass before the account is usable (refusal rule 5).
5. **Execute inside one DB transaction** — `@Transactional`. Debit source, credit destination, write the ledger entries, and write the **audit record** atomically. If anything fails, the whole unit rolls back; an audit row must never persist for a transfer that didn't happen, and vice versa.
6. **Audit record** — who (actor), what (action), when (server UTC), source, destination, amount+currency, idempotency key, before/after balances. Append-only (see Log integrity).
7. **Emit event / notify** — only after commit (use `@TransactionalEventListener(phase = AFTER_COMMIT)` so downstream never sees an uncommitted transfer).

**Concurrency / locking model (JPA / Hibernate):**

- **Optimistic locking (default; best for low-contention, read-mostly):** add a `@Version` field. Hibernate adds `WHERE version = ?` to updates and bumps the column; a lost update throws `OptimisticLockException` / Spring's `ObjectOptimisticLockingFailureException`. Catch and **retry** the business operation (re-read, re-apply). Only the provider may set `@Version`.

```java
@Entity
class Account {
    @Id Long id;
    @Version long version;               // JPA optimistic lock token
    @Column(nullable = false) long balanceMinor;   // minor units, never double
    @Column(nullable = false, length = 3) String currency;
}
```

- **Pessimistic locking (for hot rows / high-contention balances):** take a row lock up front so concurrent writers serialize.

```java
public interface AccountRepository extends JpaRepository<Account, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)   // -> SELECT ... FOR UPDATE
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    Optional<Account> findForUpdate(Long id);
}
```

Set a lock timeout to avoid indefinite blocking/deadlock; always lock multiple accounts in a deterministic order (e.g. ascending id) to prevent deadlocks on transfers. Choose a DB isolation level of at least `READ_COMMITTED` (PostgreSQL/Oracle default); money math should not rely on `READ_UNCOMMITTED`.

## Hashing & encryption

### Hashed one-way (passwords, secrets you only verify)

Use **Spring Security** `PasswordEncoder`. Preferred: **Argon2id**.

- **OWASP Password Storage Cheat Sheet minimum:** Argon2id with **≥19 MiB memory (m = 19456 KiB), iterations t = 2, parallelism p = 1**. ([owasp](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html))
- Spring's `Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()` ships **salt 16 B, hash 32 B, parallelism 1, memory `1<<14` = 16384 KiB, iterations 2** (verified in [spring-security source](https://github.com/spring-projects/spring-security/blob/main/crypto/src/main/java/org/springframework/security/crypto/argon2/Argon2PasswordEncoder.java)). **16384 KiB is below OWASP's 19456 minimum** — in regulated fintech, construct the encoder explicitly at ≥19456 rather than taking the default. Requires **BouncyCastle** (`org.bouncycastle:bcprov-jdk18on`) on the classpath.

```java
// Argon2id tuned to meet/exceed OWASP: saltLen=16, hashLen=32, p=1, memory=19456 KiB, iterations=2
PasswordEncoder encoder = new Argon2PasswordEncoder(16, 32, 1, 19456, 2);
```

- **bcrypt** is the acceptable fallback when Argon2/BouncyCastle is unavailable: `new BCryptPasswordEncoder(12)` (work factor ≥10, ≥12 preferred). Note bcrypt silently truncates input at **72 bytes** — pre-hash long/Unicode passwords (e.g. SHA-256 → Base64) before bcrypt, or use Argon2.
- Use **`DelegatingPasswordEncoder`** (`PasswordEncoderFactories.createDelegatingPasswordEncoder()`) so stored hashes carry an `{id}` prefix (`{argon2}`, `{bcrypt}`) and you can migrate algorithms over time. Call `encoder.upgradeEncoding(hash)` on login to rehash when parameters strengthen.
- **PBKDF2** (`Pbkdf2PasswordEncoder`) only where **FIPS 140** forbids Argon2/bcrypt — then ≥600,000 HMAC-SHA256 iterations (OWASP).
- **Forbidden:** MD5, SHA-1, plain SHA-256/512 for passwords, any unsalted or reversible scheme (refusal rules 2, 4).

### Encrypted two-way (data you must recover: PAN*, IBAN, national ID)

> *PAN: the right answer is usually **don't store it at all** — tokenize via the processor (network token / gateway `payment_method` id). Store CVV **never** (PCI-DSS). Encrypt PAN only if you are a PCI-scoped entity that genuinely must retain it.

Use **JCA (`javax.crypto`)** with **AES-256-GCM** (authenticated encryption):

- Transform: **`AES/GCM/NoPadding`**.
- IV: **96-bit (12-byte)** random per encryption from `SecureRandom` — **never reuse an IV with the same key** (catastrophic for GCM).
- Tag: **128-bit** via `new GCMParameterSpec(128, iv)`.
- Prepend the IV to the ciphertext; it is not secret.

```java
private static final SecureRandom RNG = new SecureRandom();

byte[] encrypt(byte[] dataKey /*256-bit*/, byte[] plaintext, byte[] aad) throws Exception {
    byte[] iv = new byte[12];
    RNG.nextBytes(iv);                                   // unique per message
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dataKey, "AES"),
           new GCMParameterSpec(128, iv));
    if (aad != null) c.updateAAD(aad);                   // bind context, e.g. accountId
    byte[] ct = c.doFinal(plaintext);
    return ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array();
}
```

**Key management — envelope encryption with a KMS/HSM:**
- Keep the master key in **AWS KMS / Azure Key Vault / GCP KMS / Thales HSM / HashiCorp Vault Transit** — never in the JVM, config, or source.
- Call KMS `GenerateDataKey` to get a plaintext **data key** (used in-memory for the AES-GCM call above) plus an encrypted data key stored next to the ciphertext. Decrypt the data key via KMS at read time. The AWS Encryption SDK for Java / the AWS SDK v2 `KmsClient` implement this pattern.
- **Zero the plaintext data key** (`Arrays.fill(dataKey, (byte)0)`) after use.
- **Rotate** master keys (KMS auto-rotation) and re-wrap data keys on schedule; support decrypting old-key data during rotation.

**Forbidden (refusal rule 4):** hardcoded keys/IVs, static or reused IVs, `AES/ECB/*`, `DES`/`3DES`, `"AES"` with no explicit mode (JCE defaults to **ECB** — a trap), home-rolled crypto, `Random`/`Math.random()` for keys or IVs (use `SecureRandom`), disabling TLS/cert validation for data in transit (rule 8). TLS 1.2+ for all sensitive transport.

## Country differences (how the same Java code changes)

Same service, controls toggled by region:

- **EU — GDPR, PSD2, DORA.** PSD2 **SCA**: two-factor + **dynamic linking** on payments (bind the auth to amount+payee) — add a step-up gate in the transfer workflow. GDPR: lawful basis, data-subject erasure (design PII for deletion/crypto-shredding — drop the data key to render ciphertext unrecoverable), data minimization in logs. **DORA** (in force Jan 2025): ICT resilience, incident reporting, tested resilience — your audit/log integrity and retention must satisfy it.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + segregation of duties on financial reporting paths (enforce maker-checker, lock down who can alter ledger/audit tables). GLBA Safeguards Rule: encryption of customer financial data at rest/in transit and access logging. CCPA/CPRA: consumer data access/delete — same deletion design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (close to GDPR) governs personal-data processing and explicit consent. **BDDK data-localization**: banking data of Turkish customers must be stored/processed **in Turkey** — your KMS, DB, and backups must be in-region; make the data residency a deploy-time/config boundary, not hardcoded. **MASAK**: AML/suspicious-transaction reporting — the sanctions/AML hold and reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits) — treat as encrypted PII, mask in logs, validate the checksum.
- **UK — FCA, UK GDPR, PRA.** FCA operational-resilience and reporting; UK GDPR mirrors EU GDPR post-Brexit; Strong Customer Authentication still applies under UK PSRs. Same SCA and PII-deletion machinery as EU, different reporting endpoints/retention.

Implementation pattern: keep these as **policy/config per tenant or region** (feature flags, a `RegionPolicy` bean), not `if (country == …)` scattered through business logic.

## Good example

```java
@Service
class TransferService {

    private final AccountRepository accounts;
    private final LedgerRepository ledger;
    private final AuditService audit;

    @Transactional
    @PreAuthorize("hasAuthority('transfer.execute') and @ownership.owns(#cmd.sourceId())")
    public TransferResult transfer(TransferCommand cmd) {
        // 1. Validate (currency explicit; amount in minor units, never double)
        if (cmd.amountMinor() <= 0) throw new InvalidAmountException();

        // 2. Idempotency: stored key short-circuits a retry (no double-spend)
        var existing = ledger.findByIdempotencyKey(cmd.idempotencyKey());
        if (existing.isPresent()) return existing.get().toResult();

        // 3. Lock rows in deterministic order to avoid deadlock
        Long first = Math.min(cmd.sourceId(), cmd.destId());
        Long second = Math.max(cmd.sourceId(), cmd.destId());
        Account a = accounts.findForUpdate(first).orElseThrow();   // SELECT ... FOR UPDATE
        Account b = accounts.findForUpdate(second).orElseThrow();
        Account src = a.id().equals(cmd.sourceId()) ? a : b;
        Account dst = src == a ? b : a;

        if (!src.currency().equals(cmd.currency()) || src.balanceMinor() < cmd.amountMinor())
            throw new InsufficientFundsException();

        // 4. Apply + 5. Audit atomically in this transaction
        src.debit(cmd.amountMinor());
        dst.credit(cmd.amountMinor());
        ledger.save(LedgerEntry.of(cmd));                 // carries the idempotency key (unique)
        audit.record(AuditEvent.builder()
                .actor(SecurityContextHolder.getContext().getAuthentication().getName())
                .action("transfer")
                .amountMinor(cmd.amountMinor()).currency(cmd.currency())
                .from(cmd.sourceId()).to(cmd.destId())
                .idempotencyKey(cmd.idempotencyKey())
                .at(Instant.now()).build());               // append-only sink

        return TransferResult.ok(cmd.idempotencyKey());
        // CVV/PAN never touched here; passwords hashed elsewhere with Argon2id
    }
}
```

```java
// Password storage done right (Argon2id ≥ OWASP), via DelegatingPasswordEncoder
@Bean
PasswordEncoder passwordEncoder() {
    String id = "argon2";
    Map<String, PasswordEncoder> encoders = Map.of(
        "argon2", new Argon2PasswordEncoder(16, 32, 1, 19456, 2),  // m=19 MiB, t=2, p=1
        "bcrypt", new BCryptPasswordEncoder(12));
    return new DelegatingPasswordEncoder(id, encoders);           // stores {argon2}$… prefix
}
```

## Bad example

```java
// ❌ Every line crosses a red line — refuse to write this.
@PostMapping("/pay")
public String pay(@RequestParam String pan, @RequestParam String cvv, double amount) {

    log.info("charging card {} cvv {} amount {}", pan, cvv, amount);  // logs PAN+CVV — rules 1,3

    user.setPassword(password);                        // plaintext password — rule 2
    user.setPasswordMd5(DigestUtils.md5Hex(password)); // broken hash — rule 2,4

    Cipher c = Cipher.getInstance("AES");              // defaults to AES/ECB — rule 4
    SecretKeySpec k = new SecretKeySpec(
        "hardcoded-secret".getBytes(), "AES");         // hardcoded key — rules 4,7

    account.setBalance(account.getBalance() - amount); // double money, no @Version,
    account.setBalance(dest.getBalance() + amount);    // no idempotency, no audit,
    accountRepo.save(account);                         // no lock -> lost update, no audit — rule 6
    return "ok";
}
```

Red lines crossed: storing/logging PAN & CVV (PCI-DSS, rules 1, 3), plaintext & MD5 passwords (rule 2/4), AES-ECB + hardcoded key (rule 4, 7), floating-point money (core), no idempotency/lock (lost update), no audit record on money movement (rule 6). The compliant alternatives are the *Good example* above and tokenization of the card via the processor. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md).
