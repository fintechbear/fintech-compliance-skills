# Skill: Python for Regulated Fintech

**Purpose.** Make an AI coding agent write Python that is safe to run in a regulated
financial system (payments, risk, data). Load this skill whenever the task is in
Python and touches money, customer PII, card data, onboarding/KYC, or anything an
auditor will later inspect. Always load it together with
[`refusal/refusal-policy.md`](../refusal/refusal-policy.md); load the matching
regional file for the user's jurisdiction.

## When to use

Load this skill when any of the following is true and the language is Python:

- You move money (transfers, payouts, card charges, ledger entries).
- You store or process PII, card data (PAN/CVV), IBANs, or national IDs.
- You build onboarding/KYC, AML screening, or risk scoring.
- You write anything that produces an audit trail or regulatory report.
- You touch authentication, password storage, or secrets handling.

If the task only renders a chart or formats a string with no sensitive data, you do
not need this skill — but if in doubt, load it. Fast = something was skipped.

---

## Logging — what goes where

Financial logs are evidence. They must be complete enough to reconstruct who did
what, yet must never themselves become a data breach. The rule is: **log the event
and the actors, never the secret.**

### Which events, which sink, which level

| Event | Sink | Level | Notes |
|-------|------|-------|-------|
| Auth success/failure, MFA, password change | Security/audit log | `INFO` / `WARNING` | Include user id, source IP, outcome — never the credential |
| Money movement (transfer, charge, refund, reversal) | Append-only audit store | `INFO` | Correlation id, idempotency key, actor, amount, currency, account ids (internal, not PAN) |
| Access to another party's financial data | Audit store | `INFO` | Actor, target account, authorization decision |
| KYC/AML/sanctions decision | Audit store | `INFO` | Decision, rule id, case id — the *decision*, not the raw document |
| Validation failure, business-rule rejection | App log | `WARNING` | No PII in the message body |
| Unhandled exception | App log + alerting | `ERROR` | Stack trace scrubbed of PII |
| Debug tracing | App log (non-prod only) | `DEBUG` | Disabled in production; never dumps request bodies |

Route audit events (money, access, AML, auth) to a **separate, tamper-evident sink**
from ordinary application logs. Operational logs rotate and can be noisy; audit logs
must be retained per regulation (commonly 5–7 years; see your regional skill) and
protected from edit/delete.

### What is MASKED before it reaches any sink

These must be redacted/tokenized *before* they hit a formatter:

- **PAN** → show only first 6 (BIN) + last 4, e.g. `411111******1111`. Full PAN in a
  log is a PCI-DSS violation.
- **CVV / CVC2 / track / PIN** → **never logged in any form, ever**, and never stored
  after authorization (PCI-DSS).
- **Passwords, API keys, bearer/OAuth tokens, session cookies, private keys** →
  redacted entirely (`***`).
- **National ID / tax id / SSN / TCKN** → masked (e.g. last 2–4 only) or dropped.
- **Full IBAN** → mask to last 4 for display; store encrypted (see below).

### What is NEVER logged

Raw PAN, CVV/PIN/track data, plaintext passwords, decrypted secrets, full government
IDs, raw KYC document contents, encryption keys. If a value belongs in the
"Hashing & encryption" section below, it does not belong in a log.

### Structured logging library + PII redaction mechanism

Use **`structlog`** (or stdlib `logging` with a JSON formatter such as
`python-json-logger`). Structured JSON logs are queryable and let you attach
redaction as a *processor in the pipeline* rather than hoping each call site
remembers to mask. The safest design is **allow-list by key**: emit only known-safe
fields, and run a redaction processor that masks known-sensitive keys as a backstop.

