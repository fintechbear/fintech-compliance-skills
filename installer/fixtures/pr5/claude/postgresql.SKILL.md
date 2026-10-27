---
name: postgresql
description: Storage-side security controls for PostgreSQL holding regulated financial data (PAN, IBAN, balances, PII).
triggers: postgresql, schema, migration, query, store data
---

# Skill: PostgreSQL for Regulated Fintech

**Storage-side security controls for PostgreSQL holding regulated financial data (PAN, IBAN, balances, PII).** Load this skill whenever an agent designs schema, writes SQL/DDL, configures roles, or reasons about encryption, auditing, retention, or access control for a PostgreSQL database in a bank, PSP, or other regulated fintech. Always load `skills/refusal/refusal-policy.md` alongside it.

## When to use

- Designing or migrating a schema that stores cardholder data, account numbers, national IDs, or balances.
- Choosing *where* a control lives: application tier vs. database tier. This skill covers only the database tier — column encryption, at-rest encryption, Row-Level Security (RLS), audit logging, masking, retention, and role separation inside PostgreSQL itself.
- Writing DDL, `GRANT`/`REVOKE`, `CREATE POLICY`, `pgaudit` settings, or `pg_hba.conf`/TLS configuration.
- Reviewing a PostgreSQL deployment against PCI-DSS v4.0.1, GDPR/DORA, GLBA/SOX, or KVKK/BDDK.

Do **not** treat the database as the only line of defence. PostgreSQL controls are defence-in-depth *behind* application-tier tokenization and KMS envelope encryption — not a replacement for them. The single most important PostgreSQL limitation to internalise: **anything the running server can decrypt, any sufficiently privileged connection can read.** Database-resident crypto does not defend against a compromised application, a malicious superuser/DBA, or SQL injection.

## Logging — what goes where

PostgreSQL has two distinct logging layers. Keep them separate and route them to separate sinks.

| Layer | Mechanism | Purpose | Sink |
|-------|-----------|---------|------|
| Engine/operational log | `log_*` GUCs + `logging_collector` | errors, slow queries, connections, DDL | ops log pipeline (stdout → Fluent Bit / CloudWatch / Loki) |
| **Audit trail** | **`pgaudit` extension** | who ran what DML/DDL, when, against which object | **separate immutable audit sink** |

### pgaudit configuration

`pgaudit` (the standard PostgreSQL Audit Extension) emits detailed **session** and **object** audit logging through the normal PostgreSQL log facility. It hooks the executor, so it records the statement that actually ran — including inside `DO` blocks and PL/pgSQL functions — not just what the client typed.

```ini
# postgresql.conf
shared_preload_libraries = 'pgaudit'

# Session audit logging: classes of statements to log server-wide.
# Log writes, DDL, and privilege changes everywhere; do NOT blanket-log READ
# (it floods the log and can echo sensitive WHERE-clause values).
pgaudit.log = 'write, ddl, role'
pgaudit.log_catalog = off          # skip noisy system-catalog reads
pgaudit.log_parameter = off        # CRITICAL: off, so bind params (which may hold PAN/PII) are NOT logged
pgaudit.log_relation = on          # one entry per relation touched
pgaudit.log_statement_once = off
```

Scope read auditing to the sensitive tables only, using **object audit logging** (a role whose privileges define what is audited):

```sql
-- Object-level: audit every SELECT/UPDATE/DELETE on the cardholder table only.
CREATE ROLE auditor NOLOGIN;
ALTER ROLE auditor SET pgaudit.role = 'auditor';   -- conceptually: grants to 'auditor' mark audited objects
GRANT SELECT, UPDATE, DELETE ON cardholder_data TO auditor;
-- pgaudit now logs any session touching cardholder_data, regardless of who runs it.
```

