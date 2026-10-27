---
name: "rust"
description: "Write Rust for high-assurance financial services that are memory-safe, auditable, and correct-by-construction."
triggers: "rust, write code, implement, coding"
---

# Skill: Rust for Regulated Fintech

**Write Rust for high-assurance financial services that are memory-safe, auditable, and correct-by-construction.** Load this skill whenever the task is in Rust and touches money movement, card data, PII, authentication, onboarding/KYC, or any service that must satisfy PCI-DSS v4.0.1, GDPR/PSD2/DORA, SOX/GLBA, FCA, or KVKK/BDDK/MASAK. Always also load [`refusal/refusal-policy.md`](../refusal-policy/SKILL.md) and [`core/secure-fintech-coding.md`](../secure-fintech-coding/SKILL.md).

## When to use

- A Rust service handles payments, transfers, ledgers, balances, or refunds.
- A Rust service stores/processes PAN, CVV, IBAN, national IDs, passwords, API keys, or tokens.
- You are choosing a password hash, an encryption primitive, a logging/redaction stack, a DB transaction strategy, or a money type, and the result must be defensible to an auditor.
- You are reviewing existing Rust for compliance red lines (plaintext secrets, broken crypto, `f64` money, nonce reuse, missing audit trail, unlogged money movement, `SELECT`-then-`UPDATE` race on balances).

Rust's strengths for this domain: no data races on safe code (the borrow checker makes a race on a shared balance a compile error, not a 2 a.m. incident), no null/use-after-free, exhaustive `match` so you cannot silently forget a transaction state, the `?`-operator forcing you to handle fallible crypto/DB calls, and a mature audited crypto ecosystem (RustCrypto, *ring*). Its sharp edges for fintech: integer overflow **wraps silently in `--release`** (money bugs), `f64` arithmetic rounds wrong, `.unwrap()`/`panic!` in a payment path takes the service down, and crypto misuse (nonce reuse, non-constant-time compare) compiles fine. This skill pins the safe path for each.

## Logging — what goes where

