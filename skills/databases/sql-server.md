# Skill: Microsoft SQL Server for Regulated Fintech

**Configure storage-side controls on SQL Server — TDE, Always Encrypted (+ secure enclaves), column-level encryption, Dynamic Data Masking, Row-Level Security, SQL Server Audit, Extensible Key Management, and Ledger tables — so cardholder data, PII, and the audit trail are protected at rest and tamper-evident.** Load this skill whenever a .NET enterprise fintech system persists payments, transfers, onboarding/KYC, credentials, or PII in SQL Server (2019/2022/2025) or Azure SQL and you need to decide which engine feature enforces which control.

Always also load [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md); pair this with [`languages/csharp-dotnet.md`](../languages/csharp-dotnet.md) for the application tier, and add the relevant regional skill ([EU](../regional/eu-gdpr-psd2-dora.md), [US](../regional/us-sox-glba-ccpa.md), [UK](../regional/uk-fca-gdpr.md), [Turkey](../regional/turkey-kvkk-bddk-masak.md)) for the jurisdiction.

## When to use

- Designing the storage schema for a banking/payments/lending/wallet system on SQL Server or Azure SQL.
- Storing PAN, IBAN, national ID, DOB, credentials, or any card data and deciding **where** the encryption boundary sits (disk, column, or client).
- Building an append-only, tamper-evident audit trail for money movement that must survive a malicious DBA.
- Choosing between TDE, Always Encrypted, cell-level encryption, Dynamic Data Masking, and Row-Level Security — a frequent source of dangerous misconfiguration (e.g. treating DDM as access control).
- Wiring the key hierarchy to an HSM or Azure Key Vault via Extensible Key Management (EKM).

Do **not** treat this skill as a security sign-off or as legal advice; it encodes engineering defaults for the storage tier, not an attestation.

> **One-sentence mental model of the feature set:** TDE protects the *files* (theft of a backup/drive), Always Encrypted protects data from the *server and the DBA* (data is ciphertext inside the engine), DDM only changes what a *query result displays*, RLS decides which *rows* a principal sees, SQL Server Audit records *who did what*, and Ledger makes the audit trail *tamper-evident*. They are complementary layers, not alternatives.

---

## Logging — what goes where

In SQL Server the "log" that matters for compliance is the **audit trail of data access and money movement**, not the transaction log (which exists for recovery, not forensics). Use the engine's native **SQL Server Audit** feature as the primary sink; it writes outside the reach of normal DML and can be configured to halt the instance rather than lose an audit record.

### Which events, which sink, which level

| Event | Audited via | Sink | Notes |
|-------|-------------|------|-------|
| `SELECT`/`UPDATE`/`DELETE` on cardholder/PII tables | Database Audit Specification (`DATABASE_OBJECT_ACCESS_GROUP` or per-object) | Binary audit file / Windows Security log | The audit records *that* a column was read, never the value |
| Money movement (transfer/charge/payout committed) | Application audit table + Ledger (see below) | Dedicated append-only / ledger table | Correlate with idempotency key + actor id |
| Logins, failed logins, role changes | Server Audit Specification (`FAILED_LOGIN_GROUP`, `SUCCESSFUL_LOGIN_GROUP`, `SERVER_ROLE_MEMBER_CHANGE_GROUP`) | Server-level audit | Who, from where, outcome |
| `GRANT`/`REVOKE`/permission changes, schema changes | `DATABASE_PERMISSION_CHANGE_GROUP`, `SCHEMA_OBJECT_CHANGE_GROUP` | Server-level audit | Detect privilege escalation |
| DBA actions (`ALTER`, backup, `UNMASK` grant, key export) | `DATABASE_OBJECT_PERMISSION_CHANGE_GROUP`, `BACKUP_RESTORE_GROUP`, `DBCC_GROUP` | Server-level audit | The privileged-user watch |

