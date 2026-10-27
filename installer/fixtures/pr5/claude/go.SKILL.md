---
name: go
description: Write Go for payment infrastructure that is secure, auditable, and high-throughput by default.
triggers: go, write code, implement, coding
---

# Skill: Go for Regulated Fintech

**Write Go for payment infrastructure that is secure, auditable, and high-throughput by default.** Load this skill whenever the task is in Go and touches money movement, card data, PII, authentication, onboarding/KYC, or any service that must satisfy PCI-DSS v4.0.1, GDPR/PSD2/DORA, SOX/GLBA, FCA, or KVKK/BDDK/MASAK. Always also load [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md).

## When to use

- A Go service handles payments, transfers, ledgers, balances, or refunds.
- A Go service stores/processes PAN, CVV, IBAN, national IDs, passwords, API keys, or tokens.
- You are choosing a password hash, an encryption primitive, a logging library, a DB transaction strategy, or a concurrency primitive and the result must be defensible to an auditor.
- You are reviewing existing Go for compliance red lines (plaintext secrets, broken crypto, missing audit trail, unlogged money movement, data races on balances).

Go's strengths for this domain: static binaries, a strong standard library crypto surface (`crypto/aes`, `crypto/cipher`, `crypto/rand`, `crypto/subtle`), first-class `context.Context` cancellation/deadlines, `database/sql` with explicit transactions, and `log/slog` (Go 1.21+) for structured logging. Its sharp edges: silent integer/float money bugs, data races under high concurrency, and easy-to-misuse crypto (nonce reuse, non-constant-time comparison). This skill pins the safe path for each.

## Logging — what goes where

High-throughput payment infrastructure logs a lot; redaction must be a **security boundary, not a formatting afterthought**. In Go, use the standard library `log/slog` (or `go.uber.org/zap` where you need its performance/sampling) with a JSON handler, and enforce an **allow-list** at the type level via `slog.LogValuer`.

**Library.** `log/slog` with `slog.NewJSONHandler` is the default. Reach for `zap` (`zap.NewProduction` + `zapcore`) only when you need sampling under extreme load or zero-allocation hot paths; the redaction rules below apply identically — implement `zapcore.ObjectMarshaler` instead of `slog.LogValuer`.

**Levels and sinks.**

| Event | Level | Sink |
|---|---|---|
| Payment authorized / captured / refunded, transfer posted | `Info` + a separate **audit** record (see Workflow) | app log **and** append-only audit store |
| Auth success/failure, password change, role change, consent change | `Info`/`Warn` | app log + audit store |
| Sanctions/AML hit, fraud decline, idempotency replay | `Warn` | app log + audit store + alerting |
| Validation errors, retriable DB/network errors | `Warn` | app log |
| Panics, failed crypto, KMS unavailable, ledger invariant broken | `Error` | app log + on-call alert |
| Raw request/response bodies on payment endpoints | **never** | — |

**What is MASKED before it reaches any sink.** PAN (show at most first-6/last-4, e.g. `411111******1111`), CVV/CVC (never — not even masked), passwords, password hashes, API keys/secrets, bearer/refresh tokens, full national IDs (KVKK/GDPR), private keys, full IBAN (mask to last 4), session cookies, OTP codes, encryption keys.

**What is NEVER logged, at any level.** CVV/CVC/CVV2, full track/magstripe data, PIN or PIN blocks, the raw request body of a card-entry endpoint, plaintext passwords, the AES data key or KMS plaintext key, and the full PAN. These are refusal-policy red lines (rules 1, 3, 4).

**Redaction mechanism — allow-list, not deny-list.** A regex deny-list over free text fails the moment data is JSON-escaped, wrapped in an error, or renamed. Attach `LogValuer` to every type that can hold a secret and emit only the fields that are safe:

```go
type Customer struct {
	ID        string
	Email     string // PII — masked
	NationalID string // KVKK/GDPR — never emitted
	PAN       string // PCI — masked
}

// LogValue is the allow-list: anything not listed here never reaches a sink,
// even if a future field is added to the struct.
func (c Customer) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("customer_id", c.ID),
		slog.String("email", maskEmail(c.Email)),
		slog.String("pan", maskPAN(c.PAN)),
		// NationalID intentionally omitted — never logged.
	)
}

func maskPAN(pan string) string {
	if len(pan) < 10 {
		return "****"
	}
	return pan[:6] + strings.Repeat("*", len(pan)-10) + pan[len(pan)-4:]
}
```

