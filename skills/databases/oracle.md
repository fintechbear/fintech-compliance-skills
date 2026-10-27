# Skill: Oracle Database for Regulated Fintech

**Configure storage-side controls for an Oracle Database core-banking schema: TDE at-rest encryption with an externally managed keystore, on-demand `DBMS_CRYPTO` column encryption for the few fields that need application-layer control, Virtual Private Database / Database Vault access control, Unified + Fine-Grained Auditing on money and data access, and Data Redaction for display masking.** Load this skill whenever the task touches an Oracle schema holding accounts, cards, IBANs, national IDs, balances, or audit trails, or whenever you write PL/SQL that encrypts, hashes, audits, or restricts access to that data.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Oracle-specific *how* for the storage tier; the refusal policy defines the red lines that override everything here. Oracle Advanced Security (TDE + Data Redaction), Database Vault, and Label Security are **separately licensed options** — confirm licensing before relying on them, and note it in the design.

## When to use

- A core-banking, ledger, payments, cards, or onboarding (KYC) schema on Oracle Database **19c (LTS), 21c, or 23ai**, on-prem or on Exadata/Autonomous.
- Any table storing PAN (only if you are PCI-scoped and genuinely must retain it), IBAN, national ID (TCKN/SSN), customer PII, credentials, or money balances.
- PL/SQL that encrypts/decrypts, hashes, audits, redacts, or enforces row/column access.
- Designing the **at-rest** story: which tablespaces are TDE-encrypted, where the master key lives, how keys rotate, who can see cleartext.
- Producing a regulator-grade audit trail (PCI-DSS v4.0.1 Req. 10, SOX, GLBA, DORA, KVKK/BDDK) from inside the database engine.

If the application tier is Java/Python/.NET/Go, also load that language skill — password hashing (Argon2id) and envelope encryption usually belong in the app, not in PL/SQL.

## Logging — what goes where

In Oracle the "log" that regulators care about is the **audit trail**, not the alert log. Use **Unified Auditing** as the single, tamper-resistant sink; use **Fine-Grained Auditing (FGA)** for value/column-conditional capture; never roll your own audit table written by application triggers as the *only* control.

**Which events, which sink, which mechanism**

| Event | Mechanism | Sink |
|---|---|---|
| Logon/logoff, failed logons, privilege/role grants, `ALTER USER` | Unified audit policy (`AUDIT POLICY`) | `UNIFIED_AUDIT_TRAIL` |
| DDL on ledger/audit/key objects, `GRANT`/`REVOKE` | Unified audit policy | `UNIFIED_AUDIT_TRAIL` |
| Any `SELECT`/DML touching a PAN/national-ID column | FGA policy (`DBMS_FGA.ADD_POLICY`) with `audit_column` | `UNIFIED_AUDIT_TRAIL` |
| Money movement (transfer/debit/credit/reversal) | Unified policy on the ledger table **+** an append-only ledger row written in the same transaction | both |
| Access to `DBMS_CRYPTO`, TDE keystore ops, Database Vault config | Unified audit policy (mandatorily audited for some) | `UNIFIED_AUDIT_TRAIL` |
| Redaction policy changes, VPD policy changes | Unified audit policy | `UNIFIED_AUDIT_TRAIL` |