- **Which events are logged:** all writes (INSERT/UPDATE/DELETE/TRUNCATE), all DDL, all role/privilege changes (`pgaudit.log='write,ddl,role'`), plus scoped reads of sensitive objects via object logging. This satisfies PCI-DSS v4.0.1 Req. 10 (log all access to cardholder data and all actions by privileged users).
- **What is MASKED before it hits any sink:** PAN, CVV/CVC, passwords, tokens, national ID. Enforce this by (a) `pgaudit.log_parameter = off` so bound parameters are never written, and (b) never embedding raw secrets in SQL text. CVV must **never** be stored at all (PCI-DSS 3.3.1) — so it can never appear in a log.
- **What is NEVER logged:** full PAN, CVV, raw passwords, decryption keys, session/bearer tokens, OAuth secrets. If a value cannot be reconstructed from the log, it cannot leak from the log.
- **Structured logging:** set `log_destination = 'jsonlog'` (PostgreSQL 15+) or `csvlog` so the ops pipeline can parse fields reliably. pgaudit lines are greppable (`AUDIT:` prefix) and structured by class.
- **PII redaction mechanism:** redaction happens *before* the sink — at the application tier (never log the value) and at the pgaudit tier (`log_parameter=off`, no reads blanket-logged). PostgreSQL has no post-hoc log scrubber; prevention is the mechanism.
- **Log integrity (append-only / WORM / hash chain):** PostgreSQL does not make its own logs tamper-evident. Ship audit logs off-box in near-real-time to a WORM/append-only store (e.g. object storage with Object Lock / immutability, or a SIEM with integrity sealing). Restrict `log_directory` filesystem permissions; the `postgres` OS user and any DBA can otherwise edit local files. Treat the shipped copy, not the local file, as the system of record. PCI-DSS v4.0.1 Req. 10.5 requires audit history retention of at least 12 months, with ≥3 months immediately available.

## Workflow — payment / transfer / onboarding

The database enforces the invariants the application can forget. Order and placement matter.

### Step order (money movement)

1. **AuthN/AuthZ happens upstream** (application). The DB connection arrives under a *role scoped to the operation*, not a shared superuser.
2. **Begin transaction** at the correct isolation level. For balance movement use `REPEATABLE READ` or `SERIALIZABLE` so concurrent transfers cannot both read a stale balance and double-spend.
3. **Idempotency gate (DB-enforced):** a unique constraint on the idempotency key is the authoritative guard — not an app-side `if`. A retried request collides on the constraint instead of moving funds twice.
4. **Approval gate:** high-value or dual-control transfers insert a `pending_approval` row; the actual debit/credit is a *separate* transaction gated by a second role. Model the state machine in the schema (`CHECK` constraint on allowed status transitions).
5. **Apply the ledger entries** as balanced double-entry rows inside the same transaction (sum of entries per transaction = 0). Never mutate a running `balance` column as the source of truth; derive balance from immutable ledger entries.
6. **Write the audit record** in the same transaction so it commits atomically with the money movement. If the transfer rolls back, so does its audit row — no phantom audit, no unaudited transfer.
7. **Commit.** Use `NUMERIC(precision, scale)` or integer **minor units** for money — never `float`/`double precision`. Binary floats silently lose cents.

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- 3. DB-enforced idempotency: the unique index is the real guard.
INSERT INTO transfer_request (idem_key, from_acct, to_acct, amount_minor)
VALUES ($1, $2, $3, $4)
ON CONFLICT (idem_key) DO NOTHING
RETURNING id;
-- if no row returned, this is a retry → stop, return the prior result.

-- 5. Balanced double-entry (amounts in integer minor units).
INSERT INTO ledger_entry (txn_id, acct, delta_minor) VALUES
  ($5, $2, -$4),
  ($5, $3,  $4);
-- CHECK/trigger: SUM(delta_minor) per txn_id must equal 0.

-- 6. Atomic audit row.
INSERT INTO audit_log (action, actor, from_acct, to_acct, amount_minor, idem_key, at)
VALUES ('transfer', current_user, $2, $3, $4, $1, now());

