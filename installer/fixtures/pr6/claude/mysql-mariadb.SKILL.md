---
name: "mysql-mariadb"
description: "Purpose."
triggers: "mysql, mariadb, schema, migration, query, store data"
---

# Skill: MySQL / MariaDB for Regulated Fintech

**Purpose.** Make an AI coding agent configure and query MySQL or MariaDB so the
*storage layer* of a regulated financial system is safe — data encrypted at rest and
in transit, access least-privileged, every money/data touch auditable, and PII
masked before it leaks. Load this skill whenever the task involves a MySQL/MariaDB
schema, DDL, encryption config, user/role grants, audit configuration, or SQL that
touches money, PII, card data, IBANs, or national IDs. Always load it together with
[`refusal/refusal-policy.md`](../refusal-policy/SKILL.md) and
[`global/pci-dss.md`](../pci-dss/SKILL.md); load the matching regional file for the
user's jurisdiction.

> **Engine note.** MySQL (Oracle) and MariaDB diverged after MySQL 5.7. They share
> SQL and the InnoDB engine but their *security features differ in name and
> availability* — keyring, audit, and data-masking especially. Every section below
> flags where they differ. When a feature is **Enterprise-only** (MySQL Enterprise
> Edition / commercial license) it is called out explicitly, because an agent that
> assumes an Enterprise feature exists in Community/MariaDB will write config that
> silently does nothing.

## When to use

Load this skill when any of the following is true and the database is MySQL or MariaDB:

- You create or alter tables that hold PII, card data (PAN), IBANs, national IDs,
  balances, or ledger entries.
- You configure data-at-rest encryption, keyring/key-management, TLS, or backups.
- You write `GRANT`/`REVOKE`, create roles, or design service-account access.
- You configure audit logging, the binary log, or data retention.
- You write SQL that moves money or reads another party's financial data.

If the task is a read-only report over already-masked, non-sensitive data you may not
need it — but if in doubt, load it. **Fast = something was skipped.**

---

## Logging — what goes where

In a database the "logs" are not just application logs: the engine itself produces the
**general query log**, the **slow query log**, the **error log**, the **binary log**
(replication/PITR), and — separately — the **audit log**. Each has a different security
posture. The rule holds: **log the event and the actors, never the secret.**

### Which events, which sink, which level

| Event | Sink | Notes |
|-------|------|-------|
| Connection / disconnect, auth success & failure | Audit log (`audit_log` / `server_audit`) | Who connected, from which host, outcome |
| `SELECT`/`DML` against card/PII tables | Audit log, filtered by table/schema | Who read what — required for PCI access logging |
| DDL (`CREATE`/`ALTER`/`DROP`), `GRANT`/`REVOKE` | Audit log | Privilege and schema changes are high-value audit events |
| Money movement (transfer, charge, reversal) | Application append-only audit store **+** DB audit log | The authoritative business audit record is written by the app in the same transaction (see Workflow) |
| Admin / `root` actions | Audit log + alerting | Privileged access must be reviewable |
| Slow queries | Slow query log (ops only) | Never enable the **general query log** in prod — it records full statement text incl. literals |
| Errors | Error log | Scrub before shipping; can contain query fragments |

### What is MASKED before it reaches any sink

- **PAN** → never log the full PAN. If a PAN must appear in a diagnostic, mask to BIN +
  last 4 (`411111******1111`). A full PAN in a query log is a PCI-DSS violation.
- **CVV / CVC2 / track / PIN** → **never logged and never stored** after authorization.
- **Passwords / secrets / tokens** → never in SQL literals that land in a log. Use
  parameterized queries (bound parameters are not expanded into the general/slow log
  the way inline literals are, and they prevent SQL injection).
- **National ID / TCKN / SSN, full IBAN** → masked or dropped in any diagnostic sink.

> ⚠️ **The general query log is a landmine.** `general_log=ON` records *every statement
> verbatim*, including `AES_ENCRYPT('secret', ...)`, `IDENTIFIED BY 'password'`, and raw
> `WHERE pan = '...'`. **Keep it OFF in production.** The slow query log is less
> dangerous but still records statement text — restrict file permissions and retention.

### What is NEVER logged