```python
import re
import structlog

_PAN_RE = re.compile(r"\b(\d{6})\d{4,9}(\d{4})\b")          # keep BIN + last4
_SENSITIVE_KEYS = {
    "password", "pwd", "secret", "token", "access_token", "refresh_token",
    "authorization", "api_key", "cvv", "cvc", "pin", "card_number", "pan",
    "ssn", "tckn", "national_id", "iban", "private_key",
}

def redact_processor(logger, method_name, event_dict):
    """structlog processor: drop/mask sensitive keys and mask PANs in free text."""
    for key in list(event_dict.keys()):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = "***REDACTED***"
    msg = event_dict.get("event")
    if isinstance(msg, str):
        event_dict["event"] = _PAN_RE.sub(r"\1******\2", msg)
    return event_dict

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,      # correlation id, actor
        structlog.processors.add_log_level,
        redact_processor,                              # backstop masking
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),           # machine-readable, shippable
    ],
    wrapper_class=structlog.make_filtering_bound_logger(20),  # INFO
    cache_logger_on_first_use=True,
)

log = structlog.get_logger()
log.info("transfer.posted", src="acct_123", dst="acct_456",
         amount="100.00", currency="EUR", idem_key="idem-abc",
         correlation_id="req-789")   # no PAN, no secrets
```

`contextvars.merge_contextvars` lets you bind a `correlation_id` / `actor` once per
request (via `structlog.contextvars.bind_contextvars`) so every line in that request
is traceable without passing ids around.

> **The redaction processor is a safety net, not the primary control.** The primary
> control is never putting a secret into the event in the first place (allow-list the
> fields you emit). Regex masking can miss non-standard formats.

### Log integrity (append-only / WORM / hash chain)

Audit logs must be tamper-evident:

- Ship audit events to an **append-only / WORM** sink: an object store with object
  lock (e.g. S3 Object Lock in compliance mode), a managed service like AWS
  CloudTrail/CloudWatch with retention locks, or a dedicated immutable log store.
- For local integrity, **hash-chain** records: each record stores
  `hash = SHA-256(prev_hash || canonical_json(record))`. A broken chain proves
  tampering. Use SHA-256 — never MD5/SHA-1 for integrity.
- Restrict who can read audit logs (they contain actor/account data) and alert on any
  attempt to disable or delete them. Disabling audit logging on money movement is a
  hard red line (see FCS-AUDIT-001).

---

## Workflow — payment / transfer / onboarding

The same backbone applies to a card charge, an account transfer, and a KYC
onboarding: **validate → authorize → check idempotency → do the work in one
transaction → write the audit record → commit.**

### Step order (transfer / payment)

1. **Authenticate & authorize.** Confirm the caller and that they may act on the
   source account (`@require_role` / policy check). Deny-by-default.
2. **Validate input** (Pydantic — see below). Reject malformed amounts, currencies,
   account ids before touching state.
3. **Idempotency gate.** Require a client-supplied idempotency key. If a completed
   result exists for that key, return it without re-executing. This prevents
   double-charges on retry.
4. **Approval gate** where required: amounts over a threshold, new payee, or SCA
   (PSD2) for EU remote payments need an additional authorization step *before* the
   money moves.
5. **Execute inside one DB transaction** with locking (below): debit source, credit
   destination (or write the ledger entry), persist the idempotency record, and write
   the audit record — all atomic.
6. **Commit.** On any failure, roll back the whole transaction so no partial transfer
   survives.
7. **Emit the audit event** to the append-only sink (step 5 persists it in the same
   transaction so it cannot be lost if commit succeeds).

Money is always represented with `decimal.Decimal` or integer **minor units**
(cents) — never `float`. Binary floats cannot represent `0.10` exactly and will drift.

### Where each control sits

- **Approval gate:** between validation and execution (step 4).
- **Idempotency:** step 3 (check) + step 5 (persist key in the same transaction).
- **Audit record:** step 5, written in the *same* transaction as the money movement
  so it is impossible to move funds without the matching audit row.

### Concurrency / locking model (SQLAlchemy)

Two accounts being updated concurrently is the classic lost-update bug. Use one of:

**Pessimistic locking** — `SELECT ... FOR UPDATE` via `with_for_update()`. Lock rows
in a **consistent order** (e.g. by account id ascending) to avoid deadlocks. Best when
contention is high (hot accounts).

```python
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.orm import Session

def transfer(session: Session, src_id: int, dst_id: int,
             amount: Decimal, idem_key: str, actor: str) -> None:
    # idempotency gate — return prior result instead of re-executing
    if session.get(IdempotencyRecord, idem_key):
        return

    first, second = sorted((src_id, dst_id))          # stable lock order
    locked = {
        a.id: a for a in session.scalars(
            select(Account).where(Account.id.in_((first, second)))
                           .with_for_update()          # pessimistic row lock
        )
    }
    src, dst = locked[src_id], locked[dst_id]

    if src.balance < amount:
        raise InsufficientFunds(src_id)

    src.balance -= amount                              # Decimal math, minor units
    dst.balance += amount
    session.add(IdempotencyRecord(key=idem_key, status="applied"))
    session.add(AuditEntry(action="transfer", src=src_id, dst=dst_id,
                           amount=amount, currency="EUR",
                           actor=actor, idem_key=idem_key))
    session.commit()                                   # atomic: both legs + audit
```

**Optimistic locking** — a `version_id` column (`__mapper_args__ =
{"version_id_col": version}`); SQLAlchemy bumps it on update and raises
`StaleDataError` if another transaction changed the row first. Best when contention is
low; retry on conflict.

Set the transaction isolation level deliberately. `READ COMMITTED` (Postgres default)
plus `FOR UPDATE` is the common, correct choice for ledgers; `SERIALIZABLE` gives the
strongest guarantee at the cost of retries. Never read-modify-write a balance outside a
transaction.

### Onboarding / KYC variation

Same backbone, different middle: validate identity input → run KYC/AML/sanctions
screening (never skip it — FCS-AML-001) → persist the *decision* and case id to the
audit store → gate account activation on a passing decision. Store raw identity
documents encrypted (below); log only the decision, not the document.

---

## Hashing & encryption

The dividing line: **one-way hash things you only ever need to *verify*** (passwords);
**two-way encrypt things you need to *read back*** (PAN, IBAN, national ID). Never use
reversible encryption for passwords (FCS-SECRET-001); never use a plain hash for data
you must recover.

### Hashed one-way — passwords & secrets at rest

Use **`argon2-cffi`** (Argon2id). It is the OWASP-recommended, memory-hard,
PHC-winning algorithm (RFC 9106). **`bcrypt`** is an acceptable fallback where Argon2
is unavailable. **MD5 and SHA-1/SHA-2 are NOT password hashes** — a fast hash is
crackable at billions/sec; using them for passwords is a red line (FCS-SECRET-001, FCS-CRYPTO-001).

**Parameters.** OWASP's current *minimum* for Argon2id is **memory 19 MiB, iterations
(time cost) 2, parallelism 1**. The `argon2-cffi` `PasswordHasher()` defaults are
stronger — **time_cost=3, memory_cost=65536 (64 MiB), parallelism=4, hash_len=32,
salt_len=16** — which match the RFC 9106 "first recommended" (64 MiB) profile. Keep the
defaults (or raise them) on server hardware; tune so a single hash takes roughly
0.25–0.5 s on your production CPU, and re-benchmark periodically.

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError

# Defaults: Argon2id, time_cost=3, memory_cost=65536 KiB (64 MiB), parallelism=4
ph = PasswordHasher()

def hash_password(plain: str) -> str:
    return ph.hash(plain)            # unique random salt embedded in the output

def verify_password(stored_hash: str, plain: str) -> bool:
    try:
        ph.verify(stored_hash, plain)
    except (VerifyMismatchError, InvalidHashError):
        return False
    # transparently upgrade weak/old hashes on successful login
    if ph.check_needs_rehash(stored_hash):
        # caller persists the new hash
        pass
    return True