Because `slog` calls `LogValue()` automatically, `slog.Info("charge", "customer", cust)` can never leak an unlisted field — a new PII column is silent until someone explicitly opts it in. Register a top-level `ReplaceAttr` on the handler as a second line of defence that drops any attribute whose key matches a sensitive-name set (`password`, `cvv`, `pan`, `secret`, `token`, `authorization`).

**Log integrity.** Application logs are not the audit trail. The audit record (below) goes to an **append-only / WORM** store — an append-only table with no `UPDATE`/`DELETE` grant, object-lock (S3 Object Lock / WORM) archival, or a hash-chained log where each record carries `prev_hash = SHA-256(prev_record)` so tampering is detectable. SOX and DORA expect demonstrable integrity; a mutable log file does not satisfy them.

## Workflow — payment / transfer / onboarding

Canonical money-movement order, each step mapped to the Go mechanism that enforces it:

1. **Authenticate + authorize** the caller. Check least-privilege role/scope before anything else (refusal rule 10). Carry identity + request-scoped values in `context.Context` (via a typed key), never in globals.
2. **Validate** amount (minor units, see Hashing/Money note), currency, accounts. Reject at the edge.
3. **Idempotency gate.** Require an idempotency key on every mutating payment endpoint. Look it up first; if seen, return the stored result without re-executing. This is the single most important defence against double-charges on retries/timeouts in a high-throughput system.
4. **AML / sanctions / KYC** screening on onboarding and on transfers where required. A hit is a `Warn` + audit + hold, never a silent pass (refusal rule 5).
5. **Open a DB transaction** with `BeginTx(ctx, ...)`; do the balance read, the invariant check, the debit/credit, **and the audit insert** inside the *same* transaction so they commit or roll back atomically.
6. **Approval gate** for flows above threshold (dual control / maker-checker): write a pending record, require a second authorized principal to approve before the transfer posts.
7. **Write the audit record** (actor, action, source/dest, amount, idempotency key, decision, timestamp, request id) to the append-only store *within* the transaction.
8. **Commit**, then emit the `Info` log and any downstream event.

```go
func (s *Service) Transfer(ctx context.Context, cmd TransferCmd) (Result, error) {
	// 3. idempotency — return prior result on replay
	if r, ok, err := s.ledger.Applied(ctx, cmd.IdempotencyKey); err != nil {
		return Result{}, err
	} else if ok {
		slog.InfoContext(ctx, "transfer replay", "idem", cmd.IdempotencyKey)
		return r, nil
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback() // no-op after a successful Commit

	// 5. pessimistic lock on the two rows, ordered by id to avoid deadlock
	from, to := order(cmd.From, cmd.To)
	if err := lockAccounts(ctx, tx, from, to); err != nil {
		return Result{}, err
	}
	if err := debitCredit(ctx, tx, cmd); err != nil {
		return Result{}, err // insufficient funds etc. — rolls back
	}
	// 7. audit inside the same tx — atomic with the money movement
	if err := writeAudit(ctx, tx, "transfer", cmd); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(); err != nil {
		return Result{}, err
	}
	slog.InfoContext(ctx, "transfer posted",
		"idem", cmd.IdempotencyKey, "amount_minor", cmd.AmountMinor, "currency", cmd.Currency)
	return Result{Posted: true}, nil
}
```

**`database/sql` + `context`.** Always pass `ctx` (`QueryContext`, `ExecContext`, `BeginTx`) so a cancelled/timed-out request releases its DB work and does not hold locks. Set `db.SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime` to bound the pool under load. Treat `database/sql` NULLs with `sql.Null*` types, and **always use parameterized queries** (`$1`/`?`) — never string-concatenate SQL (injection is a refusal-adjacent red line).

**Concurrency / locking model.**
- **Database-level** (authoritative for money): prefer **pessimistic** locking for balance mutation — `SELECT ... FOR UPDATE` inside a transaction, acquiring rows in a deterministic order to avoid deadlock, under `LevelSerializable` or `LevelRepeatableRead`. Use **optimistic** (a `version` column, `UPDATE ... WHERE version = ?`) for low-contention read-mostly rows (e.g. profile edits).
- **Process-level** Go concurrency: protect shared in-memory state with `sync.Mutex`/`sync.RWMutex`; use `sync/atomic` for counters; `sync.Once` for one-time init (KMS client, config); `errgroup.Group` for bounded parallel fan-out with shared cancellation. **Never guard a monetary balance with an in-memory mutex as the source of truth** — the database transaction is the authority; a process lock does not survive a crash or coordinate across replicas. Run `go test -race` in CI and treat any data race on financial state as release-blocking.

