---
name: plsql
description: Write regulation-compliant Oracle PL/SQL for core banking and payment systems: injection-proof dynamic SQL, correct in-database encryption with `DBMS_CRYPTO` + TDE, PII-safe masked logging, autonomous-transaction audit trails, and fine-grained auditing.
triggers: plsql, write code, implement, coding
---

# Skill: PL/SQL (Oracle) for Regulated Fintech

**Write regulation-compliant Oracle PL/SQL for core banking and payment systems: injection-proof dynamic SQL, correct in-database encryption with `DBMS_CRYPTO` + TDE, PII-safe masked logging, autonomous-transaction audit trails, and fine-grained auditing.** Load this skill whenever the task is a stored procedure, package, trigger, or view that touches money, accounts, cards, personal data, or authentication inside an Oracle Database (12c / 18c / 19c / 21c / 23ai).

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Oracle/PL&#8203;SQL-specific *how*; the refusal policy defines the red lines that override everything here. If the task is about storage-side controls on the Oracle engine itself (TDE, VPD/RLS, Data Redaction), also load the Oracle entry under `skills/databases/`.

## When to use

- Stored procedures, packages, functions, triggers, or views that move money (transfer, debit, credit, reversal), onboard customers (KYC), or read/write accounts, cards (PAN/CVV), IBANs, or national IDs (TCKN, SSN).
- Any PL/SQL that builds dynamic SQL (`EXECUTE IMMEDIATE`, `OPEN ... FOR`, `DBMS_SQL`) — the primary PL/SQL injection surface.
- In-database encryption/hashing with `DBMS_CRYPTO`, key storage decisions (TDE wallet/keystore), and audit requirements (`DBMS_FGA`, unified auditing, autonomous-transaction audit).
- Code that must produce a tamper-evident audit trail and PII-safe output for regulators (PCI-DSS v4.0.1, GDPR/PSD2/DORA, SOX/GLBA, KVKK/BDDK/MASAK, FCA).

If you are not sure whether the control belongs in the application tier or the database, prefer the application tier for password hashing and envelope-encryption key handling (see below), and the database tier for at-rest encryption (TDE) and value-based auditing.

## Logging — what goes where

PL/SQL has no logback/SLF4J equivalent. In practice fintech PL/SQL logs through one of:

- **An autonomous-transaction logging package** that `INSERT`s a structured row into an append-only table (survives a rollback of the business transaction — this is the point of it, see Workflow).
- **Unified Auditing** (`AUDIT POLICY ...`) and **Fine-Grained Auditing** (`DBMS_FGA`) for *who read/changed what* — written to `UNIFIED_AUDIT_TRAIL` by the kernel, outside the app's reach.
- **`DBMS_APPLICATION_INFO`** / `SYS_CONTEXT('USERENV', ...)` to stamp module, action, client identifier, `host`, `ip_address`, and the real end user (`CLIENT_IDENTIFIER`) onto every record — essential when a connection pool means `USER` is a single technical account.
- Avoid `DBMS_OUTPUT` for anything but ad-hoc debugging: it is buffered, client-pull, and must never carry PII in a regulated system.

**Which events, which sink, which level**

| Event | Where | Notes |
|---|---|---|
| Money movement (transfer, debit, credit, reversal) | App audit table **via autonomous transaction**, append-only | who/what/when/amount/before+after balance; must persist even if the business txn later rolls back |
| Auth success/failure, password change, role/grant change | Unified audit + app audit table | use `AUDIT POLICY` for `LOGON`/`ALTER USER`/`GRANT` |
| `SELECT`/`DML` on sensitive columns (PAN, national ID, balance) | **`DBMS_FGA`** value-based policy -> `UNIFIED_AUDIT_TRAIL` | captures the exact rows/columns touched, with bind values |
| Authorization denial / cross-customer access attempt | App audit table (`WARN`-equivalent) + unified audit | fail closed first, then record |
| Validation rejects of financial input | App log table (`INFO`) | no raw PII in the message |
| Unhandled `OTHERS` / integration failure | App log table (`ERROR`) + alert | log `SQLCODE`, `SQLERRM`, `DBMS_UTILITY.FORMAT_ERROR_BACKTRACE` — not the offending data |