```

`PasswordHasher` generates a cryptographically random salt per hash automatically and
encodes all parameters in the PHC string, so verification and `check_needs_rehash`
(for seamless upgrades) work without storing params separately.

### Encrypted two-way — PAN, IBAN, national ID

Use **`cryptography`** (`pyca/cryptography`). For stored sensitive fields use
**AES-256-GCM** via `cryptography.hazmat.primitives.ciphers.aead.AESGCM` — it is an
AEAD cipher giving confidentiality *and* integrity. Protect the data key with a **KMS
envelope**: the master key lives in a KMS/HSM (AWS KMS, GCP KMS, Azure Key Vault,
HashiCorp Vault); you encrypt data with a per-record/per-use **data key**, and store
only the KMS-wrapped data key alongside the ciphertext.

```python
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def encrypt_field(plaintext: bytes, data_key: bytes, aad: bytes) -> tuple[bytes, bytes]:
    """AES-256-GCM. data_key is a 32-byte key unwrapped from KMS per operation."""
    nonce = os.urandom(12)                      # 96-bit nonce, UNIQUE per encryption
    aesgcm = AESGCM(data_key)                   # 32 bytes -> AES-256
    ciphertext = aesgcm.encrypt(nonce, plaintext, aad)   # aad binds context, e.g. user id
    return nonce, ciphertext                    # store both; GCM tag is appended to ct

def decrypt_field(nonce: bytes, ciphertext: bytes, data_key: bytes, aad: bytes) -> bytes:
    return AESGCM(data_key).decrypt(nonce, ciphertext, aad)   # raises on tamper
```

Critical GCM rule: **a (key, nonce) pair must never repeat.** Reusing a nonce with the
same key catastrophically breaks GCM. Generate a fresh 96-bit random nonce per
encryption (or a guaranteed-unique counter) and rotate data keys well before the
nonce space is a concern.

**`Fernet`** (from the same library) is fine for *application secrets / config tokens*:
it is AES-128-CBC + HMAC-SHA256, authenticated and hard to misuse. But it is 128-bit
and not envelope-friendly, so for **card/PCI field encryption prefer `AESGCM` +
AES-256 + KMS**. Best of all for PANs: **don't store them** — tokenize via the
processor and keep only a token + masked PAN (see "Bad example" and PCI-DSS skill).

### Key management, rotation, what is FORBIDDEN

- Keys live in a **KMS/HSM**, never in source, env files committed to git, or the
  database next to the data they protect.
- **Rotate** master keys on a schedule and on suspected compromise; design storage to
  carry a `key_id`/`key_version` per record so you can decrypt old data and re-encrypt
  lazily.
- Separate duties: the service that encrypts should not also be able to export master
  key material.
- **Forbidden (red lines, FCS-CRYPTO-001, FCS-SECRET-002):** hardcoded keys or IVs, static/shared
  nonces, **ECB mode**, DES/3DES, home-rolled crypto, MD5/SHA-1 for integrity or
  passwords, disabling TLS certificate validation (FCS-TLS-001).

---

## Country differences (how the same code changes)

The algorithms stay the same; the *obligations around them* change. Load the matching
regional skill for specifics.

- **EU — GDPR, PSD2, DORA.** GDPR: lawful basis, data minimization, right to erasure
  (design so PII can be deleted/crypto-shredded), breach notice within 72h. **PSD2
  SCA**: remote electronic payments need strong customer authentication with **dynamic
  linking** — the authentication is bound to the specific amount and payee (Art. 97(2))
  — so your approval gate must capture and bind amount+payee. **DORA** (applicable since
  **17 January 2025**): ICT risk management, incident reporting, a register of ICT
  third-party providers, and resilience testing — your logging/audit and vendor
  dependencies must be documented and testable.
- **US — SOX, GLBA, CCPA.** SOX: change-management and audit trails for anything
  affecting financial reporting (immutable audit logs, segregation of duties). GLBA:
  safeguard customer financial info (encryption at rest/in transit, access control).
  CCPA/CPRA: consumer data access/deletion rights — track where PII lives.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (Turkey's GDPR analogue): consent, data subject
  rights, VERBİS registration where applicable. **BDDK** banking rules may require
  **data localization** — customer/financial data kept on infrastructure in Turkey; do
  not default to an offshore region. **MASAK**: AML/suspicious-transaction reporting —
  your AML pipeline must produce MASAK-compatible reports and retain records.
- **UK — FCA, UK GDPR.** FCA operational-resilience and consumer-duty expectations;
  UK GDPR mirrors EU GDPR post-Brexit. UK SCA requirements track PSD2-equivalent rules.

The same `transfer()` above is unchanged in logic across regions; what changes is the
approval gate (SCA for EU), the audit retention period, the data residency of the DB,
and which regulator's report the AML decision feeds.

---

## Good example

Idiomatic, defensible Python: validated input, Decimal money, idempotent + audited
money movement, no secrets logged.

```python
from decimal import Decimal
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session
import structlog