## Hashing & encryption

**Money math first:** represent money in **integer minor units** (`int64` cents) or a decimal type (`github.com/shopspring/decimal`). Never use `float64` for money — binary floats round wrong. This is not optional in a ledger.

**Hashed one-way — passwords.** Use **Argon2id** via `golang.org/x/crypto/argon2` (`argon2.IDKey`). Signature: `argon2.IDKey(password, salt, time, memory, threads, keyLen)` where `memory` is in **KiB**.

- OWASP Password Storage Cheat Sheet minimum: **19 MiB memory, time=2, parallelism=1**. For server-side fintech with headroom, a tuned floor of **memory=64*1024 KiB (64 MiB), time=3, threads=4, keyLen=32**, salt = 16 random bytes from `crypto/rand`. Benchmark on your hardware so a single hash stays roughly in the 0.25–0.5 s band without starving the pool under peak concurrency, and tune memory up over time.
- `IDKey` returns **raw bytes** — you must persist the parameters and salt yourself, canonically as a PHC string: `$argon2id$v=19$m=65536,t=3,p=4$<b64salt>$<b64hash>`. Store that one string; it lets you re-verify and detect when parameters need upgrading on next login.
- Compare the recomputed hash with `crypto/subtle.ConstantTimeCompare` — never `==` or `bytes.Equal` on secret material (timing side-channel).

```go
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil { // crypto/rand
		return "", err
	}
	const (mem = 64 * 1024; t = 3; p = 4; keyLen = 32)
	key := argon2.IDKey([]byte(pw), salt, t, mem, p, keyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, mem, t, p,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}
```

**bcrypt fallback.** `golang.org/x/crypto/bcrypt` with `cost >= 12` is acceptable where Argon2 is unavailable, but note bcrypt silently truncates input at **72 bytes** — pre-hash long/paraphrase inputs with SHA-256 before bcrypt, or prefer Argon2id. **Never MD5 or SHA-1** for passwords or integrity (refusal rule 4).

**Encrypted two-way — PAN / IBAN / national ID.** Use **AES-256-GCM** via `crypto/aes` + `crypto/cipher` (`cipher.NewGCM`), which gives authenticated encryption (confidentiality + tamper detection).

- **Key:** 32 bytes (AES-256). The key is a **data key** issued by a KMS under envelope encryption — call KMS `GenerateDataKey`, use the plaintext data key in memory only, store the KMS-wrapped data key alongside the ciphertext, and zero the plaintext key after use. Never a static/hardcoded key (refusal rules 4, 7).
- **Nonce:** 12 bytes, fresh from `crypto/rand` for **every** encryption, prepended to the ciphertext. **Reusing a nonce with the same key is catastrophic for GCM** — it breaks confidentiality and forgeability.
- Bind context with GCM's additional authenticated data (AAD), e.g. the record id, so ciphertext can't be moved between rows.

```go
func Encrypt(dataKey, plaintext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(dataKey) // 32-byte key => AES-256
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	// prepend nonce; Seal appends ciphertext+tag to it
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}
```