COMMIT;
```

### Concurrency / locking model

- **Isolation:** `READ COMMITTED` (default) is insufficient for balance arithmetic. Use `REPEATABLE READ` (snapshot) or `SERIALIZABLE` (full serialization via predicate locks) for money movement and be prepared to **retry on `serialization_failure` (SQLSTATE 40001)** — this is a feature, not an error to swallow.
- **Pessimistic:** `SELECT ... FOR UPDATE` locks the account rows for the duration of the transaction; correct when contention on a single account is high and you want to avoid serialization retries.
- **Optimistic:** a `version` column with `WHERE version = $expected` + check `rowcount = 1`; correct for low contention.
- **Deadlock discipline:** always lock accounts in a deterministic order (e.g. by ascending account id) so two opposing transfers cannot deadlock.

## Hashing & encryption

### What is HASHED one-way (passwords / secrets you never need back)

- **Target: Argon2id.** PostgreSQL's bundled `pgcrypto` **does not implement Argon2.** Its `crypt()`/`gen_salt()` support `bf` (bcrypt), `md5`, `xdes`, and `des` only. Therefore:
  - **Preferred:** hash passwords **in the application tier** with Argon2id (e.g. `argon2-cffi` in Python, `argon2` via Spring Security in Java, `golang.org/x/crypto/argon2`) — parameters of the OWASP baseline order (memory ≈ 19 MiB+, iterations ≥ 2, parallelism 1, tuned up to hardware). Store only the encoded hash string in a `text` column.
  - **In-database alternative:** the `pgsodium` extension exposes libsodium's `crypto_pwhash` (Argon2id) if you must hash inside SQL.
  - **Last-resort in-database fallback:** `pgcrypto` bcrypt — acceptable only where app-tier hashing is impossible.

```sql
-- Acceptable in-DB fallback ONLY (bcrypt via pgcrypto). Prefer app-tier Argon2id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE app_user SET pw_hash = crypt($1, gen_salt('bf', 12)) WHERE id = $2;  -- cost 12+
-- verify:
SELECT (pw_hash = crypt($1, pw_hash)) AS ok FROM app_user WHERE id = $2;
```

- **FORBIDDEN for passwords:** MD5, SHA-1, any unsalted/fast digest, and `digest()`/`hmac()` used as a password store. `md5`, `sha1` exist in `pgcrypto` for checksums/legacy interop only — never for credentials.

### What is ENCRYPTED two-way (PAN, IBAN, national ID — you must read it back)

- **Primary pattern: tokenize, don't store.** For PAN specifically, the PCI-DSS-correct design is to hand the card to a tokenization provider/gateway and store only a token + masked PAN (first6/last4). If you never hold the PAN, most of PCI scope evaporates. See `examples/good-vs-bad.md` §1.
- **When you must store ciphertext: AES-256-GCM with KMS envelope encryption, performed in the application tier.** The data encryption key (DEK) is generated per-dataset, encrypted by a KMS-held key-encryption key (KEK), and the plaintext DEK never touches the database. The database stores only ciphertext + the wrapped DEK reference. This keeps keys out of reach of a DBA and out of `pg_dump` output.
- **`pgcrypto` for two-way encryption — understand the limits before using it.** `pgcrypto` offers `pgp_sym_encrypt`/`pgp_sym_decrypt` (authenticated, salted; **prefer over** raw `encrypt()`) and raw `encrypt()/decrypt()` (AES in CBC/ECB — ECB is forbidden). The fatal weakness of *all* in-database encryption: **the key must be supplied to the SQL function**, so it appears in the session, in `pg_stat_activity`, potentially in logs, and travels in the query. In-DB `pgcrypto` encryption does **not** protect data from anyone who can run queries. Use it only for narrow cases where the key is passed per-statement from an external vault and never persisted in the DB.

```sql
-- pgcrypto two-way: key comes from an EXTERNAL secret store, passed per call.
-- NOTE: the key is visible to the running session — not a defence against a DBA.
INSERT INTO account (iban_enc)
VALUES ( pgp_sym_encrypt($1, $2) );   -- $1 = IBAN plaintext, $2 = key from vault
SELECT pgp_sym_decrypt(iban_enc, $1) FROM account WHERE id = $2;  -- $1 = key from vault
```

### At-rest encryption (TDE) — PostgreSQL's biggest gap

- **Core PostgreSQL has NO native Transparent Data Encryption.** This is a known, long-standing gap; the community has repeatedly declined to add it to core.
- **`pg_tde` (Percona)** reached **GA in July 2025**: an open-source extension providing **table-level** TDE (table data, indexes, TOAST, temp tables) using **AES**, with **WAL encryption** added. Keys integrate with external KMS (KMIP / HashiCorp Vault). Limits to state plainly: it is **not column-level**, and **system catalogs and metadata remain unencrypted**.
- **The decisive limitation of any TDE:** it protects data **at rest on disk** only (stolen disk, discarded backup). It does **not** protect against a compromised application, a malicious DBA/superuser, or SQL injection — the server decrypts transparently, so any connected query reads plaintext. Do not let a compliance checkbox for "encryption at rest" stand in for column-level protection of PAN/PII.
- **Practical at-rest stack for most fintechs:** rely on **storage/volume encryption** (LUKS, cloud EBS/disk encryption with a KMS-managed key) for the disk-theft threat, **plus** application-tier AES-256-GCM + KMS for the fields that actually matter (PAN, IBAN, national ID), **plus** `pg_tde` where table-level engine encryption is specifically required. Encrypt backups independently (`pg_basebackup`/`pg_dump` output through an encrypting pipeline; verify the backup, not just the live DB, is covered).

### Transport encryption (SSL/TLS)

At-rest crypto is worthless if the wire is clear. Require TLS for every connection.

```ini
# postgresql.conf
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file  = 'server.key'
ssl_min_protocol_version = 'TLSv1.2'   # 1.2 floor; prefer 1.3
```

```conf
# pg_hba.conf — reject non-TLS, and prefer mutual-TLS (client certs) for app roles.
hostssl  all  all  0.0.0.0/0  scram-sha-256  clientcert=verify-full
# 'host' (non-ssl) lines for remote clients are FORBIDDEN; use hostssl only.
```

- Authentication method: **`scram-sha-256`** (never `md5`, never `trust` for anything reachable). Set `password_encryption = 'scram-sha-256'`.
- `clientcert=verify-full` gives mutual TLS and guards against MITM. PCI-DSS v4.0.1 Req. 4 requires strong cryptography for data in transit over open/public networks.

### Key management, rotation, what is FORBIDDEN

- Keys live in an external KMS/HSM (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault, PKCS#11 HSM). The database stores wrapped DEKs or references — never the KEK, never a plaintext DEK.
- **Rotation:** rotate KEKs on a schedule (re-wrap DEKs, no data re-encryption needed) and have a break-glass re-encryption path for DEK compromise. Rotate TLS certs before expiry. Record rotation events in the audit trail.
- **FORBIDDEN:** static/hardcoded keys; keys in `postgresql.conf`, env vars, or committed files; ECB mode; home-rolled crypto; a single key shared across all tenants/datasets forever; storing the encryption key in the same database as the ciphertext.

## Row-Level Security & role separation

### Role separation (least privilege)

- One PostgreSQL role per *function*, not per person: `app_rw` (application write path), `app_ro` (reporting), `migrator` (DDL, used only by CI), `auditor` (read of audit tables), `rls_admin`. **Never** let the application connect as a superuser or the table owner.
- Revoke the default `PUBLIC` privileges: `REVOKE ALL ON SCHEMA public FROM PUBLIC;` then grant explicitly.
- The table owner **bypasses RLS by default** — so the application role must *not* be the owner. Use a separate owner; consider `FORCE ROW LEVEL SECURITY` to make even the owner obey policies.
- Superuser and `BYPASSRLS` roles see everything: keep them to break-glass use, logged via pgaudit.

### Row-Level Security (RLS)

RLS pushes tenant/ownership isolation into the engine, so a forgotten `WHERE` clause or an injection cannot cross tenants.

```sql
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;   -- even the owner is constrained