log = structlog.get_logger()

class TransferRequest(BaseModel):
    src_account: str
    dst_account: str
    amount: Decimal                       # parsed as Decimal, not float
    currency: str
    idempotency_key: str

    @field_validator("amount")
    @classmethod
    def positive_2dp(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("amount must be positive")
        if v.as_tuple().exponent < -2:    # reject sub-cent precision
            raise ValueError("amount exceeds minor-unit precision")
        return v

    @field_validator("currency")
    @classmethod
    def iso_currency(cls, v: str) -> str:
        if len(v) != 3 or not v.isalpha():
            raise ValueError("currency must be ISO-4217")
        return v.upper()

@require_role("transfers.write")          # authz: deny-by-default
def handle_transfer(session: Session, req: TransferRequest, actor: str) -> None:
    transfer(session, int(req.src_account), int(req.dst_account),
             req.amount, req.idempotency_key, actor)   # locks + audit, atomic
    log.info("transfer.accepted", src=req.src_account, dst=req.dst_account,
             amount=str(req.amount), currency=req.currency,
             idem_key=req.idempotency_key)              # no PAN, no secret
```

Pydantic does the input validation at the boundary (types, positivity, ISO currency,
minor-unit precision), the amount stays `Decimal`, the DB work is the locked,
idempotent, audited `transfer()` from above, and the log line carries only safe fields.

## Bad example

```python
# ❌ Bad — multiple red lines in a few lines of code
import hashlib, logging

def store_card(db, user, pan, cvv, pw):
    user.card = pan                                  # storing raw PAN (PCI red line)
    user.cvv = cvv                                   # storing CVV after auth — forbidden
    user.password = hashlib.md5(pw.encode()).hexdigest()  # MD5 "hash" — broken (FCS-SECRET-001/FCS-CRYPTO-001)
    logging.info(f"saved card {pan} cvv {cvv} for {user.ssn}")  # logging PAN+CVV+SSN
    db.save(user)

def pay(a, b, amount):
    a.balance -= 19.99 * amount                      # float money -> rounding drift
    b.balance += 19.99 * amount                      # no transaction, no lock, no idempotency
    # no audit record written at all                 # money moved invisibly (FCS-AUDIT-001)
```

**The red lines it crosses:** stores raw PAN and CVV (PCI-DSS, FCS-PAN-001);
"hashes" a password with MD5 (FCS-SECRET-001/FCS-CRYPTO-001); logs PAN, CVV, and SSN (FCS-LOG-001); uses
binary `float` for money (silent rounding errors); moves funds with no transaction, no
row lock, no idempotency key, and **no audit record** (FCS-AUDIT-001 — bypassing audit on
money movement). An agent asked to write this must **refuse** per
[`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and offer the compliant
`handle_transfer` / tokenize-the-card pattern instead.