High-assurance services log heavily; redaction must be a **security boundary, not a formatting afterthought**. In Rust, use the [`tracing`](https://docs.rs/tracing) crate with `tracing-subscriber`'s JSON formatter, and enforce an **allow-list** at the type level — never derive `Debug`/`Display` on a type that holds a secret and then log it.

**Library.** `tracing` + `tracing-subscriber` (`fmt().json()`) is the default structured-logging stack. Spans (`#[tracing::instrument]`) carry request-scoped context (request id, actor, idempotency key) so every event inside a payment flow is correlated. Use `tracing-appender` for non-blocking file sinks and ship to the aggregator with an OpenTelemetry layer (`tracing-opentelemetry`) where needed.

**Levels and sinks.**

| Event | Level | Sink |
|---|---|---|
| Payment authorized / captured / refunded, transfer posted | `info` + a separate **audit** record (see Workflow) | app log **and** append-only audit store |
| Auth success/failure, password change, role change, consent change | `info`/`warn` | app log + audit store |
| Sanctions/AML hit, fraud decline, idempotency replay | `warn` | app log + audit store + alerting |
| Validation errors, retriable DB/network errors | `warn` | app log |
| Panics, failed crypto, KMS unavailable, ledger invariant broken | `error` | app log + on-call alert |
| Raw request/response bodies on payment endpoints | **never** | — |

**What is MASKED before it reaches any sink.** PAN (show at most first-6/last-4, e.g. `411111******1111`), CVV/CVC (never — not even masked), passwords, password hashes, API keys/secrets, bearer/refresh tokens, full national IDs (KVKK/GDPR), private keys, full IBAN (mask to last 4), session cookies, OTP codes, encryption keys.

**What is NEVER logged, at any level.** CVV/CVC/CVV2, full track/magstripe data, PIN or PIN blocks, the raw request body of a card-entry endpoint, plaintext passwords, the AES data key or KMS plaintext key, and the full PAN. These are refusal-policy red lines (rules 1, 3, 4).

**Redaction mechanism — the type system is the allow-list.** A regex deny-list over free text fails the moment data is JSON-escaped, wrapped in an error, or a field is renamed. In Rust, make the compiler enforce redaction:

1. Wrap secrets in a newtype whose `Debug`/`Display` prints a fixed mask, so a secret can **never** be formatted even by accident (`{:?}` on an error that contains it, a `tracing::field` capture, a `format!`). The [`secrecy`](https://docs.rs/secrecy) crate (`SecretString`, `SecretBox`) does exactly this and zeroizes on drop.
2. Emit an explicit allow-list of safe fields when you log an entity — never `?entity` (the `Debug` capture) on a type with sensitive fields.

```rust
use secrecy::{SecretString, ExposeSecret};
use tracing::info;

struct Customer {
    id: String,
    email: String,       // PII — masked
    national_id: SecretString, // KVKK/GDPR — never emitted
    pan: String,         // PCI — masked
}

impl Customer {
    // Allow-list: anything not named here never reaches a sink, even if a
    // future field is added to the struct.
    fn log(&self) {
        info!(
            customer_id = %self.id,
            email = %mask_email(&self.email),
            pan = %mask_pan(&self.pan),
            // national_id intentionally omitted — never logged.
        );
    }
}

fn mask_pan(pan: &str) -> String {
    if pan.len() < 10 { return "****".into(); }
    format!("{}{}{}", &pan[..6], "*".repeat(pan.len() - 10), &pan[pan.len() - 4..])
}
```

Add a `tracing_subscriber::Layer` as a second line of defence that drops any field whose name matches a sensitive-name set (`password`, `cvv`, `pan`, `secret`, `token`, `authorization`). Because `SecretString`'s `Debug` prints `[REDACTED]`, even `error!(?err)` on an error that captured a secret cannot leak it — the mask is structural, not a string filter.

**Log integrity.** Application logs are **not** the audit trail. The audit record (below) goes to an **append-only / WORM** store — an append-only table with no `UPDATE`/`DELETE` grant, object-lock (S3 Object Lock / WORM) archival, or a hash-chained log where each record carries `prev_hash = SHA-256(prev_record)` so tampering is detectable. SOX and DORA expect demonstrable integrity; a mutable log file does not satisfy them.

## Workflow — payment / transfer / onboarding

Canonical money-movement order, each step mapped to the Rust mechanism that enforces it:

1. **Authenticate + authorize** the caller. Check least-privilege role/scope before anything else (refusal rule 10). Carry identity + request-scoped values through the call graph in an explicit `Context` struct or a `tracing` span field — never a global `static mut`.
2. **Validate** amount (minor units / `Decimal`, see Hashing/Money), currency, accounts. Model states as an `enum` so an invalid transition fails to compile; reject at the edge.
3. **Idempotency gate.** Require an idempotency key on every mutating payment endpoint. Look it up first; if seen, return the stored result without re-executing. This is the single most important defence against double-charges on retries/timeouts.
4. **AML / sanctions / KYC** screening on onboarding and on transfers where required. A hit is a `warn` + audit + hold, never a silent pass (refusal rule 5).
5. **Open a DB transaction** (`pool.begin().await?` with `sqlx`); do the balance read, the invariant check, the debit/credit, **and the audit insert** inside the *same* transaction so they commit or roll back atomically. If you never call `.commit()`, `sqlx` **rolls back on drop** — the safe default.
6. **Approval gate** for flows above threshold (dual control / maker-checker): write a pending record, require a second authorized principal to approve before the transfer posts.
7. **Write the audit record** (actor, action, source/dest, amount, idempotency key, decision, timestamp, request id) to the append-only store *within* the transaction.
8. **Commit**, then emit the `info` log and any downstream event.

```rust
use sqlx::{PgPool, Postgres, Transaction};

async fn transfer(pool: &PgPool, cmd: &TransferCmd) -> Result<TransferResult, AppError> {
    // 1. authorize
    if !cmd.actor.can("payments.transfer") {
        return Err(AppError::Forbidden);
    }
    // 3. idempotency — return prior result on replay
    if let Some(prev) = find_applied(pool, &cmd.idempotency_key).await? {
        tracing::info!(idem = %cmd.idempotency_key, "transfer replay");
        return Ok(prev);
    }

    // 5. transaction — rolls back automatically if we return early / drop
    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;

    // pessimistic lock on both rows, ordered by id to avoid deadlock
    let (first, second) = order_ids(cmd.from, cmd.to);
    lock_account(&mut tx, first).await?;
    lock_account(&mut tx, second).await?;

    // debit/credit — Decimal math, checked, inside the tx
    debit_credit(&mut tx, cmd).await?; // errors (insufficient funds) -> early return -> rollback

    // 7. audit INSIDE the same tx — atomic with the money movement
    write_audit(&mut tx, "transfer", cmd).await?;

    // 8. commit, then log
    tx.commit().await?;
    tracing::info!(
        idem = %cmd.idempotency_key,
        amount_minor = cmd.amount_minor,
        currency = %cmd.currency,
        "transfer posted"
    );
    Ok(TransferResult::Posted)
}
```

**`sqlx` specifics.** Use **compile-time-checked** queries (`sqlx::query!` / `query_as!`) so a schema/type mismatch is a build error, and **always bind parameters** (`$1`, `.bind(..)`) — never `format!` SQL (injection is a refusal-adjacent red line). Bound the pool with `PgPoolOptions::max_connections` / `acquire_timeout` so a burst cannot exhaust connections and stall the ledger. Pass a cancellation-aware future (the request's own future) so a client disconnect drops the query and releases locks. A transaction `Transaction<'_, Postgres>` holds a `&mut` to its connection, so the borrow checker prevents you from accidentally issuing concurrent statements on the same transaction.

**Concurrency / locking model.**
- **Database-level** (authoritative for money): prefer **pessimistic** locking for balance mutation — `SELECT ... FOR UPDATE` inside a transaction, acquiring rows in a deterministic order to avoid deadlock, at `SERIALIZABLE` or `REPEATABLE READ` isolation (set per-transaction). Use **optimistic** concurrency (a `version` column, `UPDATE ... WHERE version = $n`) for low-contention read-mostly rows (profile edits); on a lost update, retry.
- **Process-level** Rust/async concurrency: the compiler forbids data races on shared state, but *logical* races (read-modify-write across an `.await`) are still possible — never hold an in-memory balance as the source of truth. For shared in-memory state use `tokio::sync::Mutex`/`RwLock` (async-aware) or `std::sync` for non-async sections, `Arc<T>` to share, and atomics for counters. **Never guard a monetary balance with an in-memory mutex as the authority** — the database transaction is the authority; a process lock does not survive a crash or coordinate across replicas.
- **Overflow is a money bug.** Integer arithmetic **wraps silently in release builds**. For any monetary integer use `checked_add`/`checked_sub` (or `Decimal`, which is checked) and treat overflow as an error, never a wrap. Enable `overflow-checks = true` in the release profile for defence in depth.

## Hashing & encryption

**Money math first:** never use `f32`/`f64` for money — binary floats cannot represent `0.10` exactly and round wrong in a ledger. Represent money as **integer minor units** (`i64`/`i128` cents) **or** a fixed-point decimal via [`rust_decimal`](https://docs.rs/rust_decimal) (`Decimal`, 96-bit mantissa, up to 28 significant digits, base-10 — no binary rounding). Pair it with a currency to make a typed `Money` so you cannot add USD to EUR:

```rust
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

#[derive(Clone, Copy)]
struct Money { amount: Decimal, currency: Currency }

impl Money {
    fn add(self, other: Money) -> Result<Money, MoneyError> {
        if self.currency != other.currency { return Err(MoneyError::CurrencyMismatch); }
        // checked_add returns None on overflow — never silently wrap money
        let amount = self.amount.checked_add(other.amount).ok_or(MoneyError::Overflow)?;
        Ok(Money { amount, currency: self.currency })
    }
}

let price = Money { amount: dec!(19.99), currency: Currency::USD };
```

Round explicitly with a stated rounding strategy (`Decimal::round_dp_with_strategy`, e.g. banker's rounding) at the point money is materialized, and store the scale. For DB persistence use `NUMERIC`/`DECIMAL` columns (not `float8`); `sqlx` maps `rust_decimal::Decimal` to `NUMERIC` with the `rust_decimal` feature.

**Hashed one-way — passwords.** Use **Argon2id** via the RustCrypto [`argon2`](https://docs.rs/argon2) crate. `Argon2::default()` is **Argon2id** and tracks the latest OWASP-recommended parameters; for an explicit, auditable config build `Params` yourself.

- **OWASP Password Storage Cheat Sheet minimum: 19 MiB memory, iterations (time cost) = 2, parallelism = 1.** ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)) For server-side fintech with headroom, a tuned floor of **m = 64 MiB (`m_cost = 65536` KiB), `t_cost = 3`, `p_cost = 4`, output = 32 bytes**, salt = 16 random bytes from the OS CSPRNG (`OsRng`). Benchmark on your hardware so a single hash stays roughly in the 0.25–0.5 s band without starving the async runtime under peak concurrency, and raise `m_cost` over time.
- The `PasswordHasher` API emits a canonical **PHC string** (`$argon2id$v=19$m=65536,t=3,p=4$<b64salt>$<b64hash>`) — store that one string; it carries the algorithm, params, and salt, so you can re-verify and detect when parameters need upgrading on next login.
- **Run the hash off the async reactor:** Argon2 is CPU-bound and blocks. Wrap it in `tokio::task::spawn_blocking` so one login cannot stall the executor.
- Verification uses `Argon2::verify_password` / `PasswordHash::new` + `verify_password`, which compares in **constant time** internally — never compare hash strings with `==`.

```rust
use argon2::{Argon2, Params, Algorithm, Version, PasswordHasher, PasswordVerifier, PasswordHash};
use argon2::password_hash::{SaltString, rand_core::OsRng};

fn hash_password(pw: &[u8]) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng); // 16+ bytes, OS CSPRNG
    let params = Params::new(64 * 1024 /* KiB */, 3 /* t */, 4 /* p */, Some(32))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    Ok(argon2.hash_password(pw, &salt)?.to_string()) // PHC string, persist this
}

fn verify_password(pw: &[u8], phc: &str) -> Result<bool, argon2::password_hash::Error> {
    let parsed = PasswordHash::new(phc)?; // params + salt come FROM the stored string
    Ok(Argon2::default().verify_password(pw, &parsed).is_ok()) // constant-time
}
```

**bcrypt fallback.** The [`bcrypt`](https://docs.rs/bcrypt) crate with `cost >= 12` is acceptable where Argon2 is unavailable, but bcrypt silently truncates input at **72 bytes** — prefer Argon2id. **Never MD5 or SHA-1** for passwords or integrity (refusal rule 4).

**Encrypted two-way — PAN / IBAN / national ID.** Use **AES-256-GCM** (authenticated encryption: confidentiality + tamper detection). Two audited options:

- RustCrypto [`aes-gcm`](https://docs.rs/aes-gcm) — `Aes256Gcm` (pure Rust, portable, constant-time). 32-byte key, 12-byte nonce, 16-byte tag.
- [`ring`](https://docs.rs/ring) — `aead::AES_256_GCM` via `LessSafeKey`/`SealingKey` (BoringSSL-derived, assembly-optimized). Equally valid; pick `ring` where you already depend on it or want its performance, `aes-gcm` for pure-Rust/`no_std` portability. **Do not roll your own around a bare block cipher.**

Rules for either:
- **Key:** 32 bytes (AES-256), a **data key** issued by a KMS under envelope encryption — call KMS `GenerateDataKey`, use the plaintext data key in memory only, store the KMS-wrapped data key alongside the ciphertext, and zeroize the plaintext key after use (`zeroize` crate / `Zeroizing`). Never a static/hardcoded key (refusal rules 4, 7).
- **Nonce:** 12 bytes, **fresh from a CSPRNG (`OsRng`) for every encryption**, stored with the ciphertext. **Reusing a nonce with the same key is catastrophic for GCM** — it leaks the XOR of plaintexts and can expose the authentication key. For very high message volumes per key, use a key-committing / nonce-extended construction (e.g. `XAES-256-GCM`) or rotate keys before the random-nonce birthday bound.
- Bind context with GCM's additional authenticated data (AAD), e.g. the record id, so a ciphertext cannot be relocated to another row.

```rust
use aes_gcm::{Aes256Gcm, Key, Nonce, aead::{Aead, AeadCore, KeyInit, OsRng, Payload}};

fn encrypt(data_key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, aes_gcm::Error> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(data_key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 random bytes, unique per message
    let mut out = cipher.encrypt(&nonce, Payload { msg: plaintext, aad })?; // ciphertext + 16-byte tag
    // prepend the nonce so decrypt can recover it
    let mut blob = nonce.to_vec();
    blob.append(&mut out);
    Ok(blob)
}
```

**Key management & rotation.** Keys live in a KMS/HSM (AWS KMS, GCP KMS, Azure Key Vault, or a PKCS#11 HSM), never in source, `.env` committed to git, or repo config. Use envelope encryption (KMS-wrapped data keys). Rotate the KMS master key on schedule; store a key id/version with each ciphertext so old data stays decryptable through rotation. Transport is TLS 1.2+ with certificate validation on (`rustls` verifies by default) — never a custom `ServerCertVerifier` that accepts everything, and never `danger_accept_invalid_certs(true)` on `reqwest` in production (refusal rule 8).

**Forbidden (refusal red lines):** MD5/SHA-1 for passwords or integrity, DES/3DES, AES-**ECB** mode, home-rolled crypto, static or hardcoded keys/IVs, nonce/IV reuse, reversible encryption of passwords, the `rand` crate's `thread_rng` for key/nonce material (use an OS CSPRNG / `OsRng`), non-constant-time comparison of secrets (use `subtle::ConstantTimeEq`), `f64` money, and silent integer-overflow on balances.

## Country differences (how the same code changes)

The Rust primitives stay the same; configuration, data residency, and extra gates change per region. Express these as policy/config resolved in one place (a `RegionPolicy` injected via the request `Context`) — not `if country == "TR"` scattered through handlers — so residency, SCA thresholds, and retention windows are set in one auditable place.

- **EU — GDPR, PSD2 SCA, DORA.** Data-subject rights mean PII (encrypted with the AES-256-GCM path) must be erasable/exportable — key design so deleting the data key **crypto-shreds** the record (`zeroize` the key, drop the KMS wrap). PSD2 **Strong Customer Authentication**: add a second-factor/step-up gate in the Workflow before high-value or new-payee transfers, and record the SCA evidence in the audit trail. DORA raises the bar on log integrity, incident reporting, and tested resilience — the WORM audit store plus Rust's panic-free payment paths (no `unwrap`, graceful error returns) feed this. Keep EU personal data in-region.
- **US — SOX, GLBA, CCPA.** SOX: immutable, access-controlled audit trail on anything touching financial reporting (the append-only store, with change management on the Rust service). GLBA Safeguards Rule: the encryption + access-control + logging controls here are the technical safeguards. CCPA/CPRA: honour do-not-sell/delete; same crypto-shred design as GDPR.
- **UK — FCA, UK GDPR.** FCA operational-resilience and Consumer Duty expectations map to the same audit, SCA, and resilience controls as the EU (post-Brexit SCA still applies under the UK PSRs). UK GDPR mirrors GDPR for PII handling and residency.
- **Turkey — KVKK, BDDK, MASAK.** **KVKK**: the national ID (TC Kimlik No) is sensitive PII — wrap it in `SecretString`, never log it, encrypt at rest, record consent. **BDDK localization**: regulated financial data of Turkish customers must be stored **in Turkey** — pin the DB and KMS region, do not ship PII to an offshore log sink. **MASAK**: AML reporting obligations — the AML/sanctions step and its audit record are mandatory and must be retrievable for the regulator.

## Good example

```rust
// ✅ Good — tokenize, never hold raw PAN/CVV; idempotent, audited, Decimal money, panic-free.
async fn charge(pool: &PgPool, cmd: &ChargeCmd) -> Result<Receipt, AppError> {
    if !cmd.actor.can("payments.charge") {          // least privilege (rule 10)
        return Err(AppError::Forbidden);
    }
    if let Some(prev) = find_applied(pool, &cmd.idem_key).await? { // idempotency
        return Ok(prev);
    }
    // PAN/CVV go straight to the gateway and come back as a token; we store only the token.
    let tok = gateway.tokenize(&cmd.card_nonce).await?;

    let mut tx = pool.begin().await?;               // rolls back on drop if we return early
    sqlx::query!(
        "INSERT INTO payment_methods (user_id, token, masked_pan) VALUES ($1, $2, $3)",
        cmd.user_id, tok.token, tok.masked_pan      // parameterized — no injection
    )
    .execute(&mut *tx)
    .await?;
    write_audit(&mut tx, "charge", cmd.user_id, cmd.amount_minor, &cmd.idem_key).await?;
    tx.commit().await?;

    tracing::info!(
        user = %cmd.user_id,
        amount_minor = cmd.amount_minor,
        pan = %tok.masked_pan,                      // masked only
        "charge ok"
    );
    Ok(Receipt { token: tok.token })
}
```

## Bad example

```rust
// ❌ Bad — multiple red lines; an agent must REFUSE to write this.
async fn charge(pool: &PgPool, pan: &str, cvv: &str, amount: f64) {   // f64 money — rounding errors
    let sql = format!("INSERT INTO cards(pan,cvv) VALUES('{pan}','{cvv}')"); // stores PAN+CVV (rule 1) + SQL injection
    sqlx::query(&sql).execute(pool).await.unwrap();                   // .unwrap() in a payment path → panic DoS
    tracing::info!("charging card {pan} cvv {cvv}");                  // logs PAN + CVV (rule 3)
    let key = b"1234567890123456";                                   // hardcoded 16-byte key (rule 7)
    let digest = md5::compute(password);                             // MD5 password hash (rules 2, 4)
    let _ = (key, digest);
}
```

**Why refuse:** this crosses refusal-policy rules 1 (store PAN/CVV), 2 (broken password hash), 3 (log PAN/CVV), 4 (broken crypto, hardcoded key, MD5), and 7 (hardcoded credential), plus SQL injection, `f64` money, and a panic-prone payment path. The compliant rewrite is the Good example: tokenize at the gateway, store only the token + masked PAN, Argon2id for passwords, AES-256-GCM (`aes-gcm` or `ring`) with a KMS data key and a random per-message nonce, compile-checked parameterized `sqlx`, `rust_decimal`/integer minor units, no `unwrap` in the hot path, and an atomic audit insert.

---

**References:** [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) (Argon2id 19 MiB / t=2 / p=1 minimum); [RustCrypto `argon2`](https://docs.rs/argon2) (`Argon2::default()` = Argon2id tracking OWASP params, PHC output via `PasswordHasher`); [`bcrypt`](https://docs.rs/bcrypt); [`aes-gcm`](https://docs.rs/aes-gcm) (`Aes256Gcm`, 12-byte nonce, 16-byte tag) and [`ring`](https://docs.rs/ring) (`aead::AES_256_GCM`) per NIST SP 800-38D; [`rust_decimal`](https://docs.rs/rust_decimal) for money; [`sqlx`](https://docs.rs/sqlx) compile-checked queries + `begin()`/`commit()` transactions; [`tracing`](https://docs.rs/tracing) + [`secrecy`](https://docs.rs/secrecy)/[`zeroize`](https://docs.rs/zeroize) for redaction; [`subtle`](https://docs.rs/subtle) for constant-time compare; RFC 9106 (Argon2); PCI-DSS v4.0.1; GDPR/PSD2/DORA, SOX/GLBA/CCPA, FCA/UK GDPR, KVKK/BDDK/MASAK. See [`refusal/refusal-policy.md`](../refusal-policy/SKILL.md) for the full red lines.


<!-- fcs-managed-hash:da283a1aa4c28afb -->