A SQL Server Audit has two parts: the **Server Audit object** (defines the *target* — a binary file, the Windows Application log, or the Windows Security log — plus the failure policy), and one or more **Audit Specifications** (**Server Audit Specification** for instance-level events, **Database Audit Specification** for object-level events). Both must be explicitly `WITH (STATE = ON)`. *(Microsoft Learn: ["SQL Server Audit (Database Engine)"](https://learn.microsoft.com/en-us/sql/relational-databases/security/auditing/sql-server-audit-database-engine) and ["Create a Server Audit and Server Audit Specification"](https://learn.microsoft.com/en-us/sql/relational-databases/security/auditing/create-a-server-audit-and-server-audit-specification).)*

### What is MASKED before it hits any sink

The audit records the **fact** of access (principal, object, statement), not the sensitive payload, so PAN/CVV/etc. do not land in the audit file by design — provided you audit at the object/statement-group level and do **not** enable payload-capturing traces. The masking obligations fall on anything else that could emit values:

- **Never enable** a SQL Trace / Extended Events session that captures statement text or parameter values against tables holding PAN, CVV, passwords, tokens, or full national IDs in production. `rpc_completed`/`sql_batch_completed` with `batch_text`/`statement` will capture the literal values.
- **Application-side logging** (Serilog etc.) is where values leak — mask there, at the point of capture, per [`languages/csharp-dotnet.md`](../languages/csharp-dotnet.md). PAN is masked to last-4 (`************1234`); CVV/PIN/password/token/private key are **dropped, never masked-then-logged** (refusal-policy rules 1 and 3).
- **Dynamic Data Masking** is *not* a logging control and *not* an access control — see the warning in the Hashing & encryption section. Do not rely on it to keep values out of any sink.

### What is NEVER logged (even masked)

CVV/CVC, full magnetic-track/chip data, PIN or PIN blocks, plaintext passwords, private keys, TDE/CMK key material, and raw session/refresh/bearer tokens. These are refusal-policy red lines (rules 1, 3, 4), not "mask-then-log" cases.

### Log integrity — append-only / WORM / hash chain

This is where SQL Server is unusually strong; use the native features rather than rolling your own:

- **`ON_FAILURE` policy.** Create the Server Audit with `ON_FAILURE = FAIL_OPERATION` (the audited statement fails if its audit record cannot be written) or, for the highest assurance, `ON_FAILURE = SHUTDOWN` (the instance stops rather than proceed un-audited). For a regulated money-movement system, `CONTINUE` (lose the record, keep running) is the wrong default. *(["CREATE SERVER AUDIT"](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-server-audit-transact-sql).)*
- **Append-only application audit table.** Grant the app principal `INSERT` only — no `UPDATE`/`DELETE` — on the money-movement audit table, and keep DDL/permission rights off that login entirely.
- **Ledger tables** for cryptographic tamper-evidence (see the dedicated section below) — this is the engine-native hash chain; do not hand-roll a `SHA-256(prev || row)` scheme if you are on SQL Server 2022+.
- **Ship audit files off-host** to WORM/immutable storage (e.g. object storage with object-lock / immutability policy) promptly, so a host compromise cannot rewrite history.
- `C2 audit mode` is **deprecated** — do not use it; it is superseded by **Common Criteria compliance** (`common criteria compliance enabled`) and the modern SQL Server Audit feature. *(Microsoft Learn: "c2 audit mode … replaced by Common Criteria".)*

---

## Workflow — payment / transfer / onboarding

The storage tier's job in a transfer is to make the balance change, the audit record, and the idempotency guard **atomic**, and to make the audit record **tamper-evident**.

### Step order (a funds transfer, storage-side)

1. **Idempotency guard first.** A unique key on `(idempotency_key)` in a request-dedup table, inserted inside the same transaction. A retry collides on the unique index and is rejected before any balance moves — the database, not the app, is the source of truth for "did this already happen".
2. **Authorization / approval gate** is enforced in the app and *recorded* in storage; high-value transfers write an approval row that the posting transaction checks (`WHERE approved = 1`).
3. **Open an explicit transaction** at the correct isolation level (see concurrency below).
4. **Debit and credit** the ledger/balance rows.
5. **Write the audit record** to the append-only audit table (and, with Ledger, it is automatically chained) **inside the same transaction**, so a committed money move can never exist without its audit row.
6. **Commit.** On any failure, roll back — the idempotency insert, the balance change, and the audit row all vanish together.

### Concurrency / locking model

- **Isolation level.** For balance-moving transactions prefer **`SNAPSHOT`** or **`READ COMMITTED SNAPSHOT`** (row-versioning) to avoid readers blocking writers, combined with **optimistic concurrency** on the balance row (a `rowversion`/`ROWVERSION` column, or a `WHERE balance = @expected` check) so two concurrent debits cannot both succeed on stale reads. Under `SNAPSHOT`, a write-write conflict raises error 3960 and the loser retries.
- **Pessimistic alternative.** Where you must serialize (e.g. a single hot account), take `UPDLOCK, HOLDLOCK` hints on the balance `SELECT` inside the transaction to lock the row for the duration. Keep the transaction short to limit contention.
- **Never** rely on application-level "read then write" without either a `rowversion` check or a lock hint — it is the classic lost-update / double-spend bug.
- **Idempotency** is enforced by a `UNIQUE` constraint, not by application logic, so it holds even under concurrent retries.

---

## Hashing & encryption

This section maps each data class to the correct SQL Server mechanism. The dominant mistake is choosing a feature that looks like protection but is not a boundary (DDM), or encrypting at the wrong layer (TDE when the threat is a privileged insider).

### What is HASHED one-way

- **Passwords are hashed in the application tier, never in the database**, with a slow, salted KDF — **Argon2id** (preferred) or **bcrypt** via ASP.NET Core Identity / `System.Security.Cryptography` (see [`languages/csharp-dotnet.md`](../languages/csharp-dotnet.md)). SQL Server's `HASHBYTES` is a fast general-purpose hash and is **not** a password KDF — do not use it for credentials.
- **`HASHBYTES` is forbidden with `MD5`/`SHA1`** for any integrity or de-identification purpose (FCS-CRYPTO-001); use `SHA2_256`/`SHA2_512` only.
- **PAN hashing for PCI DSS.** If you store a hash of the PAN (e.g. for duplicate detection), PCI DSS v4.0.1 **Requirement 3.5.1.1** requires a **keyed cryptographic hash** (HMAC with a secret key kept separate from the data), mandatory since **31 March 2025**. A plain `HASHBYTES('SHA2_256', @pan)` is **non-compliant** because an attacker with the hash can brute-force the small PAN keyspace. Compute the HMAC in the application with a key held in the KMS/HSM, or do not store the hash at all. *(PCI SSC Requirement 3; [Control Gap, "Securing PAN Using Keyed Cryptographic Hashing in PCI DSS v4.0.1"](https://www.controlgap.com/blog/securing-pan-using-keyed-cryptographic-hashing-in-pci).)*

### What is ENCRYPTED two-way — the three layers

SQL Server offers three distinct at-rest encryption mechanisms. **Pick by threat model:**

| Feature | Protects against | Visible as plaintext to | Supports queries on ciphertext |
|---------|------------------|-------------------------|-------------------------------|
| **TDE** (Transparent Data Encryption) | Stolen `.mdf`/`.ldf`/backup files, discarded disks | Anyone who can query the DB (incl. DBA) | Yes (transparent) |
| **Always Encrypted** | The SQL Server process, the DBA, the cloud operator | Only the client app holding the CMK | Equality only (deterministic); rich queries only with secure enclaves |
| **Cell/column-level encryption (CLE)** | Column read without the key | App/caller with the symmetric key | No (opaque `varbinary`) |

**1. TDE — files at rest.**
TDE encrypts the entire database (and its backups and `tempdb`) using a symmetric **Database Encryption Key (DEK)**. The DEK is protected by a certificate stored in `master` (the "TDE protector") or, better, by an asymmetric key in an **EKM/HSM** module. Use **`AES_256`** for the DEK (`CREATE DATABASE ENCRYPTION KEY ... WITH ALGORITHM = AES_256`); the legacy `TRIPLE_DES_3KEY` is deprecated — do not use it. TDE defends against **offline** theft of raw files or backups; it gives **no** protection against a user or DBA who can run queries, because decryption happens transparently inside the engine. *(Microsoft Learn: ["Transparent Data Encryption (TDE)"](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/transparent-data-encryption).)*

**2. Always Encrypted — protect data from the server and the DBA.**
For PAN, IBAN, national ID, and other high-sensitivity columns, Always Encrypted keeps the data **as ciphertext inside the engine**: encryption/decryption happens in the **client driver** (e.g. `Microsoft.Data.SqlClient` with `Column Encryption Setting=Enabled`), using a **Column Encryption Key (CEK)** that is itself wrapped by a **Column Master Key (CMK)** held *outside* SQL Server (Windows Certificate Store, Azure Key Vault, or an HSM via CNG/PKCS#11). The DBA sees only `varbinary` ciphertext and never the CMK.
   - **Deterministic** encryption allows equality lookups and joins on the encrypted column but leaks equality (same plaintext → same ciphertext) — acceptable for a lookup key, risky for low-cardinality data.
   - **Randomized** encryption leaks nothing but, *without enclaves*, supports no server-side computation.
   - **Always Encrypted with secure enclaves** (SQL Server 2019+) runs computations on plaintext inside a protected memory enclave, enabling **in-place encryption**, **in-place key rotation**, and **rich queries** (range comparisons, `LIKE` pattern matching, sorting) on **randomized**-encrypted columns. Note the enclave technology changed: **SQL Server 2019 used Intel SGX**; **SQL Server 2022 uses VBS (Virtualization-Based Security) enclaves**, and the enclave must be **attested** (HGS for on-prem SQL Server, Microsoft Azure Attestation for Azure SQL). Rich computations require the column be **randomized** — a deterministic column must be re-encrypted as randomized to use them. *(Microsoft Learn: ["Always Encrypted with secure enclaves"](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-enclaves).)*

**3. Cell-level / column-level encryption (CLE).**
`ENCRYPTBYKEY`/`DECRYPTBYKEY` with a symmetric key protected by a certificate/asymmetric key. More manual than Always Encrypted and the engine *does* see plaintext when decrypting, so it does not defend against the DBA. Use it only for legacy engines or targeted blobs where Always Encrypted is impractical. **Forbidden:** `ECB`-mode usage, home-rolled crypto, or a symmetric key opened and left open across a session.

### Key management, EKM, rotation, and what is FORBIDDEN

- **Extensible Key Management (EKM)** lets SQL Server use keys stored in an external **HSM** or **Azure Key Vault** via the **SQL Server Connector**, keeping the root of trust off the database host — this is the required posture for regulated environments (separation of duties between key custodians and DBAs; BYOK/customer-managed keys). **Note:** the SQL Server Connector for Azure Key Vault supports **asymmetric RSA keys only** for the TDE protector. *(Microsoft Learn: ["Extensible Key Management Using Azure Key Vault"](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/extensible-key-management-using-azure-key-vault-sql-server) and ["Set up TDE with Azure Key Vault"](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/setup-steps-for-extensible-key-management-using-the-azure-key-vault).)*
- **Rotation.** Rotate the TDE protector / CMK on a defined schedule (and immediately on suspected compromise). Always Encrypted CMK/CEK rotation is a documented two-phase process; with secure enclaves it can be done **in place** without moving data out of the server. Keep the old key available until all data is re-wrapped.
- **FORBIDDEN:** hardcoded or static keys/IVs in source or config (FCS-SECRET-002); storing the CMK inside the same SQL Server it protects (defeats Always Encrypted); `ECB` mode; `MD5`/`SHA1`/`DES`/`3DES` for new work; home-rolled crypto; exporting key material to logs or email.

> ### ⚠️ Dynamic Data Masking is NOT a security boundary
> DDM is a **presentation-layer filter**: it rewrites column values in query *results* for principals lacking the `UNMASK` permission, while the stored data and the query engine use the **real** values. Users with `UNMASK`, `db_owner`, or `sysadmin` always see cleartext, and any caller who can run ad-hoc queries can **infer** masked values through `WHERE`/`JOIN`/range predicates (an inference attack) — DDM does not encrypt, does not filter rows, and does not override permissions. Use it to reduce casual over-exposure to support/analytics staff, **never** as the control that protects PAN or PII from an attacker or a privileged insider. For that, use Always Encrypted (confidentiality) and RLS (row access). *(Microsoft Learn / Azure SQL Blog: ["Dynamic Data Masking — What it is, what it isn't"](https://techcommunity.microsoft.com/t5/azure-sql-blog/dynamic-data-masking-what-it-is-what-it-isn-t-and-how-to-use-it/ba-p/4512877); Microsoft Learn: "DDM doesn't aim to prevent … exhaustive queries that expose pieces of the sensitive data".)*

### Row-Level Security (RLS)

RLS enforces **which rows** a principal may read or write via an inline table-valued function bound as a **security predicate** (`FILTER` for reads, `BLOCK` for writes) in a `SECURITY POLICY`. Use it for tenant isolation (a customer sees only their own accounts) and segregation of duties (a branch user sees only their branch). RLS is a genuine access-control boundary (unlike DDM), but beware **side-channel inference** (e.g. a filtered `SELECT` that errors or times out can leak existence); pair it with least-privilege grants, and remember it is bypassed by anyone able to alter the policy, so lock down that permission and audit `SCHEMA_OBJECT_CHANGE_GROUP`.

### Ledger tables — tamper evidence

SQL Server 2022 introduced **Ledger**, which makes tables cryptographically **tamper-evident** using a blockchain-like Merkle-tree hash chain, so even a `sysadmin`/DBA cannot alter historical data undetected:

- **Append-only ledger tables** permit `INSERT` only — no `UPDATE`/`DELETE` — ideal for a money-movement or event audit trail that must be immutable even to privileged users.
- **Updatable ledger tables** allow updates/deletes but preserve every prior row version in a linked **history table**, giving tamper-evidence with mutable semantics.
- The **database ledger** periodically computes a **digest** (the Merkle-tree root hash). Store the digest **outside the database** in WORM storage (e.g. Azure immutable blob storage, which can be automated). Verification (`sys.sp_verify_database_ledger` / the portal "Verify database" action) recomputes the hashes and compares them to the trusted digest; any out-of-band tampering fails verification. *(Microsoft Learn: ["Append-only ledger tables"](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-append-only-ledger-tables), ["Database ledger"](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-database-ledger), ["Verify a Ledger Table to Detect Tampering"](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-verify-database).)*

This is the engine-native replacement for a hand-rolled hash chain and is the recommended tamper-evidence control for the audit trail on SQL Server 2022+.

---

## Country differences (how the same storage config changes)

The schema and queries are largely the same; the **controls you must switch on, the key custody, and the data residency** change.

- **EU — GDPR, PSD2 SCA, DORA.** Encrypt PII at rest (Always Encrypted for direct identifiers) to support GDPR Art. 32 "state of the art" and breach-notification safe harbour. Support the **right to erasure**: design so a subject's PII can be deleted or crypto-shredded (destroy the per-subject CEK) — hard if PII sits in an *append-only* ledger, so keep erasable PII out of ledger/immutable tables and store only non-identifying references there. **DORA** adds ICT resilience/retention expectations (backups encrypted, restorable, tested). PSD2 **SCA** evidence (auth factors used) belongs in the audited, tamper-evident trail, not in free-text logs.
- **US — SOX, GLBA, CCPA/CPRA.** **SOX** demands integrity and an immutable audit trail over financial records → Ledger + SQL Server Audit with `ON_FAILURE = FAIL_OPERATION`. **GLBA Safeguards Rule** → encryption at rest (TDE + Always Encrypted) and access control (RLS). **CCPA/CPRA** → data inventory and deletion support, as with GDPR.
- **Turkey — KVKK, BDDK, MASAK.** **KVKK** mirrors GDPR encryption/erasure duties. **BDDK** banking rules impose **data-localization**: the primary SQL Server instance and its backups for Turkish banking data must reside **in Turkey** — set EKM/Key Vault region and backup storage accordingly; a cross-border Azure region or cloud HSM may be non-compliant. **MASAK** AML reporting needs a reliable, tamper-evident transaction trail → Ledger.
- **UK — FCA, UK GDPR.** UK GDPR tracks EU GDPR for encryption/erasure. **FCA** (and PRA) expect robust record-keeping and operational resilience; retain the tamper-evident audit trail for the required period and keep key custody auditable.

> In every jurisdiction, **where the keys live** (EKM/HSM/Key Vault region, separation of duties from DBAs) and **how long the tamper-evident trail is retained** are the knobs that change — not the T-SQL.

---

## Good example

Idiomatic, defensible SQL Server configuration for a payments schema: TDE with an AES-256 DEK, Always Encrypted on PAN, an append-only Ledger audit table, RLS for tenant isolation, and a hardened SQL Server Audit.

```sql
-- 1) TDE: encrypt files at rest with AES-256; protector lives in EKM/Key Vault (set up separately).
CREATE DATABASE ENCRYPTION KEY
    WITH ALGORITHM = AES_256                 -- AES-256, never TRIPLE_DES_3KEY
    ENCRYPTION BY SERVER ASYMMETRIC KEY ekm_tde_key;  -- asymmetric RSA key in Azure Key Vault via EKM
ALTER DATABASE PaymentsDb SET ENCRYPTION ON;

-- 2) Always Encrypted: PAN is ciphertext inside the engine; CMK is in Key Vault, CEK wrapped by it.
--    (CMK/CEK created via SSMS/PowerShell pointing at Key Vault; column defined as:)
CREATE TABLE dbo.CardOnFile (
    CardId      BIGINT IDENTITY PRIMARY KEY,
    CustomerId  BIGINT NOT NULL,
    Pan         VARBINARY(256) ENCRYPTED WITH (
                    COLUMN_ENCRYPTION_KEY = CEK_Cards,
                    ENCRYPTION_TYPE = RANDOMIZED,         -- randomized; use enclaves for range/LIKE queries
                    ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256') NOT NULL,
    PanLast4    CHAR(4) NOT NULL                          -- safe, display-only; never the full PAN in cleartext
);
-- App connects with Column Encryption Setting=Enabled; the driver decrypts, the DBA never sees the PAN.

-- 3) Append-only Ledger audit table: immutable even to sysadmin; digest exported to WORM storage.
CREATE TABLE dbo.MoneyMovementAudit (
    AuditId        BIGINT IDENTITY PRIMARY KEY,
    IdempotencyKey UNIQUEIDENTIFIER NOT NULL,
    ActorId        BIGINT NOT NULL,
    FromAccount    BIGINT NOT NULL,
    ToAccount      BIGINT NOT NULL,
    AmountMinor    BIGINT NOT NULL,                       -- integer minor units; never float money
    OccurredAtUtc  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Audit_Idem UNIQUE (IdempotencyKey)      -- idempotency enforced by the DB
)
WITH (LEDGER = ON (APPEND_ONLY = ON));                    -- INSERT only; UPDATE/DELETE rejected

-- 4) Row-Level Security: each tenant sees only its own rows (a real access boundary, unlike DDM).
CREATE FUNCTION dbo.fn_tenantPredicate(@CustomerId BIGINT)
    RETURNS TABLE WITH SCHEMABINDING AS
    RETURN SELECT 1 AS ok
           WHERE @CustomerId = CAST(SESSION_CONTEXT(N'CustomerId') AS BIGINT);
CREATE SECURITY POLICY dbo.CardAccessPolicy
    ADD FILTER PREDICATE dbo.fn_tenantPredicate(CustomerId) ON dbo.CardOnFile,
    ADD BLOCK  PREDICATE dbo.fn_tenantPredicate(CustomerId) ON dbo.CardOnFile
    WITH (STATE = ON);

-- 5) Hardened SQL Server Audit: fail the operation if the audit record cannot be written.
CREATE SERVER AUDIT FinAudit
    TO FILE (FILEPATH = 'S:\audit\')                       -- shipped off-host to WORM storage
    WITH (ON_FAILURE = FAIL_OPERATION);                    -- never run un-audited (SHUTDOWN for highest assurance)
ALTER SERVER AUDIT FinAudit WITH (STATE = ON);
CREATE DATABASE AUDIT SPECIFICATION FinDbAudit
    FOR SERVER AUDIT FinAudit
    ADD (SELECT, UPDATE, DELETE ON dbo.CardOnFile BY public),
    ADD (DATABASE_PERMISSION_CHANGE_GROUP)                 -- catch UNMASK/GRANT escalation
    WITH (STATE = ON);
```

Transfer, storage-side, with idempotency + snapshot isolation + same-transaction audit:

```sql
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
BEGIN TRY
    BEGIN TRANSACTION;
        -- idempotency + audit insert first; a retry collides on the UNIQUE key and aborts safely
        INSERT INTO dbo.MoneyMovementAudit (IdempotencyKey, ActorId, FromAccount, ToAccount, AmountMinor)
        VALUES (@IdempotencyKey, @ActorId, @From, @To, @AmountMinor);

        UPDATE dbo.Account SET BalanceMinor -= @AmountMinor
         WHERE AccountId = @From AND BalanceMinor >= @AmountMinor;   -- optimistic check, no overdraft
        IF @@ROWCOUNT = 0 THROW 51000, 'Insufficient funds or stale balance', 1;

        UPDATE dbo.Account SET BalanceMinor += @AmountMinor WHERE AccountId = @To;
    COMMIT;                     -- balance change + audit row commit atomically, or not at all
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    THROW;                      -- surface to the app; error 3960 (snapshot conflict) → retry
END CATCH;
```

## Bad example

```sql
-- ❌ Every line here crosses a red line or encodes a dangerous misunderstanding.

-- ❌ Treating Dynamic Data Masking as if it protected the PAN. It does not — it is a
--    presentation filter; any ad-hoc query infers the value and UNMASK/db_owner/sysadmin see cleartext.
ALTER TABLE dbo.CardOnFile
    ALTER COLUMN Pan ADD MASKED WITH (FUNCTION = 'partial(0,"XXXX",4)');  -- NOT encryption, NOT access control

-- ❌ Storing the PAN in cleartext and the CVV at all (refusal rules 1 & 4).
CREATE TABLE dbo.BadCard (
    Pan  VARCHAR(19) NOT NULL,          -- cleartext PAN
    Cvv  CHAR(3)     NOT NULL           -- CVV must NEVER be stored after authorization (PCI-DSS)
);

-- ❌ "Encrypting" the PAN with an unkeyed fast hash — reversible by brute force over the small PAN
--    keyspace, and non-compliant with PCI DSS v4.0.1 Req 3.5.1.1 (keyed hash mandatory since 2025-03-31).
INSERT INTO dbo.BadCard (Pan) VALUES (CONVERT(VARCHAR(64), HASHBYTES('MD5', @pan), 2));  -- MD5 forbidden (rule 4)

-- ❌ Audit that silently loses records instead of failing, and a DBA login that can rewrite history.
CREATE SERVER AUDIT WeakAudit TO FILE (FILEPATH = 'C:\temp\')
    WITH (ON_FAILURE = CONTINUE);       -- money moves even when it cannot be audited (rule 6)
GRANT UPDATE, DELETE ON dbo.MoneyMovementAudit TO app_login;  -- audit trail no longer append-only
```

**Why it's wrong:** DDM gives a false sense of protection while the PAN sits in cleartext; the CVV is stored at all (PCI-DSS red line); `MD5`/unkeyed hashing is both broken crypto and PCI-noncompliant; `ON_FAILURE = CONTINUE` plus `UPDATE/DELETE` grants on the audit table let money move un-audited and let a DBA erase the trail — exactly what Ledger + `FAIL_OPERATION` + append-only grants exist to prevent. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) rules 1, 3, 4, 6, 10.
