# Skill: Scala for Regulated Fintech

**Write regulation-compliant Scala for big-data/risk, payment, and core-banking systems built on the Typelevel (cats-effect) or ZIO stack with Akka/Pekko and Spark, with correct hashing, envelope encryption, PII-safe logging, and audited, concurrency-safe, resource-safe money movement.** Load this skill whenever the task touches money, accounts, cards, personal data, authentication, or batch risk pipelines in a Scala codebase.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Scala-specific *how*; the refusal policy defines the red lines that override everything here. Because Scala runs on the JVM, the [`java.md`](./java.md) crypto primitives (`javax.crypto`, JCA) apply verbatim — this skill shows the idiomatic functional-Scala wrapping.

## When to use

- Core banking, ledger, payment, transfer, or onboarding (KYC) services written in Scala (2.13 / 3.x) on **cats-effect / fs2 / http4s**, **ZIO / zio-http**, or **Akka/Pekko HTTP** (note: Akka moved to a BSL licence from 2.7; many regulated shops migrated to **Apache Pekko** — the APIs below are identical).
- **Spark / big-data risk** jobs that read, join, or persist PII, PAN, IBAN, national IDs, or scoring features (fraud, AML, credit risk).
- Any Scala code that stores or processes passwords, card data (PAN/CVV), IBANs, national IDs, or other PII.
- Persistence with **Doobie**, **Slick**, or **Quill** where concurrent balance updates are possible.
- Services that must produce an audit trail and PII-safe logs for regulators (PCI-DSS v4.0.1, GDPR/DORA, SOX/GLBA, KVKK/BDDK, FCA).

If the task is storage-engine specific (column encryption, TDE, RLS), also load the matching database skill under `skills/databases/`.

## Logging — what goes where

