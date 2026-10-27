# Skill: IBM Db2 for Regulated Fintech

**Configure storage-side controls for an IBM Db2 core-banking schema on both platforms it ships on: Db2 for z/OS (mainframe bank core) and Db2 LUW (Linux/UNIX/Windows). Covers at-rest encryption (Db2 native encryption on LUW, z/OS data set encryption / pervasive encryption on the mainframe), two-tier DEK/MK key management with a centralized KMIP/PKCS#11 keystore or ICSF/UKO, the Db2 audit facility (`db2audit` + `AUDIT` on LUW, audit policies in `SYSIBM.SYSAUDITPOLICIES` on z/OS), RACF as the external security manager via the `DSNX@XAC` access-control exit, Row and Column Access Control (RCAC: `CREATE PERMISSION` / `CREATE MASK`), and Label-Based Access Control (LBAC).** Load this skill whenever the task touches a Db2 schema holding accounts, cards, IBANs, national IDs, balances, or audit trails, or whenever you write SQL PL / stored procedures that encrypt, hash, audit, mask, or restrict access to that data.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the Db2-specific *how* for the storage tier; the refusal policy defines the red lines that override everything here. **Platform matters:** Db2 for z/OS and Db2 LUW share SQL and many security concepts but differ sharply in at-rest encryption and in how the external security manager plugs in. Where a mechanism is platform-specific, this file says so — do not assume a z/OS feature exists on LUW or vice versa.

## When to use

- A core-banking, ledger, payments, cards, or onboarding (KYC) schema on **Db2 12 or 13 for z/OS**, or **Db2 11.5 / 12.1 LUW**, on-prem, on IBM Z, or on Db2 on Cloud / Db2 Warehouse.
- Any table storing PAN (only if you are PCI-scoped and genuinely must retain it), IBAN, national ID (TCKN/SSN), customer PII, credentials, or money balances.
- SQL PL stored procedures / triggers that encrypt/decrypt, hash, audit, mask, or enforce row/column access.
- Designing the **at-rest** story: which table spaces / data sets are encrypted, where the master key lives, how keys rotate, who can see cleartext.
- Producing a regulator-grade audit trail (PCI-DSS v4.0.1 Req. 10, SOX, GLBA, DORA, KVKK/BDDK) from inside the database engine.

If the application tier is Java/COBOL/Python/.NET, also load that language skill — password hashing (Argon2id) and application-layer envelope encryption usually belong in the app, not in SQL PL.

## Logging — what goes where

In Db2 the "log" regulators care about is the **audit trail** from the **Db2 audit facility**, not the transaction log (recovery log) or the diagnostic log (`db2diag.log` / z/OS MSTR address-space output). The audit facility is driven by **audit policies**; never roll your own audit table written only by application triggers as the *sole* control.

**Which events, which sink, which mechanism**

| Event | Mechanism (LUW) | Mechanism (z/OS) | Sink |
|---|---|---|---|
| Logon/connect, failed auth | `AUDIT` category `CONTEXT` / `VALIDATE` + the external auth log | Audit policy `CHECKING`/`VALIDATE` categories | Audit log → `db2audit` extract (LUW); SMF type 102 IFCID records (z/OS) |
| Privilege/authority grants, `GRANT`/`REVOKE`, role changes | `SECMAINT` category | `SECMAINT` category | Audit log / SMF |
| DDL on ledger/audit/key objects | `OBJMAINT` category | `OBJMAINT` category | Audit log / SMF |
| Any read/DML touching a PAN / national-ID table | Table-scoped audit policy (`EXECUTE` category) applied with `AUDIT ... USING POLICY` | Audit policy with `EXECUTE` (IFCIDs 143/144/145) on the named table | Audit log / SMF |
| Money movement (transfer/debit/credit) | `EXECUTE` policy on the ledger table **+** an append-only ledger row in the same unit of work | `EXECUTE` audit policy **+** append-only ledger row | both |
| Admin/DBA actions, `SYSADM`/`SECADM` use | `SYSADMIN` category | `SYSADMIN` category | Audit log / SMF |