**Key management & rotation.** Keys live in a KMS/HSM (AWS KMS, GCP KMS, Azure Key Vault, or PKCS#11 HSM), never in source, env files committed to git, or config in the repo. Use envelope encryption (KMS-wrapped data keys). Rotate the KMS master key on schedule; store a key id/version with each ciphertext so old data stays decryptable through rotation. Transport is TLS 1.2+ with certificate validation on (refusal rule 8) — never `InsecureSkipVerify: true` in production.

**Forbidden (refusal red lines):** MD5/SHA-1 for passwords or integrity, DES/3DES, AES-**ECB** mode, home-rolled crypto, static or hardcoded keys/IVs, nonce/IV reuse, reversible encryption of passwords, `math/rand` for anything security-sensitive (use `crypto/rand`), and non-constant-time comparison of secrets.

## Country differences (how the same code changes)

The Go primitives stay the same; configuration, data residency, and extra gates change per region.

- **EU — GDPR, PSD2 SCA, DORA.** Data-subject rights mean PII (encrypted with the AES-256-GCM path) must be erasable/exportable — key design so deleting the data key crypto-shreds the record. PSD2 **Strong Customer Authentication**: add a second-factor/step-up gate in the Workflow before high-value or new-payee transfers, and record the SCA evidence in the audit trail. DORA raises the bar on log integrity, incident reporting, and tested resilience — the WORM audit store and `go test -race`/chaos testing feed this. Keep EU personal data in-region.
- **US — SOX, GLBA, CCPA.** SOX: immutable, access-controlled audit trail on anything touching financial reporting (the append-only store, with change management on the Go service). GLBA Safeguards Rule: the encryption + access-control + logging controls here are the technical safeguards. CCPA/CPRA: honour do-not-sell/delete; same crypto-shred design as GDPR.
- **UK — FCA, UK GDPR.** FCA operational-resilience and consumer-duty expectations map to the same audit, SCA, and resilience controls as EU (post-Brexit SCA still applies under UK PSRs). UK GDPR mirrors GDPR for PII handling and residency.
- **Turkey — KVKK, BDDK, MASAK.** **KVKK**: national ID (TC Kimlik No) is sensitive PII — never logged, encrypted at rest, consent recorded. **BDDK localization**: regulated financial data of Turkish customers must be stored **in Turkey** — pin the DB and KMS region, do not ship PII to an offshore log sink. **MASAK**: AML reporting obligations — the AML/sanctions step and its audit record are mandatory and must be retrievable for the regulator.

In code, express these as policy/config injected via `context` or a region resolver — not `if country == "TR"` scattered through handlers — so residency, SCA thresholds, and retention windows are set in one auditable place.

## Good example

```go
// ✅ Good — tokenize, never hold raw PAN/CVV; idempotent, audited, context-bound.
func (s *Service) Charge(ctx context.Context, cmd ChargeCmd) (Receipt, error) {
	if !auth.Can(ctx, "payments.charge") { // least privilege
		return Receipt{}, ErrForbidden
	}
	if r, ok, _ := s.ledger.Applied(ctx, cmd.IdemKey); ok { // idempotency
		return r, nil
	}
	// PAN/CVV go straight to the gateway and come back as a token; we store only the token.
	tok, err := s.gateway.Tokenize(ctx, cmd.CardNonce)
	if err != nil {
		return Receipt{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback()
	if err := s.saveMethod(ctx, tx, cmd.UserID, tok.Token, tok.MaskedPAN); err != nil {
		return Receipt{}, err
	}
	if err := writeAudit(ctx, tx, "charge", cmd.UserID, cmd.AmountMinor, cmd.IdemKey); err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return Receipt{}, err
	}
	slog.InfoContext(ctx, "charge ok", "user", cmd.UserID,
		"amount_minor", cmd.AmountMinor, "pan", tok.MaskedPAN) // masked only
	return Receipt{Token: tok.Token}, nil
}
```

## Bad example

```go
// ❌ Bad — multiple red lines; an agent must REFUSE to write this.
func Charge(pan, cvv string, amount float64) { // float money — rounding errors
	db.Exec("INSERT INTO cards(pan,cvv) VALUES('" + pan + "','" + cvv + "')") // stores PAN+CVV (PCI red line 1) + SQL injection
	log.Printf("charging card %s cvv %s", pan, cvv)                           // logs PAN + CVV (red line 3)
	key := []byte("1234567890123456")                                        // hardcoded key (red line 7)
	block, _ := aes.NewCipher(key)
	enc := cipher.NewCBCEncrypter(block, key) // IV == key reuse; ECB/fixed-IV class error (red line 4)
	_ = enc
	user.Password = md5.Sum([]byte(pw)) // MD5 password hash (red line 2, 4)
}
```

**Why refuse:** this crosses refusal-policy rules 1 (store PAN/CVV), 2 (broken password hash), 3 (log PAN/CVV), 4 (hardcoded key, broken crypto, fixed IV), and 7 (hardcoded credential), plus SQL injection and float money. The compliant rewrite is the Good example: tokenize at the gateway, store only the token + masked PAN, Argon2id for passwords, AES-256-GCM with a KMS data key and a random per-message nonce, parameterized SQL, integer minor units, and an atomic audit insert.

---

**References:** OWASP Password Storage Cheat Sheet (Argon2id 19 MiB / t=2 / p=1 minimum); `golang.org/x/crypto/argon2` (`IDKey`), `golang.org/x/crypto/bcrypt`; Go stdlib `crypto/aes`, `crypto/cipher` (`NewGCM`), `crypto/rand`, `crypto/subtle`, `database/sql`, `context`, `sync`, `log/slog`; RFC 9106 (Argon2); PCI-DSS v4.0.1; GDPR/PSD2/DORA, SOX/GLBA/CCPA, FCA/UK GDPR, KVKK/BDDK/MASAK. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) for the full red lines.