-- Tenant isolation: a session sets its tenant via a GUC the app cannot forge upward.
CREATE POLICY tenant_isolation ON account
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Separate, stricter policy for writes.
CREATE POLICY tenant_write ON account
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- Set `app.tenant_id` with `SET LOCAL` inside the transaction, from a *trusted* value derived from the authenticated session — never from user-supplied input.
- RLS + object-level pgaudit on the same sensitive tables gives both *prevention* (RLS) and *detection* (audit).

## Dynamic & static data masking

PostgreSQL has no built-in dynamic data masking in core. Use the **PostgreSQL Anonymizer (`anon`) extension**, which supports three strategies: **dynamic masking** (masked roles see masked data live), **static masking** (permanently overwrite a copy), and **anonymous dumps** (masked `pg_dump`). Masking functions include substitution, faking, pseudonymization, partial scrambling (ideal for PAN → first6/last4), noise/variance, shuffling, and generalization.

```sql
CREATE EXTENSION IF NOT EXISTS anon CASCADE;
SELECT anon.init();

-- Partial scramble a PAN column for masked roles: keep first 6 / last 4.
SECURITY LABEL FOR anon ON COLUMN cardholder_data.pan
  IS 'MASKED WITH FUNCTION anon.partial(pan, 6, $$xxxxxx$$, 4)';

-- Replace an address column with a constant for masked roles.
SECURITY LABEL FOR anon ON COLUMN customer.address
  IS $$MASKED WITH VALUE 'CONFIDENTIAL'$$;

-- Grant a reporting role masked-only visibility.
SECURITY LABEL FOR anon ON ROLE analyst IS 'MASKED';
```

Use **dynamic masking** so analysts/support see masked values without a second data copy; use **static masking / anonymous dumps** to produce lower-environment (dev/test/UAT) datasets that carry no real PII — a GDPR/KVKK data-minimisation requirement. Masking is *not* a substitute for encryption or access control; it is a complementary control for least-exposure.

## Data retention