**Db2 LUW** configures the audit facility at the instance level with the **`db2audit`** tool and at the database level with the **`AUDIT`** SQL statement; audit policies are objects (`CREATE AUDIT POLICY`) attached to a database, table, user, role, or authority with `AUDIT <target> USING POLICY <name>`. Archive and read the binary logs with `db2audit archive` and `db2audit extract` (or `SYSPROC.AUDIT_ARCHIVE` / `AUDIT_LIST_LOGS` / `AUDIT_DELIM_EXTRACT`). ([Db2 audit facility administrator tool command](https://www.ibm.com/docs/en/db2/11.5?topic=commands-db2audit-audit-facility-administrator-tool), [Guidelines about creating audit policies](https://www.ibm.com/docs/en/SS6NHC/com.ibm.swg.im.dashdb.doc/azure/security/audit_policy_guidelines.html))

**Db2 for z/OS** stores audit policies in the catalog table **`SYSIBM.SYSAUDITPOLICIES`**, starts them with `-START TRACE(AUDIT) ... AUDTPLCY(name)`, and writes trace records to **SMF** as **IFCID** records (e.g. 143/144 for changes/reads, 145 for the bind-time SQL text + statement ID under the `EXECUTE` category). ([Audit category](https://www.ibm.com/docs/en/db2-for-zos/11?topic=policy-audit-category), [Db2 audit policies](https://www.ibm.com/docs/en/db2-for-zos/12.0.0?topic=security-audit-policies))

```sql
-- Db2 LUW: audit policy that captures execution on the ledger + all privileged maintenance,
-- then bind it to the ledger table and to the database for the security categories.
CREATE AUDIT POLICY ledger_money_movement
  CATEGORIES EXECUTE STATUS BOTH          -- successful AND failed statements
  ERROR TYPE AUDIT;                        -- AUDIT = if the record can't be written, the statement fails (fail closed)
AUDIT TABLE CORE.LEDGER_ENTRY USING POLICY ledger_money_movement;

CREATE AUDIT POLICY sec_baseline
  CATEGORIES SECMAINT STATUS BOTH,
             OBJMAINT STATUS BOTH,
             SYSADMIN STATUS BOTH,
             CHECKING STATUS FAILURE
  ERROR TYPE NORMAL;
AUDIT DATABASE USING POLICY sec_baseline;
```

```sql
-- Db2 for z/OS: audit policy row in SYSAUDITPOLICIES, EXECUTE category on the card table.
INSERT INTO SYSIBM.SYSAUDITPOLICIES
  (AUDITPOLICYNAME, OBJECTSCHEMA, OBJECTNAME, OBJECTTYPE, EXECUTE)
  VALUES ('PANREAD', 'CORE', 'CARD', 'T', 'C');     -- C = audit changes and reads (IFCID 143/144/145)
-- Start it (DSN command): -START TRACE(AUDIT) DEST(SMF) AUDTPLCY(PANREAD)
```

**What is MASKED before a human or a low-privilege app sees it** — PAN (expose at most first 6 + last 4), national ID, IBAN, DOB, CVV (never — it must not be stored at all). Enforce display masking with an **RCAC column mask** (`CREATE MASK`, see Hashing & encryption), *not* by trusting the application to mask.

**What is NEVER written to any audit trail, SMF record, trace, or diagnostic log:** CVV/CVC, full PAN, full track/PIN, plaintext passwords or verifier hashes, keystore passwords, Data Encryption Keys / Master Keys. Beware: the **`EXECUTE`** category (IFCID 145 on z/OS, `EXECUTE WITH DATA` on LUW) can capture **SQL statement text and host-variable/bind values** of audited statements — if a developer passes a PAN as a literal in a `WHERE` clause, it lands in the audit trail. Bind sensitive predicates as parameter markers and keep cleartext out of SQL literals. (Refusal rules 1, 3, 4.)

**Log integrity / append-only:**

- **z/OS:** route audit records to **SMF**, whose data sets are owned by the OS and protected by RACF, not by Db2 — a Db2 DBA cannot rewrite them. Use **tamper-proof audit policies** (Db2 12 function level **509**, PH33015, and Db2 13): a tamper-proof policy cannot be altered or stopped unless the user is permitted to the policy's profile in an **external** security product (RACF). This enforces separation of duty — the DBA runs the system, but only the z/OS security administrator can disable auditing, and that act is itself logged. ([Function level 509](https://www.ibm.com/docs/en/db2-for-zos/12?topic=levels-function-level-509-ph33015), [Updating or stopping tamper-proof audit policies](https://www.ibm.com/docs/en/db2-for-zos/13.0.0?topic=policies-updating-stopping-tamper-proof-audit))
- **LUW:** audit logs are binary files written by the instance; grant the archive/extract path to a dedicated **`SECADM`** role, not to the application or the DBA (`SECADM` administers security/audit and is deliberately separate from `SYSADM`/`DBADM`). Archive to a WORM/immutable store on a schedule with `db2audit archive`; never hand-delete the active log.
- Sync host clocks (NTP / the z/OS Sysplex Timer / STP) so audit timestamps are trustworthy. PCI-DSS v4.0.1 Req. 10 and SOX both require this.

## Workflow — payment / transfer / onboarding

Db2 gives you the transaction and locking primitives; the storage tier's job is atomic ledger + audit and correct concurrency.

Canonical money-movement order inside a Db2 unit of work (SQL PL procedure):

1. **Authenticate & authorize** — Db2 does **not** authenticate internally in a bank core; authentication is delegated to the OS/external security manager (RACF on z/OS; a plugin or OS on LUW). Identify the caller with `SESSION_USER` / `CURRENT SQLID`. Enforce row access with an **RCAC row permission** so a caller can only touch accounts they own. Fail closed.
2. **Validate** — amounts as `DECIMAL` (never `REAL`/`DOUBLE`/`FLOAT` for money — binary floating point cannot represent decimal cents exactly), explicit currency, positive amount, known accounts.
3. **Idempotency gate** — a `transfer_request` table with a `UNIQUE` constraint (or `PRIMARY KEY`) on the client idempotency key; insert it first in the same unit of work so a concurrent retry raises `SQLSTATE 23505` (duplicate key) instead of double-spending.
4. **Approval / AML gates** — maker-checker, limit thresholds, sanctions/AML (MASAK/OFAC) hold **before** funds move. Onboarding: KYC/sanctions must pass before the account is usable (FCS-AML-001).
5. **Execute in one unit of work** — lock the involved account rows in a **deterministic order** (e.g. ascending account id) to avoid deadlocks; debit, credit, insert ledger rows, then `COMMIT`. Everything commits or everything rolls back. Do not split the money move and its business audit row across separate commits.
6. **Audit record** — the `EXECUTE` audit policy captures the DML automatically; additionally write an append-only business ledger row (actor, action, UTC timestamp, source, dest, amount+currency, idempotency key, pre/post balances).
7. **Notify** — only after commit.

**Concurrency / locking model (Db2 specifics):**

- Db2's default isolation on z/OS is **Cursor Stability (CS)**; on LUW the registry default is also **CS**. The four Db2 isolation levels are **UR** (Uncommitted Read), **CS** (Cursor Stability), **RS** (Read Stability), and **RR** (Repeatable Read). A read-modify-write on a balance under CS is **not** protected from a lost update — you must lock.
- **Pessimistic (correct for hot balance rows):** `SELECT balance INTO :v FROM core.account WHERE id = :id FOR UPDATE WITH RS USE AND KEEP EXCLUSIVE LOCKS;` holds the row lock until commit. On LUW you can bound the wait with `SET CURRENT LOCK TIMEOUT = 3` so a contended transfer fails fast (SQLSTATE 40001/57033) instead of hanging. `SKIP LOCKED DATA` is for queue-draining patterns, not balances.
- **Optimistic:** keep a `version` column (or use Db2's `ROW CHANGE TOKEN` / `RID` optimistic-locking support) and `UPDATE ... SET balance = :new, version = version + 1 WHERE id = :id AND version = :old`; if the update affects 0 rows, someone else won — re-read and retry.
- **`WITH RR`** (serializable) is available for the strictest invariants but takes broader locks and raises deadlock/timeout (SQLSTATE 40001) under contention; the app must catch and retry. Prefer explicit `FOR UPDATE` row locking for balances over blanket RR.
- Never do money math under **UR** (dirty read) — it can read uncommitted balances.

## Hashing & encryption

Decide per field: **hash one-way** (you only verify), **two-way encrypt** (you must recover), or **don't store at all** (tokenize). The storage tier offers a transparent at-rest layer and an application-controlled column layer — they defeat different threats; use both.

### At-rest, transparent (threat = stolen disks / backups / data sets)

**Db2 LUW — Db2 native encryption.** Encrypts the database and its backup images transparently, with **no hardware, schema, or application changes**. It uses a **two-tier key hierarchy**: data is encrypted with a **Data Encryption Key (DEK)**, and the DEK is itself encrypted ("wrapped") by a **Master Key (MK)** that lives in a keystore **external to Db2**. Table-level column encryption is not how you do bulk at-rest on LUW — native encryption encrypts the whole database at the storage layer. ([Overview of Db2 native encryption](https://www.ibm.com/docs/en/db2/11.5?topic=encryption-overview), [Db2 native encryption](https://www.ibm.com/docs/en/db2/11.5?topic=rest-db2-native-encryption))

- **Algorithm:** AES. Create the database with an explicit strength — `ENCRYPT CIPHER AES KEY LENGTH 256` — so you get **AES-256**, not a weaker default; Db2 also supports 3DES only for legacy interop, which you must not choose for new fintech systems.
- **Keystore types (for the MK):** a local **PKCS#12** keystore file, or — required for regulated multi-node / HADR fintech — a **centralized KMIP** key manager or a **PKCS#11 HSM**. A centralized keystore gives central rotation, access control, and audit of the master key, and is the only sane choice when multiple databases/HADR nodes must share keys. ([Configuring native encryption in an HADR environment](https://www.ibm.com/docs/en/db2/11.5?topic=encryption-configuring-native-hadr-environment), [Setting up a centralized KMIP keystore](https://www.ibm.com/docs/en/db2/12.1?topic=keystores-kmip-keystore))

```sh
# Db2 LUW: point the instance at a keystore, then create an encrypted database (AES-256).
db2 update dbm cfg using KEYSTORE_TYPE PKCS12 \
  KEYSTORE_LOCATION /secure/keystore/ks.p12          # or KMIP / PKCS11 for centralized
db2 "CREATE DATABASE BANKCORE ENCRYPT CIPHER AES KEY LENGTH 256"
# Rotate the master key (re-wraps the DEK; data is not re-encrypted):
db2 "ADMIN_ROTATE_MASTER_KEY('new-label')"            # SYSPROC.ADMIN_ROTATE_MASTER_KEY
```

**Db2 for z/OS — z/OS data set encryption (pervasive encryption).** On the mainframe, at-rest encryption is done **below** Db2 by **z/OS data set encryption** (z/OS 2.3+), which encrypts the VSAM data sets backing Db2 table spaces using AES keys managed by **ICSF** (Integrated Cryptographic Service Facility) in a hardware **CEX** crypto card, with key labels protected by **RACF** (`CSFKEYS` class) and the master key held in the **UKO** / crypto hardware. This is transparent to SQL and defeats theft of the DASD/backups. The `-DSN1COPY`/backup data sets inherit encryption. ([IBM Z Pervasive Encryption](https://www.ibm.com/support/z-content-solutions/pervasive-encryption/), [Db2 for z/OS data encryption tutorial](https://www.mainframemaster.com/tutorials/db2/encryption-and-cryptography))

### On-demand, application-controlled column encryption (threat = a privileged DB reader)

Transparent at-rest does not stop a logged-in user with `SELECT`. For the few fields that must stay ciphertext even to a DBA (e.g. a retained PAN, a national ID), encrypt at the column level and keep the key **outside** Db2 (app tier / KMS) so no single administrator holds both ciphertext and key.

- **Db2 for z/OS:** the **`ENCRYPT_DATAKEY`** / `DECRYPT_DATAKEY_*` built-in functions encrypt with **AES-256 in CBC** using a **key label** resolved through ICSF (the key never appears in SQL). Provide a **random IV** per value, not a fixed IV, so identical plaintexts differ. Older `ENCRYPT`/`DECRYPT_CHAR` (password-based) built-ins exist but are weaker — prefer the key-label `ENCRYPT_DATAKEY` family. ([Encrypting your data through Db2 built-in functions](https://www.ibm.com/docs/en/db2-for-zos/13.0.0?topic=data-encrypting-your-through-db2-built-in-functions))
- **Db2 LUW / cross-platform:** do authenticated **AES-256-GCM** envelope encryption in the **application tier** (the KMS issues a data key; Db2 stores only ciphertext + IV + GCM tag as `VARCHAR FOR BIT DATA` / `BLOB`). This keeps the key out of the database entirely and gives you integrity (a tampered ciphertext fails to decrypt).

```sql
-- Db2 for z/OS: column encrypted with AES-256-CBC via a key label in ICSF (RACF controls the label).
-- The random IV makes equal PANs encrypt to different ciphertext; the key never appears in SQL.
UPDATE CORE.CARD
   SET PAN_ENC = ENCRYPT_DATAKEY(:pan_clear, 'BANKCORE.PAN.MK', 1, 256)   -- algorithm 1 = AES, 256-bit, random IV
 WHERE ID = :id;
-- Decrypt only in a least-privileged, audited path:
SELECT DECRYPT_DATAKEY_BIGINT(PAN_ENC) FROM CORE.CARD WHERE ID = :id;     -- or the CHAR/CLOB variant
```

### Hashed one-way (passwords)

- **Do not design password storage in the database.** Db2 itself does not store application user passwords — authentication is delegated to **RACF** (z/OS) or the OS/LDAP plugin (LUW). You do not implement Db2's own credential store.
- For *application* user passwords, hash in the **application tier** with **Argon2id** (OWASP: m ≥ 19 MiB, t = 2, p = 1), bcrypt as fallback — store only the resulting hash string in a column.
- Db2's hashing built-ins (`HASH`, `HASH_MD5`, `HASH_SHA256`, `HASH_SHA512`) are for data integrity / partitioning, **not** passwords — SHA-2 is far too fast for password storage, and `HASH_MD5`/SHA-1 are broken for any security purpose.
- **Forbidden (refusal rules 2, 4):** storing passwords reversibly; MD5/SHA-1 for integrity or passwords; DES/3DES or any weaker-than-AES-256 cipher for new data; AES-ECB; a fixed/reused IV; hardcoded keys or keystore passwords; home-rolled crypto; floating-point money.

### Access control above encryption (threat = an authorized-but-over-scoped user)

Encryption alone does not stop a logged-in user reading cleartext. Layer Db2's native controls:

- **Row and Column Access Control (RCAC)** — introduced in Db2 10 (z/OS and LUW); also called fine-grained access control (FGAC). A **row permission** (`CREATE PERMISSION ... FOR ROWS WHERE <condition> ENFORCED FOR ALL ACCESS`) is a predicate Db2 appends to every query so a user sees only permitted rows; a **column mask** (`CREATE MASK ... RETURN CASE WHEN ... END`) rewrites the returned value of a column (e.g. show only last 4 of a PAN) based on the session user/role. Activate with `ALTER TABLE ... ACTIVATE ROW ACCESS CONTROL / ACTIVATE COLUMN ACCESS CONTROL`. Crucially, RCAC **cannot be bypassed by `SECADM` or the table owner** once activated, and even `SYSADM` is subject to it — this is the separation-of-duty control SOX/GLBA expect. ([Row and column access control (RCAC)](https://www.ibm.com/docs/en/db2/12.1.x?topic=security-row-column-access-control-rcac), [CREATE MASK statement](https://www.ibm.com/docs/en/db2-for-zos/12.0.0?topic=statements-create-mask), [CREATE PERMISSION](https://www.ibm.com/docs/en/db2/11.1?topic=statements-create-permission))

```sql
-- RCAC row permission: a teller sees only rows for their branch; a customer sees only their own.
CREATE PERMISSION CORE.ACCT_OWN ON CORE.ACCOUNT
  FOR ROWS WHERE
    VERIFY_ROLE_FOR_USER(SESSION_USER,'PCI_CLEARTEXT') = 1       -- privileged role: all rows
    OR CUSTOMER_ID = (SELECT CUSTOMER_ID FROM CORE.APP_USER WHERE USERID = SESSION_USER)
  ENFORCED FOR ALL ACCESS ENABLE;

-- RCAC column mask: everyone but the PCI_CLEARTEXT role sees only the last 4 digits of the PAN.
CREATE MASK CORE.PAN_MASK ON CORE.CARD FOR COLUMN PAN_LAST4 RETURN
  CASE WHEN VERIFY_ROLE_FOR_USER(SESSION_USER,'PCI_CLEARTEXT') = 1
       THEN PAN_LAST4
       ELSE 'XXXXXXXXXXXX' || RIGHT(PAN_LAST4,4)
  END ENABLE;

ALTER TABLE CORE.ACCOUNT ACTIVATE ROW ACCESS CONTROL;
ALTER TABLE CORE.CARD    ACTIVATE COLUMN ACCESS CONTROL;
```

- **Label-Based Access Control (LBAC)** — row- **and** column-level classification labels enforced by the engine, for a true multi-level security model (confidentiality tiers). You define a security policy and labels, store a `DB2SECURITYLABEL` column, and grant users read/write labels; the `SECLABEL`, `SECLABEL_BY_NAME`, and `SECLABEL_TO_CHAR` built-ins manage labels. Use LBAC when data has a genuine classification lattice rather than simple ownership (RCAC is usually the better fit for "customer sees own accounts"). ([Label-based access control (LBAC) overview](https://www.ibm.com/docs/en/db2/11.5?topic=security-label-based-access-control-lbac), [Built-in functions for managing LBAC security labels](https://www.ibm.com/docs/en/db2/11.1?topic=lbac-built-in-functions-managing-security-labels))

- **RACF as the external security manager (z/OS)** — in a bank core, Db2 authorization is typically externalized to **RACF** through the **Db2 access-control authorization exit `DSNX@XAC`** (the **RACF Access Control Module**, `DSNXRXAC`). When active, RACF — not the Db2 catalog `GRANT`s — decides every access-control question, via its own resource classes (`DSNADM`, `MDSNTB`, etc.), giving one enterprise point of control, central audit (SMF), and clean separation of duty (the Db2 DBA does not own authorization). The exit is driven whenever a signed-on thread issues an API request. ([Authorizing users to access resources in Db2](https://www.ibm.com/docs/sk/SSGMCP_5.5.0/security/database/dfhtk14.html), [Db2 12 for z/OS RACF Access Control Module Guide](https://www.ibm.com/docs/en/db2-for-zos/12?topic=security-managing-access-through-exit-routines))

- **Authorities as roles (both platforms)** — split **`SYSADM`** (system admin, no automatic access to data under RACF/RCAC), **`DBADM`** (database admin), **`SECADM`** (security/audit admin — owns RCAC/LBAC/audit, deliberately cannot be the DBA), and **`ACCESSCTRL`/`DATAACCESS`**. Granting `DATAACCESS` to a human in a bank core is a red flag — route data access through least-privilege application roles, not blanket authorities.

## Country differences (how the same schema changes)

- **EU — GDPR, PSD2, DORA.** GDPR erasure: design PII for **crypto-shredding** — put a customer's PII under a per-customer key (an `ENCRYPT_DATAKEY` key label on z/OS, or an app-tier KMS data key) so destroying the key renders the data unrecoverable without a full purge. DORA (in force Jan 2025): ICT resilience — your keystore (KMIP/ICSF/UKO) backup/restore, audit retention, and recovery must be tested; losing the Master Key makes ciphertext unrecoverable, so key backup is a resilience control, not just a safety net. PSD2 SCA lives in the app tier, but the audit of strong-auth events belongs in the Db2 audit trail.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + **separation of duty** — use **tamper-proof audit policies** (z/OS) gated by RACF and **RCAC** so the DBA who runs the ledger cannot read or alter customer data or stop auditing. GLBA Safeguards: encryption at rest (native encryption / z/OS data set encryption) + access logging (`EXECUTE` audit policy on PII reads). CCPA/CPRA deletion: same crypto-shred design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK ≈ GDPR for personal data + explicit consent. **BDDK data localization**: Turkish banking data must reside **in Turkey** — the Db2 data sets/table spaces, the keystore/ICSF/UKO, and all backups (including Db2 native-encryption backup images) must be in-region; make residency a deploy boundary, not a hardcoded assumption. MASAK: AML/suspicious-transaction reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits): store encrypted (`ENCRYPT_DATAKEY` / app-tier AES-GCM), mask on output via an RCAC column mask, and validate the checksum.
- **UK — FCA, UK GDPR, PRA.** UK GDPR mirrors EU post-Brexit; SCA still applies under UK PSRs. Same encryption + RCAC + crypto-shred machinery, different reporting endpoints and retention windows (hold the SMF/audit extract for the regulator's required period before archival).

Keep region as **configuration** (a role/label, a per-tenant policy, a deploy region), not `IF country = ...` scattered through SQL PL.

## Good example

```sql
-- Storage-side done right (Db2 for z/OS): data-set-encrypted table spaces (transparent at rest),
-- ENCRYPT_DATAKEY column PAN with an ICSF key label, RCAC row permission + column mask,
-- EXECUTE audit policy, append-only ledger, DECIMAL money, deterministic FOR UPDATE locking.

CREATE TABLE CORE.ACCOUNT (
  ID           BIGINT       NOT NULL GENERATED ALWAYS AS IDENTITY,
  CUSTOMER_ID  BIGINT       NOT NULL,
  BALANCE      DECIMAL(20,4) NOT NULL,        -- DECIMAL, never DOUBLE/REAL, for money
  CURRENCY     CHAR(3)      NOT NULL,
  VERSION      INTEGER      NOT NULL DEFAULT 0, -- optimistic lock token
  PRIMARY KEY (ID)
);  -- in a table space whose data set is encrypted by z/OS data set encryption (ICSF-managed AES key)

CREATE TABLE CORE.CARD (
  ID        BIGINT PRIMARY KEY NOT NULL,
  PAN_ENC   VARCHAR(256) FOR BIT DATA,         -- AES-256-CBC via ENCRYPT_DATAKEY, key label in ICSF
  PAN_LAST4 CHAR(4)                             -- for display/search; masked by RCAC to last 4
  -- NO cvv column: CVV must never be stored (PCI-DSS, FCS-SAD-001)
);

-- Atomic, deadlock-safe transfer with append-only audit row (SQL PL).
CREATE PROCEDURE CORE.TRANSFER (IN p_src BIGINT, IN p_dst BIGINT,
                                IN p_amt DECIMAL(20,4), IN p_ccy CHAR(3), IN p_idem VARCHAR(64))
  LANGUAGE SQL
BEGIN
  DECLARE v_src_bal DECIMAL(20,4);
  DECLARE SQLSTATE CHAR(5);
  DECLARE EXIT HANDLER FOR SQLSTATE '23505' ROLLBACK;   -- idempotent replay: already applied, fail silent-safe

  IF p_amt <= 0 THEN SIGNAL SQLSTATE '75001' SET MESSAGE_TEXT = 'amount must be positive'; END IF;

  INSERT INTO CORE.TRANSFER_REQUEST(IDEM_KEY) VALUES (p_idem);  -- UNIQUE: concurrent retry hits 23505

  -- Lock both rows lowest-id-first to avoid deadlock
  IF p_src < p_dst THEN
    SELECT BALANCE INTO v_src_bal FROM CORE.ACCOUNT WHERE ID = p_src FOR UPDATE;
    SELECT BALANCE INTO v_src_bal FROM CORE.ACCOUNT WHERE ID = p_src;  -- (kept locked)
  ELSE
    SELECT BALANCE INTO v_src_bal FROM CORE.ACCOUNT WHERE ID = p_dst FOR UPDATE;
    SELECT BALANCE INTO v_src_bal FROM CORE.ACCOUNT WHERE ID = p_src FOR UPDATE;
  END IF;

  IF v_src_bal < p_amt THEN SIGNAL SQLSTATE '75002' SET MESSAGE_TEXT = 'insufficient funds'; END IF;

  UPDATE CORE.ACCOUNT SET BALANCE = BALANCE - p_amt, VERSION = VERSION + 1 WHERE ID = p_src;
  UPDATE CORE.ACCOUNT SET BALANCE = BALANCE + p_amt, VERSION = VERSION + 1 WHERE ID = p_dst;

  -- Append-only business ledger row, same unit of work as the money move
  INSERT INTO CORE.LEDGER_ENTRY(ACTOR, ACTION, SRC_ID, DST_ID, AMOUNT, CURRENCY, IDEM_KEY, AT_UTC)
  VALUES (SESSION_USER, 'transfer', p_src, p_dst, p_amt, p_ccy, p_idem,
          CURRENT TIMESTAMP - CURRENT TIMEZONE);

  COMMIT;   -- the EXECUTE audit policy on LEDGER_ENTRY also records this DML to SMF / the audit log
END;
```

## Bad example

```sql
-- ❌ Every line crosses a red line — refuse to write this.
CREATE TABLE CARD_BAD (
  PAN  VARCHAR(19),          -- raw PAN, no encryption, no RCAC mask — rule 1
  CVV  VARCHAR(4),           -- storing CVV — forbidden outright — rule 1
  PWD  VARCHAR(32)           -- will hold an MD5 of the password — rules 2/4
);

CREATE PROCEDURE PAY_BAD (IN p_pan VARCHAR(19), IN p_cvv VARCHAR(4), IN p_amt DOUBLE)
  LANGUAGE SQL
BEGIN
  -- logs PAN + CVV to the diagnostic log / trace — rules 1, 3
  CALL DBMS_OUTPUT.PUT_LINE('charging card ' || p_pan || ' cvv ' || p_cvv);

  INSERT INTO CARD_BAD(PAN, CVV, PWD)
    VALUES (p_pan, p_cvv, HEX(HASH_MD5(:pw)));          -- MD5 password — rules 2, 4

  -- AES in ECB-equivalent mode with a hardcoded, reused key/password:
  INSERT INTO CARD_BAD(PAN) VALUES (ENCRYPT_CHAR(p_pan, 'hardcoded-pw-123'));  -- weak + hardcoded — rules 4, 7

  UPDATE ACCOUNT SET BALANCE = BALANCE - p_amt WHERE ID = 1;   -- DOUBLE money + no lock -> lost update
  UPDATE ACCOUNT SET BALANCE = BALANCE + p_amt WHERE ID = 2;   -- no idempotency, no audit — rule 6
  COMMIT;
END;
```

Red lines crossed: storing/printing PAN & CVV (PCI-DSS, rules 1, 3), MD5 password (rules 2, 4), a weak password-based encrypt with a hardcoded key (rules 4, 7), `DOUBLE` for money (core), no `FOR UPDATE` lock (lost update), no idempotency key, no audit of money movement (rule 6). The compliant alternative is the *Good example* above: data-set / native encryption at rest, `ENCRYPT_DATAKEY` (ICSF key label) or app-tier AES-256-GCM with a KMS-held key for the column — or tokenize the card via the processor and store none of it — RCAC row permission + column mask for access, an `EXECUTE` audit policy to SMF/the audit log, and `DECIMAL` money with deterministic `FOR UPDATE` locking. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`global/pci-dss.md`](../global/pci-dss.md).