Raw PAN, CVV/PIN/track, plaintext passwords, encryption keys/keyring contents,
decrypted column values, full government IDs. If a value belongs in the "Hashing &
encryption" section, it does not belong in any log.

### Structured logging / PII redaction mechanism (DB-side)

The database's own logs are not easily "structured" the way application JSON logs are,
so the controls are different:

- **Audit log format.** MySQL Enterprise Audit (`audit_log`) writes **JSON** (or XML/
  "new" formats) and supports **filters** (`audit_log_filter`) so you log only the
  classes/tables you need — filter *in* connections, DDL, and access to card/PII
  schemas; filter *out* noisy internal traffic. MariaDB's `server_audit` plugin writes
  a delimited text log with event types `CONNECT,QUERY,TABLE` and supports
  `server_audit_incl_users` / `server_audit_excl_users` and
  `server_audit_events` to scope what is captured.
- **Redaction is app-side, not log-side.** The engine will faithfully record whatever
  literal you send it. The reliable defence is to never put secrets in SQL text:
  bind parameters, and encrypt/tokenize sensitive values in the application *before*
  they reach the server (see "Hashing & encryption").

### Log integrity (append-only / WORM / hash chain)

- **Ship audit logs off-box, append-only.** Write the audit log to a file the DB user
  can append to but not rewrite, and forward it to a **WORM** sink (e.g. S3 Object Lock
  in compliance mode, a SIEM with retention lock). Local log files on the DB host are
  not tamper-evident on their own.
- **Protect the binary log.** The binlog is a complete change stream — treat it as
  sensitive (encrypt it, below) and restrict who can read or purge it.
- **Business audit records** (the authoritative "who moved this money") live in an
  **append-only application table or store**, written in the *same transaction* as the
  money movement, and may be **hash-chained** (`hash = SHA-256(prev_hash ||
  canonical_row)`) for tamper evidence. Use SHA-256 — never MD5/SHA-1 for integrity.
- Disabling audit logging on money movement or data access is a hard red line
  ([`refusal-policy.md`](../refusal-policy/SKILL.md) rule 6).

---

## Workflow — payment / transfer / onboarding

The storage-layer backbone for a card charge, a transfer, and a KYC onboarding is the
same: **authorize → validate → idempotency gate → do the work in ONE transaction with
the right lock → write the audit row in that same transaction → commit.** The database
guarantees are what make this safe.

### Step order (transfer / payment)

1. **Authorize at the app layer**, and ensure the DB connection uses a **least-
   privileged role** (below) — the service that posts transfers must not be able to
   `DROP TABLE` or read the keyring.
2. **Validate input** in the app (types, positive amount, ISO-4217 currency) before it
   reaches SQL. Use **bound parameters only** — never string-concatenate values into
   SQL (SQL injection + log leakage).
3. **Idempotency gate.** A unique key column (e.g. `idempotency_key VARCHAR(64) NOT
   NULL UNIQUE`) makes a retried request a duplicate-key error instead of a double
   charge. Check-or-insert the key inside the transaction.
4. **Approval gate** where required (amount over threshold, new payee, PSD2 SCA for EU
   remote payments) — enforced before the money-moving `UPDATE`.
5. **Execute in one transaction** (`START TRANSACTION` / `COMMIT`) on **InnoDB** (never
   MyISAM — MyISAM has no transactions and no row locks, so it must never hold financial
   data). Lock the rows, debit, credit, insert the idempotency row, insert the audit
   row — all atomic.
6. **Commit.** Any error → `ROLLBACK`, so no partial transfer survives.

### Money type

Store money as **`DECIMAL(p,s)`** (e.g. `DECIMAL(19,4)`), or as integer **minor units**
(`BIGINT` cents). **Never `FLOAT`/`DOUBLE`** — binary floats cannot represent `0.10`
exactly and will drift. This is a correctness red line for financial data.

### Concurrency / locking model

InnoDB default isolation is **`REPEATABLE READ`**; `READ COMMITTED` is the common choice
for high-contention ledgers. The lost-update bug (two transfers reading the same balance
and both writing back) is defeated with one of:

- **Pessimistic:** `SELECT ... FOR UPDATE` — acquires an exclusive row lock until commit.
  Lock rows in a **consistent order** (e.g. by `id` ascending) to avoid deadlocks;
  InnoDB detects deadlocks and rolls one transaction back, so the app must be prepared to
  retry.
- **Optimistic:** a `version` column checked in the `WHERE` of the `UPDATE`; if
  `ROW_COUNT() = 0` another transaction won — retry. Best when contention is low.

```sql
-- Transfer: atomic, row-locked, idempotent, audited. InnoDB only.
START TRANSACTION;

-- idempotency gate: duplicate key here means "already processed" -> ROLLBACK + return prior result
INSERT INTO idempotency_keys (idem_key, status) VALUES (?, 'in_progress');

-- lock both accounts in a stable order to avoid deadlocks
SELECT id, balance_minor
  FROM accounts
 WHERE id IN (?, ?)
 ORDER BY id
   FOR UPDATE;                               -- pessimistic exclusive lock

-- application checks src.balance_minor >= amount, else ROLLBACK (insufficient funds)

UPDATE accounts SET balance_minor = balance_minor - ? WHERE id = ?;   -- debit src
UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ?;   -- credit dst

-- authoritative business audit row, SAME transaction as the money move
INSERT INTO audit_entries (action, src_id, dst_id, amount_minor, currency, actor, idem_key, created_at)
VALUES ('transfer', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6));

UPDATE idempotency_keys SET status = 'applied' WHERE idem_key = ?;

COMMIT;                                      -- both legs + audit commit together, or none do
```

Because the audit `INSERT` is in the same transaction as the balance `UPDATE`s, it is
**impossible to move money without the matching audit row** — the whole unit commits or
rolls back together.

### Onboarding / KYC variation

Same backbone, different middle: validate identity input → run KYC/AML/sanctions
screening in the app (never skip it — refusal rule 5) → store the **decision + case id**
(not the raw document) → store any required identity document **encrypted** (below) →
gate account activation on a passing decision. The audit row records the decision, not
the document contents.

---

## Hashing & encryption

Two independent layers matter for a database: **at-rest encryption of the files**
(TDE / tablespace encryption — protects stolen disks/backups) and **column/field
encryption of specific sensitive values** (protects against a DB read, a dump, or an
over-privileged account). **TDE alone is not enough for PAN/national-ID** — once the
engine is running, TDE data is transparently decrypted for any authorized query, so a
compromised account or a logged query still sees plaintext. Sensitive fields need
column-level protection *in addition* to TDE.

The dividing line also holds: **one-way hash what you only verify** (passwords);
**two-way encrypt what you must read back** (PAN, IBAN, national ID).

### At-rest: InnoDB tablespace encryption (TDE)

**MySQL (8.0+).** InnoDB data-at-rest encryption uses a **two-tier key architecture**: a
**master key** (held in a keyring) encrypts per-tablespace keys stored in each
tablespace header. Enable with a keyring, then encrypt tablespaces:

```ini
# my.cnf — MySQL 8.0: load a keyring COMPONENT (preferred over legacy plugins)
# keyring configured via the component manifest, then:
[mysqld]
early-plugin-load  = ""                       # components load via manifest, not here
default_table_encryption = ON                 # new tablespaces encrypted by default (8.0.16+)
innodb_redo_log_encrypt  = ON
innodb_undo_log_encrypt  = ON
binlog_encryption        = ON                  # encrypt the binary log too (8.0.14+)
require_secure_transport = ON                  # reject non-TLS connections
```

```sql
ALTER TABLE cardholder_data ENCRYPTION = 'Y';   -- per-table / per-tablespace
ALTER INSTANCE ROTATE INNODB MASTER KEY;        -- rotate the master key
```

> ⚠️ **Keyring choice is a compliance decision.** Oracle states plainly that the
> file-based keyring (`keyring_file` / the `component_keyring_file`) is **NOT a
> regulatory-compliance solution** — PCI, FIPS, etc. require keys to live in a **KMS or
> HSM**. For regulated fintech use a KMS/HSM-backed keyring: **`component_keyring_oci`**,
> **`keyring_aws`**, **HashiCorp Vault**, or **KMIP/HSM** (several of these are MySQL
> Enterprise). `keyring_encrypted_file` is **deprecated as of MySQL 8.0.34**. Never ship
> a plain `keyring_file` to production for card/PII data. The master key must not live on
> the same host, unprotected, as the data it protects.