> **Version note:** *Traditional* auditing (`AUDIT ...` statement auditing writing to `SYS.AUD$`/`FGA_LOG$`, and `AUDIT_TRAIL` init parameter) was **deprecated in Oracle Database 19c** and is slated for de-support. New installs are in **mixed-mode**; migrate to **pure unified auditing** (verified via `V$OPTION` where `PARAMETER = 'Unified Auditing'` is `TRUE`). Write all new policies as unified policies. ([Oracle 19c Introduction to Auditing](https://docs.oracle.com/en/database/oracle/oracle-database/21/dbseg/introduction-to-auditing.html), [MOS 2909718.1](https://support.oracle.com/knowledge/Oracle%20Database%20Products/2909718_1.html))

```sql
-- Unified audit policy: money-movement DML on the ledger, plus all privileged access
CREATE AUDIT POLICY ledger_money_movement
  ACTIONS INSERT, UPDATE, DELETE ON core.ledger_entry,
          UPDATE ON core.account;
AUDIT POLICY ledger_money_movement;            -- enable (optionally BY <user> / WHENEVER NOT SUCCESSFUL)

-- Audit every logon and every use of a system privilege by anyone
CREATE AUDIT POLICY sec_baseline
  PRIVILEGES SELECT ANY TABLE, ALTER USER, CREATE USER, DROP USER, GRANT ANY ROLE
  ACTIONS LOGON, LOGOFF;
AUDIT POLICY sec_baseline;
```

```sql
-- Fine-Grained Auditing: record WHO read a PAN, and the exact predicate, value-based
BEGIN
  DBMS_FGA.ADD_POLICY(
    object_schema   => 'CORE',
    object_name     => 'CARD',
    policy_name      => 'FGA_PAN_READ',
    audit_column    => 'PAN_ENCRYPTED, PAN_LAST4',
    audit_condition => NULL,                  -- NULL = always, for the named columns
    statement_types => 'SELECT,UPDATE,DELETE',
    audit_column_opts => DBMS_FGA.ANY_COLUMNS);
END;
/
```

**What is MASKED before a human or a low-privilege app sees it** — PAN (expose at most first 6 + last 4), national ID, IBAN, DOB, CVV (never — it must not be stored at all). Enforce display masking with **Data Redaction** (see Hashing & encryption), *not* by trusting the application to mask. Redaction is the safety net at the SQL boundary; the app should also never select the cleartext it does not need.

**What is NEVER written to any audit trail, trace, or `DBMS_OUTPUT`:** CVV/CVC, full PAN, full track/PIN, plaintext passwords or verifier hashes, TDE master keys or `DBMS_CRYPTO` data keys, full national IDs. Beware: `FGA` can capture the **SQL text and bind values** of audited statements — if a developer passes a PAN as a literal in a `WHERE` clause it lands in the audit trail. Bind sensitive predicates and keep cleartext out of SQL literals. (Refusal FCS-PAN-001/FCS-SAD-001/FCS-LOG-001.)

**Log integrity / append-only:** the unified audit trail is stored in the `AUDSYS` schema, which **cannot be modified by normal DML even by DBAs** — that is its tamper-evidence. Harden it further:

- Grant `AUDIT_ADMIN` / `AUDIT_VIEWER` only to a dedicated security role, **not** to the application or the schema-owning DBA (separation of duty).
- Protect `AUDSYS` and the audit-management packages with an **Oracle Database Vault** realm so even `SYSDBA` cannot purge or alter audit records without a logged authorization.
- Manage retention/archival with `DBMS_AUDIT_MGMT` (scheduled `CLEAN_AUDIT_TRAIL` to a WORM archive), never ad-hoc `DELETE`.
- Sync host clocks via NTP so audit timestamps (stored UTC in `UNIFIED_AUDIT_TRAIL`) are trustworthy. PCI-DSS v4.0.1 Req. 10 and SOX both require this.

## Workflow — payment / transfer / onboarding

Oracle gives you the transaction and locking primitives; the storage tier's job is atomic ledger + audit and correct concurrency.

Canonical money-movement order inside a PL/SQL transaction:

1. **Authenticate & authorize** — identify the caller (`SYS_CONTEXT('USERENV','SESSION_USER')`, or app user via `DBMS_SESSION.SET_IDENTIFIER` / `CLIENT_IDENTIFIER`). Enforce row access with **VPD** so a caller can only touch accounts they own. Fail closed.
2. **Validate** — amounts as `NUMBER` (never `BINARY_FLOAT`/`BINARY_DOUBLE` for money — binary floats cannot represent decimal cents exactly), explicit currency, positive amount, known accounts.
3. **Idempotency gate** — a `transfer_request` table with a `UNIQUE` constraint on the client idempotency key; insert it first in the same transaction so a concurrent retry raises `DUP_VAL_ON_INDEX` instead of double-spending.
4. **Approval / AML gates** — maker-checker, limit thresholds, sanctions/AML (MASAK/OFAC) hold **before** funds move. Onboarding: KYC/sanctions must pass before the account is usable (FCS-AML-001).
5. **Execute in one transaction** — lock the involved account rows with `SELECT ... FOR UPDATE` in a **deterministic order** (e.g. ascending account id) to avoid deadlocks; debit, credit, insert ledger rows, write the audit record, then `COMMIT`. Everything commits or everything rolls back. Do **not** use an `AUTONOMOUS_TRANSACTION` for the business audit record — it would persist even if the transfer rolls back (acceptable only for a separate security/error log, never for the money ledger).
6. **Audit record** — Unified Auditing captures the DML automatically; additionally write an append-only business ledger row (actor, action, UTC time, source, dest, amount+currency, idempotency key, pre/post balances).
7. **Notify** — only after commit.

**Concurrency / locking model (Oracle specifics):**

- Oracle uses **multiversion read consistency**: readers never block writers and writers never block readers. Default isolation is **`READ COMMITTED`**; each statement sees a consistent snapshot. A lost update is therefore *not* prevented by default for read-modify-write on a balance — you must lock.
- **Pessimistic (correct for hot balance rows):** `SELECT balance INTO v FROM account WHERE id = :id FOR UPDATE;` takes a row lock until commit. Add `FOR UPDATE WAIT 3` (or `NOWAIT`) so a contended transfer fails fast instead of hanging; `SKIP LOCKED` is for queue-draining patterns, not balances.
- **Optimistic:** keep a `version NUMBER` column and `UPDATE ... SET balance = :new, version = version + 1 WHERE id = :id AND version = :old`; if `SQL%ROWCOUNT = 0`, someone else won — re-read and retry.
- **`SERIALIZABLE`** isolation is available for the strictest ledger invariants but can raise `ORA-08177: can't serialize access`; the app must catch and retry. Prefer explicit `FOR UPDATE` locking for balances over relying on `SERIALIZABLE`.
- Never do money math in `READ UNCOMMITTED` — Oracle does not even offer dirty reads, which is the right default.

## Hashing & encryption

Decide per field: **hash one-way** (you only verify), **two-way encrypt** (you must recover), or **don't store at all** (tokenize). The storage tier offers two encryption layers that solve different threats — use both.

### At-rest, transparent: TDE (threat = stolen datafiles/backups/disks)

**Transparent Data Encryption** encrypts datafiles, redo, undo, and backups on disk; it is invisible to SQL and defeats theft of the physical files. It does **not** protect against a logged-in user with `SELECT` — that is what VPD/Vault/Redaction are for.

- **Tablespace encryption** (preferred for fintech): encrypt an entire application tablespace; no per-column decisions, indexes/constraints/foreign keys work unchanged, encrypt/decrypt happens at the I/O layer. Put all sensitive tables in TDE-encrypted tablespaces.
- **Column encryption:** encrypts specific columns at the SQL layer; use only when a tablespace move is impractical. **Never encrypt a column and also its tablespace** — double encryption hurts performance with no added protection.
- **Algorithm:** set **AES256** as the default *before* creating the keystore, or the default stays **AES128**:

```sql
-- One-time, before CREATE KEYSTORE, else default remains AES128
ALTER SYSTEM SET "_tablespace_encryption_default_algorithm" = 'AES256' SCOPE = SPFILE;  -- (version-dependent; or specify ENCRYPT ... USING 'AES256')
```

```sql
-- Modern keystore setup (19c+): WALLET_ROOT + TDE_CONFIGURATION.
-- ENCRYPTION_WALLET_LOCATION (sqlnet.ora) is DEPRECATED since 18c/19c — do not use it.
ALTER SYSTEM SET WALLET_ROOT = '/etc/oracle/wallets/${ORACLE_SID}' SCOPE = SPFILE;  -- then restart
ALTER SYSTEM SET TDE_CONFIGURATION = "KEYSTORE_CONFIGURATION=FILE" SCOPE = BOTH;    -- or HSM / OKV

ADMINISTER KEY MANAGEMENT CREATE KEYSTORE IDENTIFIED BY "<strong-wallet-pw-from-vault>";
ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY "<pw>";
ADMINISTER KEY MANAGEMENT SET KEY IDENTIFIED BY "<pw>" WITH BACKUP;                 -- creates/activates the master key

-- Encrypt a tablespace with AES256
CREATE TABLESPACE core_sensitive DATAFILE '...' SIZE 1G ENCRYPTION USING 'AES256' DEFAULT STORAGE(ENCRYPT);
```

**Key management:**
- The **TDE master key** lives in the keystore (wallet), *outside* the datafiles. For regulated fintech use an **HSM / Oracle Key Vault (OKV)** keystore, not just a local file wallet — it gives central rotation, access control, and audit of the master key.
- Prefer a **password-protected keystore** that must be opened after restart over a blind **auto-login** wallet for sensitive systems; an auto-login wallet on the same host as the datafiles weakens the theft protection. If auto-login is operationally required, use a **local auto-login** wallet (bound to the host).
- **Rotate** the master key with `ADMINISTER KEY MANAGEMENT SET KEY ... WITH BACKUP` on a schedule; TDE re-wraps the table/tablespace keys without re-encrypting all data. Keep the old key available to read existing backups.
- **Back up the keystore separately** from the database — losing the master key means the ciphertext is unrecoverable (which is exactly the property you exploit for crypto-shredding on GDPR/KVKK erasure).

### On-demand, application-controlled: `DBMS_CRYPTO` (threat = a privileged DB reader)

TDE is transparent — any user with `SELECT` sees cleartext. For the few fields that must stay ciphertext even to a DBA (e.g. a retained PAN, a national ID), encrypt in PL/SQL with `DBMS_CRYPTO` and keep the key **outside** the database (app tier / KMS), so the DBA never holds both ciphertext and key.

- **Use AES-256 in an authenticated mode.** `DBMS_CRYPTO` supports **GCM** (constant `DBMS_CRYPTO.AES_GCM_NONE`), which produces an authentication **tag** and supports additional authenticated data (AAD) — altered ciphertext fails to decrypt instead of returning garbage. Prefer GCM; if constrained to CBC (`AES_CBC_PKCS5`), you must add a separate HMAC (`DBMS_CRYPTO.MAC` with `HMAC_SH256`) — encrypt-then-MAC.
- **IV:** generate a fresh random IV per encryption with `DBMS_CRYPTO.RANDOMBYTES`; never reuse an IV with the same key (fatal for GCM). Store IV (and GCM tag) alongside the ciphertext — they are not secret.
- **Keys:** fetch the data key from the app/KMS at call time; do not store it in a table, a package constant, or `V$`-visible state.

```sql
-- AES-256-GCM authenticated encryption with DBMS_CRYPTO (Oracle 19c+ for GCM)
CREATE OR REPLACE FUNCTION encrypt_pan(p_plain  IN RAW,
                                       p_key    IN RAW,   -- 256-bit key from KMS, never stored here
                                       p_iv     OUT RAW,
                                       p_aad    IN RAW)   -- e.g. account_id, binds context
RETURN RAW IS
  l_scheme PLS_INTEGER := DBMS_CRYPTO.ENCRYPT_AES256 + DBMS_CRYPTO.CHAIN_GCM + DBMS_CRYPTO.PAD_NONE;
BEGIN
  p_iv := DBMS_CRYPTO.RANDOMBYTES(12);                   -- 96-bit IV, unique per message
  RETURN DBMS_CRYPTO.ENCRYPT(src => p_plain, typ => l_scheme, key => p_key, iv => p_iv, aad => p_aad);
END;
/
```

### Hashed one-way (passwords)

- **Do not design password storage in the database.** Oracle's own user passwords are handled by the DB's verifier (`SHA-2`-based, configured by `SQLNET.ALLOWED_LOGON_VERSION_SERVER = 12a`); you do not implement that.
- For *application* user passwords, hash in the **application tier** with **Argon2id** (OWASP: m ≥ 19 MiB, t = 2, p = 1), bcrypt as fallback — store only the resulting hash string in a column. `DBMS_CRYPTO.HASH` offers only `SHA-256/384/512`, which are **too fast for passwords** — use them for data integrity/HMAC, never for password storage.
- **Forbidden (refusal FCS-SECRET-001/FCS-CRYPTO-001):** storing passwords reversibly, MD5/SHA-1 for integrity, `DBMS_CRYPTO.HASH(..., HASH_MD5)` or `HASH_SH1`, DES/3DES, ECB/`CHAIN_ECB`, hardcoded keys or IVs, reusing an IV, home-rolled crypto, floating-point money.

### Access control above TDE (threat = an authorized-but-over-scoped user)

TDE alone does not stop a logged-in user reading cleartext. Layer:

- **Virtual Private Database (VPD)** — `DBMS_RLS.ADD_POLICY` attaches a policy function returning a predicate that Oracle **appends as a `WHERE` clause** to every `SELECT`/`INSERT`/`UPDATE`/`DELETE`, so a user sees only their own rows. The right tool for row-level ownership (customer sees only their accounts).

```sql
CREATE OR REPLACE FUNCTION own_accounts(p_schema VARCHAR2, p_obj VARCHAR2) RETURN VARCHAR2 IS
BEGIN
  RETURN 'customer_id = SYS_CONTEXT(''app_ctx'',''customer_id'')';
END;
/
BEGIN
  DBMS_RLS.ADD_POLICY(object_schema => 'CORE', object_name => 'ACCOUNT',
    policy_name => 'VPD_OWN_ACCOUNTS', function_schema => 'CORE',
    policy_function => 'OWN_ACCOUNTS', statement_types => 'SELECT,UPDATE,DELETE');
END;
/
```

- **Oracle Database Vault** — realms, command rules, and factors that stop even `SYSDBA`/`DBA` from reading application data or disabling audit/VPD without a logged, authorized exception. This is how you enforce **separation of duty** (the DBA administers, but cannot read customer data) required by SOX/GLBA/DORA. Protect the ledger, PII tables, `AUDSYS`, and the TDE keystore operations with realms.
- **Oracle Label Security (OLS)** — row-level classification labels (e.g. confidentiality tiers) enforced by the engine; use when data has a true multi-level classification model rather than simple ownership.
- **Oracle Data Redaction** — `DBMS_REDACT.ADD_POLICY` masks column output **at query time** for low-privileged users without changing stored data. Use **partial** redaction for a PAN (show last 4), **full** for CVV-adjacent fields, **regexp** for variable-length strings like email. Redaction is a display control, **not** a security boundary on its own — it can be bypassed by someone who can run arbitrary SQL/expressions, so pair it with VPD/least-privilege.

```sql
BEGIN
  DBMS_REDACT.ADD_POLICY(
    object_schema => 'CORE', object_name => 'CARD', column_name => 'PAN_LAST4',
    policy_name => 'REDACT_PAN', function_type => DBMS_REDACT.PARTIAL,
    function_parameters => 'VVVVVVVVVVVVFFFF,VVVV-VVVV-VVVV-,*,1,12',   -- show last 4
    expression => 'SYS_CONTEXT(''SYS_SESSION_ROLES'',''PCI_CLEARTEXT'') IS NULL');  -- exempt only PCI role
END;
/
```

## Country differences (how the same schema changes)

- **EU — GDPR, PSD2, DORA.** GDPR erasure: design PII for **crypto-shredding** — put a customer's PII under a per-customer `DBMS_CRYPTO` key (or a Label/partition) so dropping the key renders it unrecoverable without a full purge. DORA (in force Jan 2025): ICT resilience — your TDE keystore backup/restore, audit retention, and recovery must be tested. PSD2 SCA lives in the app tier, but the audit of strong-auth events belongs in the unified trail.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + **separation of duty** — enforce with Database Vault so the DBA who runs the ledger cannot alter it or the audit records. GLBA Safeguards: encryption at rest (TDE) + access logging (FGA on PII reads). CCPA/CPRA deletion: same crypto-shred design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK ≈ GDPR for personal data + explicit consent. **BDDK data localization**: Turkish banking data must reside **in Turkey** — the datafiles, the TDE keystore/OKV, and all backups must be in-region; make residency a deploy boundary, not a hardcoded assumption. MASAK: AML/suspicious-transaction reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits): store encrypted (`DBMS_CRYPTO` or TDE column), redact in output, validate the checksum.
- **UK — FCA, UK GDPR, PRA.** UK GDPR mirrors EU post-Brexit; SCA still applies under UK PSRs. Same TDE + redaction + crypto-shred machinery, different reporting endpoints and retention windows (hold the unified audit trail for the regulator's required period before `DBMS_AUDIT_MGMT` archival).

Keep region as **configuration** (a context/factor, a per-tenant policy), not `IF country = ...` scattered through PL/SQL.

## Good example

```sql
-- Storage-side done right: TDE tablespace + DBMS_CRYPTO PAN + VPD + Unified/FGA audit + redaction.
-- Sensitive tables live in an AES256 TDE tablespace (datafiles/backups encrypted at rest).
CREATE TABLE core.account (
  id           NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  NUMBER         NOT NULL,
  balance      NUMBER(20,4)   NOT NULL,          -- NUMBER, never BINARY_DOUBLE, for money
  currency     CHAR(3)        NOT NULL,
  version      NUMBER         DEFAULT 0 NOT NULL  -- optimistic lock token
) TABLESPACE core_sensitive;                      -- TDE-encrypted tablespace

-- Atomic, deadlock-safe transfer with append-only audit row
CREATE OR REPLACE PROCEDURE transfer(p_src NUMBER, p_dst NUMBER,
                                     p_amt NUMBER, p_ccy CHAR, p_idem VARCHAR2) IS
  v_src_bal NUMBER; v_actor VARCHAR2(128) := SYS_CONTEXT('USERENV','SESSION_USER');
BEGIN
  IF p_amt <= 0 THEN RAISE_APPLICATION_ERROR(-20001,'amount must be positive'); END IF;

  INSERT INTO core.transfer_request(idem_key) VALUES (p_idem);  -- UNIQUE: retry collides, no double-spend

  -- Lock both rows in deterministic order (lowest id first) to avoid deadlock; fail fast
  IF p_src < p_dst THEN
    SELECT balance INTO v_src_bal FROM core.account WHERE id = p_src FOR UPDATE WAIT 3;
    PERFORM_LOCK(p_dst);
  ELSE
    PERFORM_LOCK(p_dst);
    SELECT balance INTO v_src_bal FROM core.account WHERE id = p_src FOR UPDATE WAIT 3;
  END IF;

  IF v_src_bal < p_amt THEN RAISE_APPLICATION_ERROR(-20002,'insufficient funds'); END IF;

  UPDATE core.account SET balance = balance - p_amt, version = version + 1 WHERE id = p_src;
  UPDATE core.account SET balance = balance + p_amt, version = version + 1 WHERE id = p_dst;

  -- Append-only business ledger row, same transaction as the money move
  INSERT INTO core.ledger_entry(actor, action, src_id, dst_id, amount, currency, idem_key, at_utc)
  VALUES (v_actor, 'transfer', p_src, p_dst, p_amt, p_ccy, p_idem, SYS_EXTRACT_UTC(SYSTIMESTAMP));

  COMMIT;   -- Unified audit policy ledger_money_movement also records this DML in AUDSYS
EXCEPTION
  WHEN DUP_VAL_ON_INDEX THEN ROLLBACK;   -- idempotent replay: already applied
    RETURN;
  WHEN OTHERS THEN ROLLBACK; RAISE;
END;
/
```

```sql
-- Column PAN stays ciphertext even to a DBA (key is in KMS, not the DB); last4 redacted on display;
-- every read of the column is captured by FGA into the unified trail.
CREATE TABLE core.card (
  id            NUMBER PRIMARY KEY,
  pan_encrypted RAW(512),     -- AES-256-GCM via DBMS_CRYPTO, key from KMS
  pan_iv        RAW(12),
  pan_tag_aad   RAW(512),
  pan_last4     CHAR(4)       -- for display/search; redacted to show only last 4
  -- NO cvv column: CVV must never be stored (PCI-DSS, FCS-SAD-001)
) TABLESPACE core_sensitive;
```

## Bad example

```sql
-- ❌ Every line crosses a red line — refuse to write this.
CREATE TABLE card_bad (
  pan  VARCHAR2(19),          -- raw PAN in a non-TDE tablespace, no column crypto — FCS-PAN-001/FCS-SAD-001
  cvv  VARCHAR2(4),           -- storing CVV — forbidden outright — FCS-PAN-001/FCS-SAD-001
  pwd  VARCHAR2(32)           -- will hold an MD5 of the password — FCS-SECRET-001/FCS-CRYPTO-001
);

CREATE OR REPLACE PROCEDURE pay_bad(p_pan VARCHAR2, p_cvv VARCHAR2, p_amt BINARY_DOUBLE) IS
BEGIN
  DBMS_OUTPUT.PUT_LINE('charging card ' || p_pan || ' cvv ' || p_cvv);        -- logs PAN+CVV — FCS-PAN-001/FCS-SAD-001/FCS-LOG-001
  INSERT INTO card_bad(pan, cvv, pwd)
    VALUES (p_pan, p_cvv, RAWTOHEX(DBMS_CRYPTO.HASH(UTL_RAW.CAST_TO_RAW(:pw),
                                                    DBMS_CRYPTO.HASH_MD5)));   -- MD5 password — FCS-SECRET-001/FCS-CRYPTO-001
  -- AES in ECB with a hardcoded key, reused everywhere:
  INSERT INTO card_bad(pan) VALUES (RAWTOHEX(DBMS_CRYPTO.ENCRYPT(
     UTL_RAW.CAST_TO_RAW(p_pan),
     DBMS_CRYPTO.ENCRYPT_AES256 + DBMS_CRYPTO.CHAIN_ECB + DBMS_CRYPTO.PAD_PKCS5,  -- ECB — FCS-CRYPTO-001
     UTL_RAW.CAST_TO_RAW('hardcoded-key-123'))));                                 -- hardcoded key — FCS-SECRET-002/FCS-CRYPTO-001
  UPDATE account SET balance = balance - p_amt WHERE id = 1;   -- no lock -> lost update,
  UPDATE account SET balance = balance + p_amt WHERE id = 2;   -- no idempotency, no audit — FCS-AUDIT-001
  COMMIT;
END;
/
```

Red lines crossed: storing/printing PAN & CVV (PCI-DSS, FCS-PAN-001/FCS-SAD-001/FCS-LOG-001), MD5 password (FCS-SECRET-001/FCS-CRYPTO-001), AES-ECB + hardcoded key (FCS-SECRET-002/FCS-CRYPTO-001), `BINARY_DOUBLE` for money (core), no `FOR UPDATE` lock (lost update), no idempotency key, no audit of money movement (FCS-AUDIT-001). The compliant alternative is the *Good example* above: TDE-encrypted tablespace, `DBMS_CRYPTO` AES-256-GCM with a KMS-held key (or tokenize the card via the processor and store none of it), VPD + Database Vault for access, Unified + FGA auditing, and Data Redaction for display. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`global/pci-dss.md`](../global/pci-dss.md).