Scala fintech services should log through **SLF4J** as the facade. Idiomatic choices:
- **[log4cats](https://github.com/typelevel/log4cats)** (`org.typelevel::log4cats-slf4j`) for cats-effect — logging is an effect (`Logger[F]`), so it composes inside your `IO`/`F[_]` and never blocks silently.
- **[ZIO Logging](https://zio.dev/zio-logging/)** (`dev.zio::zio-logging-slf4j`) for ZIO — routes `ZIO.log*` through SLF4J and carries the ZIO log context/annotations.
- **scala-logging** (`com.typesafe.scala-logging::scala-logging`) — macro-based `Logger` wrapper over SLF4J for Akka/Pekko or plain Scala.

Backed by **Logback** or **Log4j2**, emitting **structured JSON** so a SIEM can index and a regulator can query. Avoid `println` entirely — it bypasses levels, masking, and sinks.

**Structured logging libraries**
- Logback + [`logstash-logback-encoder`](https://github.com/logfellow/logstash-logback-encoder) (`net.logstash.logback.encoder.LogstashEncoder` / `LoggingEventCompositeJsonEncoder`) — the same JVM encoder Java uses; it works identically from Scala.
- Log4j2 with `JsonTemplateLayout`.
- Attach a correlation/trace id: `MDC` works, but in cats-effect/ZIO a bare thread-local `MDC` is unreliable across fiber hops — prefer **log4cats `Logger[F].addContext(...)`** or **ZIO log annotations / `FiberRef`-backed MDC** so the trace id follows the fiber, not the thread.

**Which events, which sink, which level**

| Event | Level | Sink |
|---|---|---|
| Auth success / failure, password change, role change | `INFO` / `WARN` | security audit stream (append-only) |
| Money movement (transfer, debit, credit, reversal) | `INFO` | audit store (DB table or WORM log), not just the app log |
| Authorization denials, cross-customer data-access attempt | `WARN` | security audit stream |
| Validation rejects of financial input | `INFO` | app log |
| Unhandled errors, integration failures | `ERROR` | app log + alerting |
| `DEBUG`/`TRACE` request/response bodies | **off in prod** | — (these leak PII) |
| Spark job: row counts, stage timings, data-quality metrics | `INFO` | app log — **never** sample rows containing PII |

**What is MASKED before it hits any sink** — PAN (show only last 4), CVV (never — see below), passwords, OAuth/JWT/session tokens, API keys, full national IDs (e.g. TCKN, SSN), IBAN (mask all but last 4), auth headers, OTPs.

Two JVM-native masking mechanisms, used from Scala:

```xml
<!-- Logback: %replace conversion word — regex substitution in the pattern, zero code.
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

Scala-idiomatic defense in depth — make sensitive values **un-loggable at the type level** so a stray interpolation cannot leak them. Wrap secrets/PII in a value class whose `toString` is redacted:

```scala
// A PAN that cannot accidentally be printed in full. The real value is only
// reachable via an explicit `.reveal` used solely at the encrypt/tokenize boundary.
final class Pan private (private val value: String) {
  def last4: String = value.takeRight(4)
  def reveal: String = value                 // call site is auditable in code review
  override def toString: String = s"Pan(****${last4})"   // safe in s"$pan" and log msgs
}
object Pan {
  def apply(raw: String): Either[String, Pan] =
    if (raw.forall(_.isDigit) && raw.length >= 13 && raw.length <= 19) Right(new Pan(raw))
    else Left("invalid PAN")
}
```

The structured-field masking above is the safety net; the redacting `toString` is the primary control. For **Log4j2**, use a `RewritePolicy` to scrub the message/`MapMessage` before the appender. Do **not** rely only on a pattern-layout regex for JSON payloads — mask at the structured-field level so nested fields are caught.

**What is NEVER logged:** CVV/CVC, full PAN, full track/magstripe/chip data, PIN or PIN block, plaintext passwords or password hashes, private keys, symmetric data keys, full OAuth/refresh tokens, full national IDs. (Refusal policy rules 1, 3, 4.)

**Spark-specific trap:** `df.show()`, `.collect()`, `.take(n)`, and `.foreach(println)` dump raw rows to driver/executor logs — for a DataFrame holding PAN/PII this is a direct logging-of-card-data violation (rule 3). Log **aggregates and counts**, never sampled rows. Mask in the pipeline (`regexp_replace`, a UDF that returns only last-4) before any debug output, and keep `spark.sql.*` plans free of literal secrets.

**Log integrity:** money-movement and security events must be tamper-evident. Options: a dedicated append-only DB table with no `UPDATE`/`DELETE` grant to the app role; ship logs to a **WORM** sink (e.g. S3 Object Lock, write-once bucket) outside the app's delete authority; or hash-chain audit rows (`row.hash = SHA-256(prevHash || canonical(row))`) so a deleted/edited row breaks the chain. Clock-sync the hosts (NTP) so timestamps are trustworthy. PCI-DSS v4.0.1 Req. 10 and SOX both require this.

## Workflow — payment / transfer / onboarding

Canonical money-movement step order, expressed as a composed effect (`IO`/`ZIO`/`DBIOAction`) so the whole unit succeeds or rolls back together:

1. **Authenticate & authorize** — verify the caller owns/controls the source account before anything else. Fail closed (deny on any ambiguity).
2. **Validate at the boundary** — explicit currency; amount as **`BigDecimal`** or minor-unit **`Long`** — **never `Double`/`Float`** (core rule). Parse into a refined/validated type (e.g. `Refined`, a smart constructor returning `Either`) so invalid money cannot reach the ledger.
3. **Idempotency gate** — require a client `Idempotency-Key`; look it up first. If seen, return the stored result instead of re-executing. Persist the key **in the same transaction** as the effect, with a unique constraint, so a concurrent retry collides rather than double-spends.
4. **Approval gates** — enforce maker-checker / dual control and limit thresholds (SCA step-up, sanctions/AML hold) **before** funds move. For onboarding, KYC/sanctions screening must pass before the account is usable (FCS-AML-001).
5. **Execute inside one DB transaction** — debit source, credit destination, write the ledger entries, and write the **audit record** atomically (`.transactionally` in Slick, a single `ConnectionIO` `.transact` in Doobie). If anything fails the whole unit rolls back; an audit row must never persist for a transfer that didn't happen, and vice versa.
6. **Audit record** — who (actor), what (action), when (server UTC), source, destination, amount+currency, idempotency key, before/after balances. Append-only (see Log integrity).
7. **Emit event / notify** — only **after commit**. Never call an external API *inside* the DB transaction (it holds the connection and can leave you committed-but-un-notified or rolled-back-after-side-effect); use a transactional outbox or an `AFTER_COMMIT` hook.

**Concurrency / locking model:**

Scala's effect systems give you *asynchronous* safety (fibers, `Ref`, `STM`), but **cross-node money correctness still lives in the database**, not in a JVM `Ref`. An in-memory `Ref[F, Balance]` is lost on restart and invisible to other nodes — never the source of truth for a balance.

- **Optimistic locking (default; low-contention, read-mostly):** a `version` column; the `UPDATE ... WHERE id = ? AND version = ?` affects 0 rows on a lost update — detect `rowsAffected == 0` and **retry** (re-read, re-apply). In Doobie/Slick this is explicit SQL, so the check is yours to write.
- **Pessimistic locking (hot rows / high-contention balances):** `SELECT ... FOR UPDATE` taken up front so concurrent writers serialize. Set a lock timeout; always lock multiple accounts in a **deterministic order** (e.g. ascending id) to avoid deadlock on transfers.
- **JDBC is blocking** — run it on a dedicated blocking pool: cats-effect `Sync[F].blocking {...}` / Doobie's own transactor pool; ZIO `ZIO.attemptBlocking {...}`. Blocking JDBC on the main compute pool starves fibers and tanks throughput.
- Choose a DB isolation level of at least `READ_COMMITTED`; money math must not rely on `READ_UNCOMMITTED`.

**Resource safety (the Scala-specific obligation):** connections, prepared statements, KMS data keys, file handles, and Kafka producers must be released on success, error, **and interruption/cancellation** — otherwise you leak connections under load and fail DORA/operational-resilience expectations. Use the stack's bracket primitive, never a bare `try/finally` around async code:

- **cats-effect:** `Resource[F, A]` (`Resource.make(acquire)(release)`) or `bracket`; finalizers run even on cancellation.
- **ZIO:** `ZIO.acquireRelease` / `ZIO.scoped` with `Scope`; release is guaranteed on success, failure, or interruption. Doobie's `Transactor` and HikariCP pool are themselves `Resource`s.
- **Doobie:** a `ConnectionIO` run with `.transact(xa)` acquires the connection, runs inside a transaction, commits on success and **rolls back on any error**, then returns the connection to the pool — all via `Resource` under the hood. Do not convert to `Future`/`IO` mid-sequence and re-combine; that breaks the single-transaction guarantee.
- **Slick:** compose `DBIOAction`s with `map`/`flatMap`/`DBIO.seq`, apply **`.transactionally`** to the *composed* action, and call `db.run(...)` **once** at the edge. Converting intermediate steps to `Future` and re-sequencing loses atomicity.

## Hashing & encryption

### Hashed one-way (passwords, secrets you only verify)

Scala has no bespoke password framework — use the JVM libraries directly. Preferred: **Argon2id**.

- **OWASP Password Storage Cheat Sheet minimum:** Argon2id with **≥19 MiB memory (m = 19456 KiB), iterations t = 2, parallelism p = 1**. ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html))
- **`argon2-jvm`** (`de.mkammerer:argon2-jvm`) wraps the reference C implementation via JNA and ships native libs for Linux/macOS/Windows — ergonomic but adds a native dependency.
- **BouncyCastle `Argon2BytesGenerator`** (`org.bouncycastle:bcprov-jdk18on`) is a **pure-JVM** RFC 9106 implementation — no native code, easier to ship in a locked-down container. Preferred where reproducible, native-free builds matter.

```scala
import de.mkammerer.argon2.{Argon2Factory, Argon2}

object Passwords {
  private val argon2: Argon2 = Argon2Factory.create(Argon2Factory.Argon2Types.ARGON2id)
  // Meet/exceed OWASP: iterations t=2, memory m=19456 KiB (19 MiB), parallelism p=1
  private val Iterations = 2; private val MemoryKiB = 19456; private val Parallelism = 1

  def hash(raw: Array[Char]): String =
    try argon2.hash(Iterations, MemoryKiB, Parallelism, raw)   // PHC string: $argon2id$v=19$m=19456,t=2,p=1$...
    finally argon2.wipeArray(raw)                              // zero the plaintext

  def verify(phc: String, raw: Array[Char]): Boolean =
    try argon2.verify(phc, raw) finally argon2.wipeArray(raw)
}
```

- Accept the password as **`Array[Char]`**, not `String` — a `String` is immutable and lingers in the heap/string pool; wipe the array after hashing.
- **bcrypt** is the acceptable fallback when Argon2 is unavailable: `org.mindrot:jbcrypt` (`BCrypt.hashpw(pw, BCrypt.gensalt(12))`) or BouncyCastle's `BCrypt`, work factor ≥10 (≥12 preferred). bcrypt silently truncates input at **72 bytes** — pre-hash long/Unicode passwords (SHA-256 → Base64) before bcrypt, or use Argon2.
- **PBKDF2** (JCA `PBKDF2WithHmacSHA256`) only where **FIPS 140** forbids Argon2/bcrypt — then ≥600,000 iterations (OWASP).
- Store an **algorithm/params prefix** (the Argon2 PHC string already carries `m,t,p`) so you can migrate and rehash on login as parameters strengthen.
- **Forbidden:** MD5, SHA-1, plain SHA-256/512 for passwords, any unsalted or reversible scheme (refusal rules 2, 4).

### Encrypted two-way (data you must recover: PAN*, IBAN, national ID)

> *PAN: the right answer is usually **don't store it at all** — tokenize via the processor (network token / gateway `payment_method` id). Store CVV **never** (PCI-DSS). Encrypt PAN only if you are a PCI-scoped entity that genuinely must retain it.

Use **JCA (`javax.crypto`)** with **AES-256-GCM** (authenticated encryption) — identical primitive to Java, wrapped in an effect for safety:

- Transform: **`AES/GCM/NoPadding`**.
- IV: **96-bit (12-byte)** random per encryption from `SecureRandom` — **never reuse an IV with the same key** (catastrophic for GCM).
- Tag: **128-bit** via `new GCMParameterSpec(128, iv)`.
- Prepend the IV to the ciphertext; it is not secret.

```scala
import javax.crypto.Cipher
import javax.crypto.spec.{GCMParameterSpec, SecretKeySpec}
import java.security.SecureRandom
import java.nio.ByteBuffer
import cats.effect.Sync

final class AesGcm[F[_]](implicit F: Sync[F]) {
  private val rng = new SecureRandom()

  /** dataKey = 256-bit plaintext data key from KMS; aad binds context (e.g. accountId). */
  def encrypt(dataKey: Array[Byte], plaintext: Array[Byte], aad: Array[Byte]): F[Array[Byte]] =
    F.delay {
      val iv = new Array[Byte](12); rng.nextBytes(iv)          // unique per message
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dataKey, "AES"), new GCMParameterSpec(128, iv))
      if (aad != null) c.updateAAD(aad)
      val ct = c.doFinal(plaintext)
      ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array()
    }.guarantee(F.delay(java.util.Arrays.fill(dataKey, 0.toByte)))  // zero key even on error/cancel
}
```

**Key management — envelope encryption with a KMS/HSM:**
- Keep the master key in **AWS KMS / Azure Key Vault / GCP KMS / Thales HSM / HashiCorp Vault Transit** — never in the JVM, config, or source.
- Call KMS `GenerateDataKey` for a plaintext **data key** (used in-memory for the AES-GCM call) plus an encrypted data key stored next to the ciphertext. Decrypt the data key via KMS at read time. The AWS Encryption SDK for Java / AWS SDK v2 `KmsClient` (both callable from Scala) implement this pattern; wrap each in a `Resource`/`ZIO.scoped`.
- **Zero the plaintext data key** after use (shown above with `.guarantee`).
- **Rotate** master keys (KMS auto-rotation) and re-wrap data keys on schedule; support decrypting old-key data during rotation. GDPR/KVKK **crypto-shredding**: destroying a record's data key renders its ciphertext unrecoverable — the idiomatic "right to erasure" mechanism.

**Spark note:** do column-level crypto with a KMS-backed UDF, or tokenize upstream — do not ship the master key into executors. For files at rest, use the store's encryption (e.g. Parquet modular encryption + KMS, or bucket SSE-KMS), not home-rolled per-column ciphers.

**Forbidden (FCS-CRYPTO-001):** hardcoded keys/IVs, static or reused IVs, `AES/ECB/*`, `DES`/`3DES`, `"AES"` with no explicit mode (JCE defaults to **ECB** — a trap), home-rolled crypto, `scala.util.Random`/`Math.random()` for keys or IVs (use `SecureRandom`), disabling TLS/cert validation for data in transit (rule 8). TLS 1.2+ for all sensitive transport.

## Country differences (how the same Scala code changes)

Same service, controls toggled by region — keep them as **policy/config per tenant or region** (a `RegionPolicy` given/implicit, a config layer), not `if (country == …)` scattered through business logic:

- **EU — GDPR, PSD2, DORA.** PSD2 **SCA**: two-factor + **dynamic linking** on payments (bind the auth to amount+payee) — add a step-up gate in the transfer workflow. GDPR: lawful basis, data-subject erasure (design PII for deletion/crypto-shredding — drop the data key), data minimization in logs. **DORA** (in force Jan 2025): ICT resilience, incident reporting, tested resilience — your resource safety (no leaks/corruption on failure), audit/log integrity, and retention must satisfy it.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + segregation of duties on financial-reporting paths (enforce maker-checker; lock down who can alter ledger/audit tables). GLBA Safeguards Rule: encryption of customer financial data at rest/in transit and access logging. CCPA/CPRA: consumer data access/delete — same deletion design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (close to GDPR) governs personal-data processing and explicit consent. **BDDK data-localization**: banking data of Turkish customers must be stored/processed **in Turkey** — KMS, DB, backups, and Spark cluster must be in-region; make data residency a deploy-time/config boundary, not hardcoded. **MASAK**: AML/suspicious-transaction reporting — sanctions/AML holds and reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits) — treat as encrypted PII, mask in logs, validate the checksum.
- **UK — FCA, UK GDPR, PRA.** FCA operational-resilience and reporting; UK GDPR mirrors EU GDPR post-Brexit; Strong Customer Authentication still applies under the UK PSRs. Same SCA and PII-deletion machinery as EU, different reporting endpoints/retention.

## Good example

```scala
import cats.effect.IO
import cats.syntax.all._
import doobie._
import doobie.implicits._
import org.typelevel.log4cats.Logger

final case class TransferCommand(
  sourceId: Long, destId: Long, amountMinor: Long, currency: String, idempotencyKey: String, actor: String)

final class TransferService(xa: Transactor[IO])(implicit log: Logger[IO]) {

  def transfer(cmd: TransferCommand): IO[Either[String, String]] = {
    // 2. Validate: amount in minor units (Long), never Double
    if (cmd.amountMinor <= 0) return IO.pure(Left("invalid amount"))

    // Whole unit is ONE ConnectionIO -> ONE transaction: commit all or roll back all.
    val tx: ConnectionIO[Either[String, String]] = for {
      // 3. Idempotency: a stored key short-circuits a retry (no double-spend)
      seen <- sql"select result from ledger where idem_key = ${cmd.idempotencyKey}"
                .query[String].option
      out  <- seen match {
        case Some(prev) => prev.asRight[String].pure[ConnectionIO]
        case None =>
          // locking order: lock lower id first, deterministically, to avoid deadlock
          val (lo, hi) = (cmd.sourceId min cmd.destId, cmd.sourceId max cmd.destId)
          for {
            _    <- sql"select id from account where id = $lo for update".query[Long].unique
            _    <- sql"select id from account where id = $hi for update".query[Long].unique
            bal  <- sql"""select balance_minor from account
                          where id = ${cmd.sourceId} and currency = ${cmd.currency}"""
                      .query[Long].unique
            res  <- if (bal < cmd.amountMinor) "insufficient funds".asLeft[String].pure[ConnectionIO]
                    else for {
                      _ <- sql"""update account set balance_minor = balance_minor - ${cmd.amountMinor}
                                  where id = ${cmd.sourceId}""".update.run
                      _ <- sql"""update account set balance_minor = balance_minor + ${cmd.amountMinor}
                                  where id = ${cmd.destId}""".update.run
                      // 5+6. Ledger + audit written in the SAME transaction (idem_key is UNIQUE)
                      _ <- sql"""insert into ledger (idem_key, source_id, dest_id, amount_minor, currency, actor, at_utc, result)
                                  values (${cmd.idempotencyKey}, ${cmd.sourceId}, ${cmd.destId},
                                          ${cmd.amountMinor}, ${cmd.currency}, ${cmd.actor}, now(), 'ok')""".update.run
                    } yield "ok".asRight[String]
          } yield res
      }
    } yield out

    // .transact commits on success, ROLLS BACK on any error, returns the pooled connection.
    tx.transact(xa)
      .flatTap(r => log.info(s"transfer actor=${cmd.actor} amount=${cmd.amountMinor} ${cmd.currency} -> $r"))
      // CVV/PAN never touched here; passwords hashed elsewhere with Argon2id.
  }
}
```

```scala
// Password storage done right (Argon2id ≥ OWASP), using Passwords from the Hashing section.
val phc: String   = Passwords.hash(rawPassword.toCharArray)   // $argon2id$v=19$m=19456,t=2,p=1$...
val ok:  Boolean  = Passwords.verify(storedPhc, attempt.toCharArray)
```

## Bad example

```scala
// ❌ Every line crosses a red line — refuse to write this.
def pay(pan: String, cvv: String, amount: Double): String = {   // Double money — core rule

  log.info(s"charging card $pan cvv $cvv amount $amount")        // logs PAN + CVV — rules 1, 3

  user.password = password                                       // plaintext password — rule 2
  user.passwordMd5 = MessageDigest.getInstance("MD5")            // broken hash — rules 2, 4
    .digest(password.getBytes).map("%02x".format(_)).mkString

  val c = Cipher.getInstance("AES")                              // defaults to AES/ECB — rule 4
  val k = new SecretKeySpec("hardcoded-secret".getBytes, "AES")  // hardcoded key — rules 4, 7

  val src = Await.result(db.run(accountQuery(from)), 2.seconds)  // no lock, blocking await
  db.run(accountQuery(from).map(_.balance -= amount))            // two separate db.run calls:
  db.run(accountQuery(to).map(_.balance += amount))              // NOT one transaction — lost
  "ok"                                                           // update, no idempotency, no audit — rule 6
}
```

Red lines crossed: storing/logging PAN & CVV (PCI-DSS, rules 1, 3), plaintext & MD5 passwords (rule 2/4), AES-ECB + hardcoded key (rule 4, 7), floating-point money (core), two separate `db.run` calls instead of one `.transactionally` unit so the debit/credit are not atomic (lost update), and no audit record on money movement (rule 6). The compliant alternatives are the *Good example* above and tokenization of the card via the processor. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md).