- Model retention in the schema: timestamp every PII/transaction row and run a scheduled purge (`pg_cron` or an external scheduler) that deletes or anonymizes rows past their legal retention window.
- **Conflicting obligations are the norm** and must both be satisfied: AML/KYC and transaction records typically require **5–10 year retention** (e.g. EU AMLD, Turkey MASAK/BDDK, US BSA), while GDPR/KVKK demand erasure once the purpose ends. Resolve by **separating** the datasets: keep the legally-mandated transaction/AML records in a retained, access-restricted store, and erase/anonymize the marketing/behavioural PII on the GDPR timeline.
- **Right to erasure:** prefer `anon` static masking / crypto-shredding (destroy the per-record DEK) over physical `DELETE` where referential integrity or append-only ledgers forbid row removal. Crypto-shredding renders encrypted PII unrecoverable while leaving the ledger structurally intact.
- Enforce retention deletions through the same audited, role-separated path as any other write — a purge job is a privileged action and must be logged.

## Country differences (how the same schema/config changes)

- **EU — GDPR, PSD2 SCA, DORA.** Data minimisation → mask lower environments (`anon`), encrypt PII at column level, honour erasure via crypto-shredding. DORA (in force Jan 2025) demands operational resilience: tested, encrypted backups, logged recovery, and ICT risk controls — your audit trail and backup-encryption posture are in scope. PSD2 SCA is enforced in the app tier but the DB must store strong-auth evidence and transaction audit for dispute/resilience.
- **US — SOX, GLBA, CCPA.** SOX → immutable, off-box financial-change audit trail (pgaudit `write,ddl,role` shipped to WORM) and strict role separation with change control on `migrator`. GLBA Safeguards Rule → encryption of customer financial data + access controls (RLS, least privilege). CCPA/CPRA → deletion and do-not-sell handling on consumer PII, met with the same retention/erasure machinery.
- **Turkey — KVKK, BDDK, MASAK.** KVKK mirrors GDPR (encryption, masking, erasure). **BDDK data-localization**: for in-scope institutions, primary systems and backups of customer data must reside **in Turkey** — this constrains *where* the PostgreSQL instance, its replicas, and its backups physically run, independent of any code. MASAK → long-horizon (multi-year) retention of transaction/KYC records; keep the retained store access-restricted and audited.
- **UK — FCA, UK GDPR.** UK GDPR ≈ EU GDPR for masking/encryption/erasure. FCA → record-keeping and auditability (pgaudit trail, retained), plus operational resilience expectations parallel to DORA. Cross-border transfers of the retained store require a lawful transfer mechanism.

See `skills/refusal/refusal-policy.md` for the hard red lines (e.g. refuse to store CVV, refuse plaintext PAN, refuse to disable audit on regulated tables).

## Good example

```sql
-- ✅ Good — PAN tokenized (not stored), ciphertext fields use app-tier KMS envelope,
-- RLS forced, audit atomic, TLS+scram enforced, retention timestamped.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE payment_method (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    user_id       uuid NOT NULL,
    pan_token     text NOT NULL,            -- gateway token, NOT the PAN
    masked_pan    text NOT NULL,            -- '411111******1111' for display
    iban_ciphertext bytea,                  -- AES-256-GCM from app tier; DEK wrapped by KMS
    created_at    timestamptz NOT NULL DEFAULT now()   -- retention anchor
);

ALTER TABLE payment_method ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_method FORCE ROW LEVEL SECURITY;
CREATE POLICY pm_tenant ON payment_method
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

REVOKE ALL ON payment_method FROM PUBLIC;
GRANT SELECT, INSERT ON payment_method TO app_rw;   -- app role, NOT owner, NOT superuser
-- pgaudit object logging already covers this table via the 'auditor' role grant.
```

## Bad example

```sql
-- ❌ Bad — refuse. Raw PAN + CVV stored, home-rolled "encryption", key in the query,
-- no RLS, broken password hash, audit disabled, plaintext money.
CREATE TABLE card (
    pan    text,                                   -- raw PAN at rest (PCI-DSS violation)
    cvv    text,                                   -- storing CVV is NEVER allowed (PCI 3.3.1)
    balance double precision                       -- binary float money → lost cents
);
INSERT INTO card VALUES (
    encrypt($1::bytea, 'hardcoded-key-123', 'aes-ecb'),  -- ECB + static key in SQL (forbidden)
    $2, 100.10
);
UPDATE app_user SET pw_hash = md5($1);             -- MD5 password hash (broken)
ALTER SYSTEM SET pgaudit.log = 'none';             -- disabling audit on regulated data
-- Red lines crossed: stored CVV, plaintext/weak-crypto PAN, ECB, hardcoded key in query,
-- MD5 credentials, float money, no RLS/tenant isolation, audit trail turned off.
```