**MariaDB (10.1+).** Data-at-rest encryption requires an **encryption key-management
plugin**. The built-in **`file_key_management`** plugin reads keys from a (itself-
encrypted) local file — convenient but, like MySQL's file keyring, **not an HSM/KMS and
not appropriate as the sole control for regulated key management**. For compliance use
**`aws_key_management`** or **HashiCorp Vault** integration so the master key lives in a
managed vault/HSM.

```ini
# my.cnf — MariaDB: KMS/Vault-backed key management preferred for fintech
[mysqld]
plugin-load-add        = aws_key_management.so   # (or file_key_management for non-prod)
innodb_encrypt_tables  = FORCE                    # all InnoDB tables must be encrypted
innodb_encrypt_log     = ON                       # redo log
innodb_encrypt_temporary_tables = ON
encrypt_binlog         = ON                       # encrypt binary logs
aria_encrypt_tables    = ON
require_secure_transport = ON
```

> **In-memory caveat (both engines):** TDE encrypts pages on disk; pages in the InnoDB
> **buffer pool are decrypted in memory**. A memory-scraping attacker or an over-
> privileged query is not stopped by TDE — which is exactly why PAN/national-ID also need
> column encryption.

### Column / field encryption — PAN, IBAN, national ID

**Do NOT rely on MySQL's built-in `AES_ENCRYPT()` / `AES_DECRYPT()` for this.** They are
convenient but dangerous by default:

- The default `block_encryption_mode` is **`aes-128-ecb`** — **ECB mode**, which leaks
  structure (identical plaintext blocks → identical ciphertext) and is a crypto red line
  ([`refusal-policy.md`](../refusal-policy/SKILL.md) rule 4). ECB has **no IV**, which
  is *why* people use it for equality lookups — and that equality-preserving property is
  the leak.
- ECB/CBC here provide **no authentication** (no AEAD tag) — ciphertext can be tampered
  with undetected. There is no GCM option in these functions.
- The key is typically passed **as a literal in the SQL statement**, so it lands in the
  general/slow query log and in `SHOW PROCESSLIST` — defeating the point.

```sql
-- ❌ FORBIDDEN for card/PII: ECB default, key in SQL text, no integrity
SET block_encryption_mode = 'aes-128-ecb';          -- ECB — red line
INSERT INTO t (pan) VALUES (AES_ENCRYPT('4111...', 'hardcoded-key'));  -- key in the query log
```

If `AES_ENCRYPT` is used at all (legacy constraint only), it **must** be reconfigured to
a non-ECB mode with a proper key — but even then it is weaker and more error-prone than
application-side AEAD:

```sql
-- least-bad in-DB form: CBC + 256-bit + random IV (still no AEAD integrity, key handling is hard)
SET block_encryption_mode = 'aes-256-cbc';
-- IV must be random per row and stored; key must come from a secret manager, never a literal
```

**The compliant pattern: encrypt in the application with AES-256-GCM + a KMS envelope,
store ciphertext as `VARBINARY`/`BLOB`.** The database stores opaque bytes and never sees
the key or plaintext:

```sql
CREATE TABLE payment_instrument (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT NOT NULL,
  pan_token     VARCHAR(64) NOT NULL,          -- processor/network token — prefer this
  masked_pan    VARCHAR(19) NOT NULL,          -- "411111******1111" for display
  pan_ct        VARBINARY(512) NULL,           -- if you MUST store PAN: AES-256-GCM ciphertext
  pan_nonce     VARBINARY(12)  NULL,           -- 96-bit GCM nonce, unique per encryption
  key_id        VARCHAR(128)   NULL,           -- KMS data-key id/version for rotation
  created_at    DATETIME(6) NOT NULL
) ENGINE=InnoDB ENCRYPTION='Y';                -- TDE on top of column encryption
```