**What is MASKED before it hits any sink** — PAN (store/log only last 4), CVV (**never** — not even masked, it must not exist after authorization), passwords and password hashes, session/JWT/OAuth tokens, API keys, full national IDs (TCKN 11 digits, SSN), IBAN (mask all but last 4). Mask at the point of logging; never pass raw PII into the log call.

A reusable masking helper, and the Oracle-native server-side option (**Data Redaction**, part of Advanced Security) for query-time masking:

```sql
-- Deterministic last-4 masking helper for log messages (defensive net, not the primary control)
CREATE OR REPLACE FUNCTION mask_pan(p_pan IN VARCHAR2) RETURN VARCHAR2 IS
BEGIN
  IF p_pan IS NULL OR LENGTH(p_pan) < 4 THEN
    RETURN '****';
  END IF;
  RETURN LPAD('*', LENGTH(p_pan) - 4, '*') || SUBSTR(p_pan, -4);
END mask_pan;
/

-- Server-side, query-time masking of a column for non-privileged sessions (DBMS_REDACT / Data Redaction)
BEGIN
  DBMS_REDACT.ADD_POLICY(
    object_schema => 'BANK', object_name => 'CUSTOMERS',
    column_name   => 'PAN',
    policy_name   => 'redact_pan',
    function_type => DBMS_REDACT.PARTIAL,
    function_parameters => 'VVVVVVVVVVVVFFFF,VVVV-VVVV-VVVV-VVVV,*,1,12',  -- show last 4
    expression    => '1=1');  -- refine with SYS_CONTEXT to exempt authorized roles
END;
/
```

**What is NEVER logged:** CVV/CVC, full PAN, full track/magstripe/chip data, PIN or PIN block, plaintext passwords or their hashes, private keys, symmetric data keys or TDE master keys, full session/refresh tokens, full national IDs. (Refusal policy rules 1, 3, 4.)

**Log integrity (tamper-evident):** the app audit table must be append-only — grant the application role only `INSERT` (and `SELECT` where needed), never `UPDATE`/`DELETE`; put the table in a schema the app role cannot `ALTER`. Reinforce with a row-hash chain (`row.hash = DBMS_CRYPTO.HASH(prev_hash || canonical_row, DBMS_CRYPTO.HASH_SH256)`) so any edit/delete breaks the chain, and prefer the kernel-written `UNIFIED_AUDIT_TRAIL` (which the app role cannot touch at all) for the authoritative trail. Keep hosts NTP-synced so timestamps are trustworthy, and stamp UTC (`SYSTIMESTAMP AT TIME ZONE 'UTC'`). PCI-DSS v4.0.1 Req. 10 and SOX both require this.

## Workflow — payment / transfer / onboarding

Canonical money-movement step order in a PL/SQL package:

1. **Authenticate & authorize — fail closed.** Confirm the invoking end user (not the pooled technical account) owns/controls the source account. Use `SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER')` (set by the app per request) and enforce via a definer-rights check or **Virtual Private Database (VPD)** predicate. Raise and stop on any doubt.
2. **Validate at the boundary.** Explicit currency; amount as `NUMBER` (Oracle `NUMBER` is exact decimal — **never** `BINARY_FLOAT`/`BINARY_DOUBLE` for money). Reject non-positive amounts. Validate identifiers (TCKN checksum, IBAN mod-97) before use.
3. **Idempotency gate.** Require a client idempotency key; keep an `idempotency_keys` table with a `UNIQUE` constraint. `INSERT` the key first; a duplicate raises `DUP_VAL_ON_INDEX` — catch it and return the stored prior result instead of re-executing. Persist the key in the *same* transaction as the effect so a concurrent retry collides rather than double-spends.
4. **Approval / compliance gates — before funds move.** Maker-checker / dual control and limit thresholds; PSD2 SCA step-up; sanctions/AML/MASAK hold. For onboarding, KYC and sanctions screening must pass before the account is usable (refusal rule 5).
5. **Execute inside ONE transaction.** Lock the account rows with `SELECT ... FOR UPDATE` in a **deterministic order** (e.g. ascending `account_id`) to prevent deadlocks; debit source, credit destination, write ledger rows. Do **not** `COMMIT` mid-procedure; let the caller own the transaction boundary, or commit once at the end. If anything fails, the whole unit rolls back.
6. **Audit record — written so it survives.** The *business* audit row for a *completed* transfer goes in the same transaction as the effect (it must not persist for a transfer that didn't happen, nor be missing for one that did). The *attempt/failure/security* record goes through an **autonomous-transaction** logging call so it persists even when the business transaction rolls back (see Hashing & encryption note on autonomous transactions below).
7. **Notify after commit only** — downstream (Advanced Queuing / event) must never see an uncommitted transfer; enqueue in-transaction so the message is delivered only on commit, or use a post-commit trigger/outbox.

**Concurrency / locking model (Oracle):**

- Oracle uses **multiversion read consistency**: readers never block writers and writers never block readers. The default isolation is `READ COMMITTED`; each statement sees a consistent snapshot. You never need `READ UNCOMMITTED` (Oracle doesn't offer dirty reads) and rarely need `SERIALIZABLE`.
- **Pessimistic locking** is the norm for hot balance rows: `SELECT ... FOR UPDATE` (optionally `WAIT n` or `NOWAIT` to bound blocking) takes a row lock so concurrent writers serialize. Lock all involved accounts in a fixed order to avoid deadlock (`ORA-00060`).
- **Optimistic locking** (version/`ORA_ROWSCN` check in the `UPDATE ... WHERE version = :v`) suits low-contention, read-mostly paths; on 0 rows updated, re-read and retry.

```sql
-- Deterministic lock order prevents ORA-00060 deadlocks on A->B and B->A transfers
CURSOR c_lock(p_id1 NUMBER, p_id2 NUMBER) IS
  SELECT account_id, balance_minor, currency
    FROM accounts
   WHERE account_id IN (p_id1, p_id2)
   ORDER BY account_id          -- fixed order
     FOR UPDATE WAIT 3;         -- bound the wait; raises ORA-30006 on timeout
```

## Hashing & encryption

> **Critical Oracle-specific caveat.** `DBMS_CRYPTO` in mainstream releases (incl. 19c) offers block-cipher chaining modes **CBC, CFB, ECB, OFB only — there is NO GCM mode and no built-in authenticated-encryption primitive.** So you cannot write "AES-256-GCM" purely in PL/SQL the way you can in Java/Go/.NET. Your two defensible options: (a) do authenticated encryption (AES-256-GCM) in the **application tier** and store ciphertext as a `BLOB`/`RAW`, using the database only for at-rest protection (TDE); or (b) if encryption genuinely must happen in-database, use **AES-256-CBC with a random IV *plus* a separate HMAC-SHA-256 over the IV+ciphertext (encrypt-then-MAC)** — never CBC alone, which is unauthenticated and malleable. State which you chose and why.

### Encrypted two-way (data you must recover: PAN*, IBAN, national ID)

> *PAN: the right answer is usually **don't store it** — tokenize via the processor (network token / gateway token). Store CVV **never** (PCI-DSS). Encrypt PAN only if you are a PCI-scoped entity that must retain it.

Two layers, used together:

1. **At-rest, transparent — Transparent Data Encryption (TDE).** This is the Oracle-native answer for "encrypt the stored data." TDE encrypts column or tablespace data in the datafiles; the **TDE master encryption key** lives in a **keystore (software wallet)** *outside* the datafiles, or in an external keystore (**Oracle Key Vault** / **OCI Vault – KMS** / HSM via PKCS#11). Prefer **tablespace encryption** (encrypts everything, including indexes and redo-visible copies) over per-column TDE (which has constraints: no FK on an encrypted column with `SALT`, limited index support). TDE uses AES (AES-256 configurable). TDE protects against media/backup theft; it is **transparent to SQL**, so it does *not* defend against a compromised DB account — combine it with VPD/RLS, redaction, and FGA.

```sql
-- TDE: software keystore + tablespace encryption (19c/21c/23ai syntax)
ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/etc/oracle/wallet' IDENTIFIED BY "<strong-pw>";
ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY "<strong-pw>";
ADMINISTER KEY MANAGEMENT SET KEY IDENTIFIED BY "<strong-pw>" WITH BACKUP;
CREATE TABLESPACE pci_data DATAFILE '...' SIZE 1G ENCRYPTION USING 'AES256' ENCRYPT;
-- Rotate the master key without re-encrypting all data:
ADMINISTER KEY MANAGEMENT SET KEY IDENTIFIED BY "<strong-pw>" WITH BACKUP;
```

Wallet rules: use an **auto-login (local) wallet** only with OS-level protection so the DB can open at startup without a human; keep the wallet off the datafile volume and out of backups of those datafiles; use split-knowledge/strong passwords for the password-based wallet; back the wallet up separately (lose it and the data is unrecoverable — that is the point for media theft, but it means key custody is now your highest-value secret).

2. **Explicit application-level encryption — `DBMS_CRYPTO`** when a single column needs a key the DBA/SYS should not be able to use transparently (defense against the privileged-insider threat that TDE does not address). Encrypt-then-MAC with a data key that comes from a KMS/HSM — **never a hardcoded key**:

```sql
-- AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC). Key material comes from KMS/HSM, passed in; never hardcoded.
FUNCTION encrypt_field(p_plain IN RAW, p_data_key IN RAW, p_mac_key IN RAW) RETURN RAW IS
  l_iv  RAW(16) := DBMS_CRYPTO.RANDOMBYTES(16);            -- unique IV per message, CSPRNG
  l_ct  RAW(32767);
  l_mac RAW(32);
BEGIN
  l_ct := DBMS_CRYPTO.ENCRYPT(
            src => p_plain,
            typ => DBMS_CRYPTO.ENCRYPT_AES256 + DBMS_CRYPTO.CHAIN_CBC + DBMS_CRYPTO.PAD_PKCS5,
            key => p_data_key,
            iv  => l_iv);
  l_mac := DBMS_CRYPTO.MAC(src => UTL_RAW.CONCAT(l_iv, l_ct),
                           typ => DBMS_CRYPTO.HMAC_SH256, key => p_mac_key);
  RETURN UTL_RAW.CONCAT(l_iv, l_mac, l_ct);                 -- IV || MAC || ciphertext
END;
```

- IV: 16 random bytes from `DBMS_CRYPTO.RANDOMBYTES` (CSPRNG) per encryption — **never** a constant or `DBMS_RANDOM` for crypto material. Store the IV with the ciphertext (it is not secret).
- Verify the MAC with a **constant-time** comparison on decrypt, and verify *before* decrypting; reject on mismatch.
- **Key management — envelope encryption:** master key in **Oracle Key Vault / OCI Vault-KMS / HSM**; derive/fetch a per-use data key, use it in-memory, and do not persist the plaintext key. Rotate master keys on schedule and support decrypting old-key data during rotation.

### Hashed one-way (passwords, secrets you only verify)

> **Oracle-specific caveat.** `DBMS_CRYPTO.HASH` offers only `HASH_MD4/MD5/SH1/SH256/SH384/SH512` and `MAC` offers `HMAC_SH256/384/512` — **there is no built-in Argon2, bcrypt, or scrypt.** A single-round SHA-256, even salted, is **not** an acceptable password hash (too fast to brute-force). Therefore:

- **Preferred: hash application-user passwords in the application tier with Argon2id** (OWASP: m ≥ 19 MiB, t = 2, p = 1), storing only the resulting hash in Oracle. This is the recommendation echoed by Oracle practitioners (AskTom / community): keep the password hashing portable and outside the database.
- **If it must be in-database:** use **PBKDF2** — Oracle's own docs describe deriving key material from a password via PBKDF2, and later `DBMS_CRYPTO` exposes a key-derivation path. Use a **random per-user salt** (`DBMS_CRYPTO.RANDOMBYTES`) and a **high iteration count** (OWASP PBKDF2-HMAC-SHA256 ≥ 600,000). A hand-rolled "salt + one SHA-256" is forbidden.
- **Database account passwords** (not app users) are a separate concern: let Oracle manage them with a strong verifier (`SQLNET.ALLOWED_LOGON_VERSION_SERVER=12a`, which uses a salted PBKDF2-based SHA-2 verifier) and a profile-enforced password policy — never store or reimplement these yourself.
- **Forbidden:** MD5, MD4, SHA-1 for passwords or integrity; plain/single-round SHA-2 as a password hash; unsalted or reversible password storage; `DBMS_OBFUSCATION_TOOLKIT` (deprecated for years, **removed in Oracle 21c** — references now fail to compile); DES/3DES/RC4 and ECB mode (deprecated from 21c; MD4/MD5/DES/3DES/RC4 flagged deprecated). (Refusal rules 2, 4.)

### Autonomous transactions for audit (Oracle-specific pattern)

A **`PRAGMA AUTONOMOUS_TRANSACTION`** procedure runs in its own transaction and commits independently of the caller. This is the idiomatic way to guarantee a **failure/attempt audit row survives a rollback** of the business transaction:

```sql
PROCEDURE log_event(p_actor VARCHAR2, p_action VARCHAR2, p_detail CLOB) IS
  PRAGMA AUTONOMOUS_TRANSACTION;                 -- independent txn
BEGIN
  INSERT INTO audit_log(id, actor, action, detail, at_utc)
  VALUES (audit_seq.NEXTVAL, p_actor, p_action, p_detail,
          SYSTIMESTAMP AT TIME ZONE 'UTC');
  COMMIT;                                         -- commits only this row; caller's txn untouched
END log_event;
```

Use it deliberately: for the **completed-transfer** audit row you want it *inside* the business transaction (atomic with the effect); for **attempt/denial/error** records you want the autonomous path so they persist regardless. A common bug is logging the success row autonomously and then having the business txn roll back — leaving an audit row for a transfer that never happened. Match the commit boundary to the semantics.

## Country differences (how the same PL/SQL changes)

Keep these as policy/config (a `region_policy` table or package constants per tenant), not `IF v_country = ...` scattered through business logic.

- **EU — GDPR, PSD2, DORA.** PSD2 **SCA** + dynamic linking: bind the auth to amount+payee — add an SCA step-up gate in the transfer package before funds move. GDPR erasure: design PII for deletion / **crypto-shredding** (drop or rotate-out the per-subject data key so `DBMS_CRYPTO` ciphertext becomes unrecoverable; TDE master-key destruction shreds a whole keystore scope). Data minimization in logs. **DORA** (in force Jan 2025): ICT resilience, incident reporting, tested recovery — your audit/FGA retention and keystore backup/restore drills must satisfy it.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + segregation of duties on financial-reporting paths — lock down who can `UPDATE`/`DELETE` ledger and audit tables (grant the app role `INSERT` only; separate DBA from developer). GLBA Safeguards Rule: encryption of customer financial data at rest (TDE) and in transit (Native Network Encryption / TLS), plus access logging (FGA/unified audit). CCPA/CPRA deletion: same crypto-shred design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (GDPR-like) governs personal-data processing and explicit consent. **BDDK data-localization:** banking data of Turkish customers must be stored/processed **in Turkey** — your Oracle instance, Key Vault/wallet, Data Guard standbys, and backups must be in-region; make data residency a deploy/config boundary. **MASAK:** AML / suspicious-transaction reporting hooks in onboarding and transfer are mandatory. National ID = **TCKN** (11 digits, has a checksum) — treat as encrypted PII, mask in logs, validate the checksum before use.
- **UK — FCA, UK GDPR, PRA.** FCA operational-resilience and reporting; UK GDPR mirrors EU GDPR post-Brexit; SCA still applies under the UK PSRs. Same SCA and PII-deletion machinery as EU, different reporting endpoints/retention periods.

## Injection — bind variables vs. dynamic SQL (the PL/SQL red line)

The dominant PL/SQL vulnerability is SQL injection through concatenated dynamic SQL. Two defenses, applied together:

1. **Bind variables for VALUES.** Never concatenate a user value into SQL text. Static SQL binds automatically; for dynamic SQL use the `USING` clause (`EXECUTE IMMEDIATE ... USING`) or `DBMS_SQL.BIND_VARIABLE`. Binding also prevents shared-pool thrashing.
2. **`DBMS_ASSERT` for IDENTIFIERS.** Table/column/schema names **cannot** be bound. When code must build an identifier from input, validate it with `DBMS_ASSERT` (`SQL_OBJECT_NAME`, `SCHEMA_NAME`, `SIMPLE_SQL_NAME`, `ENQUOTE_NAME`, `ENQUOTE_LITERAL`) so only a legitimate, existing identifier passes. Better still, avoid dynamic identifiers — whitelist to a fixed set.

Also run packages with **invoker's rights (`AUTHID CURRENT_USER`)** where appropriate so injected SQL cannot borrow the definer's elevated privileges, and grant least privilege.

## Good example

```sql
-- Compliant transfer: bound values, deterministic locks, exact NUMBER money,
-- idempotency, atomic ledger+audit, autonomous failure logging, no PII leakage.
CREATE OR REPLACE PACKAGE BODY payments AS

  PROCEDURE transfer(p_actor        IN VARCHAR2,
                     p_src          IN NUMBER,
                     p_dst          IN NUMBER,
                     p_amount_minor IN NUMBER,          -- exact; NEVER BINARY_DOUBLE
                     p_currency     IN VARCHAR2,
                     p_idem_key     IN VARCHAR2,
                     p_result       OUT VARCHAR2) IS
    l_src_bal NUMBER;  l_dst_bal NUMBER;  l_src_cur VARCHAR2(3);
  BEGIN
    -- 1. Validate
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'invalid amount');
    END IF;

    -- 2. Idempotency: unique key insert short-circuits a retry (no double-spend)
    BEGIN
      INSERT INTO idempotency_keys(k, actor, at_utc)
      VALUES (p_idem_key, p_actor, SYSTIMESTAMP AT TIME ZONE 'UTC');   -- bound, UNIQUE(k)
    EXCEPTION
      WHEN DUP_VAL_ON_INDEX THEN
        SELECT result INTO p_result FROM idempotency_keys WHERE k = p_idem_key;  -- bound
        RETURN;
    END;

    -- 3. Lock both rows in fixed order -> no deadlock
    SELECT balance_minor, currency INTO l_src_bal, l_src_cur
      FROM accounts WHERE account_id = LEAST(p_src, p_dst) FOR UPDATE WAIT 3;    -- bound
    SELECT balance_minor INTO l_dst_bal
      FROM accounts WHERE account_id = GREATEST(p_src, p_dst) FOR UPDATE WAIT 3; -- bound

    -- 4. Business checks
    IF l_src_cur <> p_currency THEN RAISE_APPLICATION_ERROR(-20002,'currency mismatch'); END IF;
    IF (SELECT balance_minor FROM accounts WHERE account_id = p_src) < p_amount_minor THEN
      audit.log_event(p_actor,'transfer_denied','insufficient funds');  -- autonomous, survives rollback
      RAISE_APPLICATION_ERROR(-20003,'insufficient funds');
    END IF;

    -- 5. Apply + 6. audit atomically in THIS transaction
    UPDATE accounts SET balance_minor = balance_minor - p_amount_minor WHERE account_id = p_src;
    UPDATE accounts SET balance_minor = balance_minor + p_amount_minor WHERE account_id = p_dst;
    INSERT INTO ledger(id, src, dst, amount_minor, currency, idem_key, at_utc)
      VALUES (ledger_seq.NEXTVAL, p_src, p_dst, p_amount_minor, p_currency, p_idem_key,
              SYSTIMESTAMP AT TIME ZONE 'UTC');
    INSERT INTO audit_money(id, actor, action, src, dst, amount_minor, currency, idem_key, at_utc)
      VALUES (audit_seq.NEXTVAL, p_actor, 'transfer', p_src, p_dst, p_amount_minor, p_currency,
              p_idem_key, SYSTIMESTAMP AT TIME ZONE 'UTC');    -- append-only table (INSERT grant only)

    UPDATE idempotency_keys SET result = 'OK' WHERE k = p_idem_key;
    p_result := 'OK';
    -- caller owns COMMIT; CVV/PAN never touched here; passwords hashed in the app tier (Argon2id)
  END transfer;

  -- Dynamic report over a whitelisted column name: identifier via DBMS_ASSERT, value bound.
  PROCEDURE report(p_sort_col IN VARCHAR2, p_customer IN NUMBER, p_rc OUT SYS_REFCURSOR) IS
    l_col VARCHAR2(128);
  BEGIN
    l_col := DBMS_ASSERT.SIMPLE_SQL_NAME(p_sort_col);     -- validates identifier; else raises
    OPEN p_rc FOR
      'SELECT account_id, balance_minor FROM accounts WHERE customer_id = :c ORDER BY '||l_col
      USING p_customer;                                    -- value BOUND, not concatenated
  END report;

END payments;
/
```

```sql
-- Fine-grained auditing of SELECTs that touch the PAN column (value-based, bind-aware)
BEGIN
  DBMS_FGA.ADD_POLICY(
    object_schema   => 'BANK',
    object_name     => 'CUSTOMERS',
    policy_name     => 'fga_pan_read',
    audit_column    => 'PAN',
    audit_condition => NULL,                 -- audit every access to the column
    statement_types => 'SELECT,UPDATE');     -- -> UNIFIED_AUDIT_TRAIL (SQL_TEXT, SQL_BINDS captured)
END;
/
```

## Bad example

```sql
-- ❌ Nearly every line crosses a red line — refuse to write this.
CREATE OR REPLACE PROCEDURE pay(p_user VARCHAR2, p_pan VARCHAR2,
                                p_cvv VARCHAR2, p_amount BINARY_DOUBLE) IS
  l_sql VARCHAR2(4000);
BEGIN
  -- logs PAN + CVV (rules 1,3) and uses DBMS_OUTPUT for "audit"
  DBMS_OUTPUT.PUT_LINE('charging '||p_pan||' cvv '||p_cvv||' amt '||p_amount);

  -- SQL injection: user value concatenated straight into the statement (no bind)
  l_sql := 'UPDATE accounts SET balance = balance - '||p_amount||
           ' WHERE owner = '''||p_user||'''';
  EXECUTE IMMEDIATE l_sql;                              -- injectable; and BINARY_DOUBLE money

  -- stores CVV (rule 1) and a plaintext / MD5 password (rules 2,4)
  INSERT INTO cards(pan, cvv) VALUES (p_pan, p_cvv);
  UPDATE users SET pwd_md5 = DBMS_CRYPTO.HASH(UTL_RAW.CAST_TO_RAW(p_user),
                                              DBMS_CRYPTO.HASH_MD5)  -- broken hash
   WHERE username = p_user;

  -- AES in ECB with a hardcoded key (rules 4,7)
  INSERT INTO secrets(blob_val) VALUES (
    DBMS_CRYPTO.ENCRYPT(UTL_RAW.CAST_TO_RAW(p_pan),
      DBMS_CRYPTO.ENCRYPT_AES256 + DBMS_CRYPTO.CHAIN_ECB + DBMS_CRYPTO.PAD_PKCS5,
      UTL_RAW.CAST_TO_RAW('hardcoded-key-0123456789abcdef')));
  COMMIT;                                               -- no idempotency, no lock, no real audit (rule 6)
END;
/
```

Red lines crossed: logging PAN & CVV and *storing* CVV (PCI-DSS, rules 1, 3), SQL injection via concatenated dynamic SQL (no bind, no `DBMS_ASSERT`), `BINARY_DOUBLE` for money (core rule — use exact `NUMBER`), MD5 password hash + no salt (rules 2, 4), AES-**ECB** with a **hardcoded key** (rules 4, 7), no idempotency/row lock (lost update), and no tamper-evident audit on money movement (rule 6). The compliant alternatives are the *Good example* above: bound values, `DBMS_ASSERT` for identifiers, exact `NUMBER`, Argon2id/PBKDF2 for passwords, AES-256-CBC+HMAC (or app-tier AES-GCM) with KMS keys, TDE at rest, and an append-only autonomous-transaction audit trail. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md).