Best of all for PANs: **don't store them.** Tokenize via the processor and keep only the
token + masked PAN ([`global/pci-dss.md`](../pci-dss/SKILL.md)). For IBAN / national ID
you usually must read them back → AES-256-GCM + KMS envelope, same as the Python/Java
skills describe (`AESGCM`, `javax.crypto`, etc. — the *application's* crypto library).
For **blind-equality lookups** without ECB, store a **separate keyed HMAC-SHA-256
"search hash"** of the value in an indexed column and look up by that, keeping the real
value in an authenticated AEAD ciphertext column.

### Hashed one-way — passwords

**Application passwords are hashed in the application, not in the database.** Use
**Argon2id** (OWASP minimum: 19 MiB memory, 2 iterations, 1 parallelism; the library
defaults are usually stronger — see the language skill), **bcrypt** as fallback. Store
the PHC-format hash string in a `VARCHAR(255)` column. **Never** `MD5()`, `SHA1()`,
`SHA2()`, or `PASSWORD()` to hash application user passwords — fast hashes are crackable
at billions/sec and MD5/SHA1 are broken (refusal rules 2 & 4). MySQL's own
`caching_sha2_password` authentication plugin (the 8.0 default, for *DB account* login)
is fine for authenticating database users, but it is not a substitute for Argon2id on
your application's end-user passwords.

### Key management, rotation, forbidden

- Master keys live in a **KMS/HSM-backed keyring/plugin**, never in `keyring_file` alone
  for regulated data, never in source, never in a config file committed to git.
- **Rotate**: `ALTER INSTANCE ROTATE INNODB MASTER KEY` (MySQL) / vault-managed rotation
  (MariaDB); carry a `key_id`/`key_version` per encrypted column so old ciphertext stays
  decryptable and you can re-encrypt lazily.
- **Forbidden (red lines):** `block_encryption_mode` left at **ECB**; encryption keys as
  SQL literals; hardcoded keys/IVs; reused GCM nonces; MyISAM for financial tables;
  `MD5`/`SHA1` for passwords or integrity; disabling TLS cert validation; the
  general query log on in production.

---

## Country differences (how the same schema changes)

The engine features stay the same; the *obligations* around them change. Load the
matching regional skill for specifics.

- **EU — GDPR, PSD2, DORA.** GDPR data minimization + **right to erasure**: design so PII
  can be deleted or **crypto-shredded** (destroy the per-record/KMS key → ciphertext is
  irrecoverable — often the only practical way to "delete" from binary-log/backup
  history). PSD2 **SCA dynamic linking**: the approval gate must bind amount+payee.
  **DORA** (in force since **17 January 2025**): document ICT risk, test resilience, and
  keep a register of ICT third parties — a managed DB/KMS vendor is one.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trails + segregation of duties for
  anything affecting financial reporting (lock down `GRANT`, audit DDL). GLBA: safeguard
  customer financial info — encryption at rest/in transit + access control. CCPA/CPRA:
  access/deletion rights — know which columns hold PII.
- **Turkey — KVKK, BDDK, MASAK.** KVKK: consent + data-subject rights, VERBİS
  registration where applicable. **BDDK may require data localization** — the DB and its
  backups/replicas must sit on infrastructure **in Turkey**; do not default to an
  offshore cloud region, and check replication/backup targets. **MASAK**: AML/
  suspicious-transaction reporting with record retention — the audit store must support
  MASAK-compatible export.
- **UK — FCA, UK GDPR.** FCA operational-resilience and Consumer Duty; UK GDPR mirrors EU
  GDPR; UK SCA tracks PSD2-equivalent rules.

The transfer SQL above is unchanged in logic across regions; what changes is the approval
gate (SCA for EU), the **audit retention period** (commonly 5–7 years), the **data
residency** of the DB/replicas/backups, and which regulator's report the AML decision
feeds. (PCI-DSS v4.0.1 is the assessable version; its future-dated requirements became
mandatory **31 March 2025**.)

---

## Access control — roles & privileges (storage-side, load-bearing)

Least privilege is a storage-side control and belongs here:

- **Use roles** (MySQL 8.0+ and MariaDB 10.0.5+): define `app_read`, `app_write`,
  `ledger_poster` role sets, grant *roles* to service accounts, never broad privileges
  to individuals. `GRANT` cannot mix privileges and roles in one statement.
- **Deny by default.** Never `GRANT ALL`, never `GRANT ... ON *.*`, never grant to
  `'user'@'%'` (any host). The application service account needs only `SELECT, INSERT,
  UPDATE` on its own schema — not `DROP`, not `FILE`, not `SUPER`, not access to the
  `mysql` system schema or the keyring.
- **Separate duties.** The account that runs migrations (DDL) is not the account the app
  runs queries with. The account that reads audit logs cannot modify them.
- **Enforce TLS per account** (`REQUIRE SSL` / `REQUIRE X509`) in addition to the global
  `require_secure_transport=ON`.
- **Lock down admin**: strong auth plugin, account locking on failed attempts
  (`FAILED_LOGIN_ATTEMPTS` / MariaDB equivalents), password-expiry policy.

```sql
-- least-privileged application service account
CREATE ROLE 'app_write';
GRANT SELECT, INSERT, UPDATE ON fintech.* TO 'app_write';     -- no DROP, no DELETE, no mysql.*
CREATE USER 'svc_payments'@'10.0.%' IDENTIFIED BY ?          -- host-scoped, never '%'
  REQUIRE SSL;                                                -- TLS mandatory for this account
GRANT 'app_write' TO 'svc_payments'@'10.0.%';
SET DEFAULT ROLE 'app_write' TO 'svc_payments'@'10.0.%';
```

---

## TLS, audit, masking & binlog — storage-side feature matrix

- **TLS in transit.** `require_secure_transport=ON` rejects any non-encrypted
  connection; enforce TLS 1.2+ (ideally 1.3), valid certificates, and per-account
  `REQUIRE SSL/X509`. Never disable certificate validation on clients
  ([`refusal-policy.md`](../refusal-policy/SKILL.md) rule 8).
- **Audit logging.** *MySQL:* **MySQL Enterprise Audit** (`audit_log` plugin, JSON,
  filterable by `audit_log_filter`) — **Enterprise Edition only**; MySQL Community has no
  first-class audit plugin (people substitute `server_audit` from Percona/MariaDB or the
  general log, which is unsuitable for prod). *MariaDB:* the **MariaDB Audit Plugin**
  (`server_audit`) is included and free — configure `server_audit_events =
  CONNECT,QUERY,TABLE` and restrict/rotate the log file.
- **Data masking.** *MySQL:* **MySQL Enterprise Data Masking and De-Identification**
  (masking/generation functions, and components in newer releases) — **Enterprise Edition
  only**. *MariaDB Community has no built-in dynamic data masking* (MaxScale offers a
  masking filter in front of the server); otherwise mask in the application. Do not
  assume column-level dynamic masking exists on Community/MariaDB.
- **Binary log security.** The binlog is a full change stream (great for PITR/replication,
  dangerous if leaked). **Encrypt it** (`binlog_encryption=ON` MySQL 8.0.14+ /
  `encrypt_binlog=ON` MariaDB), transmit replication over **TLS**, restrict read access
  and purge policy, and set a retention (`binlog_expire_logs_seconds`) consistent with
  your regulatory retention — long enough for recovery, not so long it becomes an
  unmanaged PII hoard. Note: binlog encryption protects stored events, **not** their
  network transmission — that still needs TLS.
- **Backups.** Encrypt backups with the same rigor as the live data (stolen backups are
  the classic breach); store backup encryption keys in the KMS/HSM, not beside the backup.

---

## Good example

Idiomatic, defensible MySQL/MariaDB for a regulated ledger: InnoDB + TDE, `DECIMAL`/minor
units, least-privileged role, parameterized SQL, atomic + audited + idempotent transfer,
no secrets or PAN in the DB, no ECB.

```sql
-- schema: encrypted tablespace, money as minor units, no raw PAN stored
CREATE TABLE accounts (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  owner_id      BIGINT NOT NULL,
  balance_minor BIGINT NOT NULL DEFAULT 0,          -- integer cents, never FLOAT
  currency      CHAR(3) NOT NULL,                   -- ISO-4217
  version       BIGINT NOT NULL DEFAULT 0           -- optional optimistic lock
) ENGINE=InnoDB ENCRYPTION='Y';                     -- TDE; keyring is KMS/HSM-backed

CREATE TABLE audit_entries (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  action      VARCHAR(32) NOT NULL,
  src_id      BIGINT, dst_id BIGINT,
  amount_minor BIGINT NOT NULL,
  currency    CHAR(3) NOT NULL,
  actor       VARCHAR(128) NOT NULL,
  idem_key    VARCHAR(64) NOT NULL,
  prev_hash   CHAR(64), row_hash CHAR(64),          -- optional SHA-256 hash chain
  created_at  DATETIME(6) NOT NULL
) ENGINE=InnoDB ENCRYPTION='Y';

CREATE TABLE idempotency_keys (
  idem_key VARCHAR(64) PRIMARY KEY,                 -- UNIQUE -> retries can't double-post
  status   VARCHAR(16) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
) ENGINE=InnoDB;
```

```sql
-- the money move: one transaction, row locks, idempotent, audited (params bound by the app)
START TRANSACTION;
  INSERT INTO idempotency_keys (idem_key, status) VALUES (:idem, 'in_progress');  -- dup -> rollback
  SELECT id, balance_minor FROM accounts WHERE id IN (:src, :dst) ORDER BY id FOR UPDATE;
  -- app verifies src balance >= amount, else ROLLBACK
  UPDATE accounts SET balance_minor = balance_minor - :amt WHERE id = :src;
  UPDATE accounts SET balance_minor = balance_minor + :amt WHERE id = :dst;
  INSERT INTO audit_entries (action, src_id, dst_id, amount_minor, currency, actor, idem_key, created_at)
    VALUES ('transfer', :src, :dst, :amt, :cur, :actor, :idem, UTC_TIMESTAMP(6));
  UPDATE idempotency_keys SET status = 'applied' WHERE idem_key = :idem;
COMMIT;
```

Why it is defensible: InnoDB (transactions + row locks), TDE on the tablespaces, money in
integer minor units, the audit row committed atomically with the balance change, an
idempotency key that turns a retry into a no-op, **bound parameters** (no injection, no
literal leakage into logs), **no PAN/CVV in the schema at all**, and a least-privileged
`REQUIRE SSL` service account connecting over TLS.

## Bad example

```sql
-- ❌ Bad — multiple red lines in one schema + transfer
CREATE TABLE cards (
  pan   VARCHAR(20),                       -- storing raw PAN (PCI red line, refusal rule 1)
  cvv   VARCHAR(4),                         -- storing CVV after auth — forbidden
  pw_md5 CHAR(32)                           -- MD5 "password hash" — broken (rules 2 & 4)
) ENGINE=MyISAM;                            -- MyISAM: no transactions, no row locks

SET block_encryption_mode = 'aes-128-ecb'; -- ECB mode — crypto red line (rule 4)
INSERT INTO cards VALUES (
  AES_ENCRYPT('4111111111111111','hardcoded-key'),   -- key as SQL literal -> lands in query log
  '123',                                              -- CVV stored
  MD5('hunter2')                                      -- MD5 hash
);

-- transfer with no transaction, no lock, float money, no audit, no idempotency
UPDATE accounts SET balance = balance - 19.99 WHERE id = 1;   -- FLOAT drift, lost-update race
UPDATE accounts SET balance = balance + 19.99 WHERE id = 2;   -- separate stmts: partial failure possible
-- (no audit row written at all — money moves invisibly, rule 6)
```

**The red lines it crosses:** stores raw PAN and CVV (PCI-DSS, refusal rule 1); "hashes"
a password with MD5 (rules 2 & 4); uses **ECB** with a **hardcoded key passed as a SQL
literal** that the query log will capture (rules 4 & 7); puts financial data in **MyISAM**
(no transactions, no row locks); uses `FLOAT`-style money (rounding drift); and moves
funds in two unlocked, un-transactioned statements with **no idempotency and no audit
record** (rule 6 — bypassing audit on money movement). An agent asked to write this must
**refuse** per [`refusal/refusal-policy.md`](../refusal-policy/SKILL.md) and offer the
compliant InnoDB + TDE + tokenize + AES-256-GCM + atomic-audited-transfer pattern above.


<!-- fcs-managed-hash:6cacf7dbc0a20cf6 -->
