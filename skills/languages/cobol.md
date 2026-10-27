# Skill: COBOL (z/OS Mainframe) for Regulated Fintech

**Write regulation-compliant COBOL for bank-core and payment systems on z/OS, where security, logging, and crypto are delegated to the platform (RACF, SMF, ICSF/CPACF, DFSMS data set encryption, Db2) rather than coded in the program — with audited, recoverable money movement under CICS/RRS and batch.** Load this skill whenever the task touches money, accounts, cards, personal data, or authentication in a COBOL program running under z/OS, CICS, IMS, or JES batch.

> Always also load [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) and [`refusal/refusal-policy.md`](../refusal/refusal-policy.md). This file adds the COBOL/mainframe-specific *how*; the refusal policy defines the red lines that override everything here.

## The mental model (read this first)

On z/OS, **the COBOL program is the least privileged component in the security story.** Unlike a Java/Python service that calls crypto and logging libraries in-process, a correct mainframe program *delegates*:

- **Authentication & authorization** → RACF (or ACF2/Top Secret), not `IF USERID = ...` in the program.
- **Audit logging** → SMF (System Management Facilities) records written by RACF, Db2, and the subsystems — not `DISPLAY` or a flat file the program controls.
- **Encryption at rest** → DFSMS data set encryption + Db2 encryption, keyed by ICSF/CPACF hardware — not a crypto routine in the load module.
- **Transaction integrity** → CICS syncpoint / RRS two-phase commit — not program-managed rollback flags.

The single biggest mistake in mainframe fintech COBOL is **re-implementing in the program a control the platform already enforces** (home-rolled userid checks, program-written "audit" files, scrambling PANs with `MOVE`/reference-modification). That both weakens security and makes the control invisible to the auditor, who reads SMF — not your program's logic. **When in doubt, delegate to the subsystem and make the control appear in SMF.**

## When to use

- Core banking, ledger, posting, payment, transfer, statement, or onboarding (KYC) programs in Enterprise COBOL (V5/V6) on z/OS, under **CICS** (online transactions), **IMS/TM**, or **JES2/JES3 batch**.
- Any COBOL program that reads or writes passwords, card data (PAN/CVV), IBANs, national IDs (TCKN/SSN), or other PII — typically via **Db2** (embedded SQL), **VSAM**, or **QSAM** sequential data sets.
- Programs that must produce a regulator-auditable trail (PCI-DSS v4.0.1, GDPR/DORA, SOX/GLBA, KVKK/BDDK, FCA) — which on z/OS means **SMF** plus a Db2 audit policy.
- Batch posting runs where restart/recovery and double-post prevention matter (checkpoint/restart, idempotent posting keys).

If the task is storage-engine specific (Db2 column masks, native encryption, TDE), also load the matching database skill under `skills/databases/` (e.g. `db2.md`).

## Logging — what goes where

**The authoritative audit log on z/OS is SMF, not anything the COBOL program writes itself.** A program's own `DISPLAY`, SYSOUT, or flat audit file is *not* tamper-evident and is *not* what an auditor reviews. Your job in COBOL is to (a) let the subsystems emit their SMF records, (b) write a business-level audit row to a controlled store (Db2 table or log stream), and (c) **never put a secret where it can land in a log, dump, or trace.**

**Which events, which sink**

| Event | Emitted by | SMF record / sink |
|---|---|---|
| Logon, password/phrase change, failed sign-on, MFA | RACF (`RACROUTE REQUEST=VERIFY`) | **SMF type 80**, event code 1 (JOBINIT) ([ibm](https://www.ibm.com/docs/SSLTBW_3.2.0/com.ibm.zos.v3r2.icha800/chgslogon.htm)) |
| Access / denied access to a protected resource (data set, Db2 table, CICS transaction, key label) | RACF (`RACROUTE REQUEST=AUTH`) when `AUDIT`/`GLOBALAUDIT` is set | **SMF type 80** ([ibm](https://www.ibm.com/docs/SSLTBW_3.1.0/com.ibm.zos.v3r1.e0ze100/e0ze100_SMF_records.htm)) |
| RACF profile create/alter/delete | RACF | **SMF type 80** (command + profile-change events) |
| Db2 table access, authorization changes, SQL audited by policy | Db2 audit policy | **SMF type 101/102 (IFCID)** via `-START TRACE(AUDIT) ... AUDTPLCY(...)` ([ibm](https://www.ibm.com/support/knowledgecenter/SSEPEK_12.0.0/seca/src/tpc/db2z_auditpolicy.html)) |
| Business money-movement audit (who/what/when/amount/before-after) | **Your program** | append-only Db2 audit table and/or a dedicated SMF record via `SMFWTM`/log stream |
| System/subsystem activity, data set open/close, RACF | SMF globally | SMF data sets (`SYS1.MANx`) or a **log stream** (recommended) |

Enable the relevant SMF types in `SMFPRMxx` (e.g. `SYS(TYPE(...,80,101,102,...))`). RACF auditing is governed by `SETROPTS AUDIT(...)`, `SETROPTS LOGOPTIONS(...)`, and per-profile `AUDIT`/`GLOBALAUDIT` operands — set by the **security auditor**, not the application programmer. For example, `SETROPTS AUDIT(USER)` causes a password/phrase change at logon to write an SMF 80 record **regardless of what the application requests** ([ibm](https://www.ibm.com/docs/SSLTBW_3.2.0/com.ibm.zos.v3r2.icha800/chgslogon.htm)).

**What is MASKED before it can reach any sink** — PAN (show only last 4), CVV (never — see below), passwords and password phrases, OAuth/session tokens, API keys, full national IDs (TCKN/SSN), IBAN (mask all but last 4), PIN/PIN block. In COBOL this means: do not `DISPLAY` them, do not place them in a `WORKING-STORAGE` field that gets written to a trace/SYSOUT/report, and mask before any business audit write.

```cobol
       01  WS-PAN              PIC X(19).
       01  WS-PAN-MASKED       PIC X(19) VALUE SPACES.
      * Keep only the last 4 digits for any audit/report field.
       MOVE ALL "*"            TO WS-PAN-MASKED
       MOVE WS-PAN(16:4)       TO WS-PAN-MASKED(16:4)
      * Audit row carries WS-PAN-MASKED. WS-PAN itself is never
      * DISPLAYed, never written to a report, never logged.
```

**What is NEVER logged / stored / displayed:** CVV/CVC (must not be retained after authorization — PCI-DSS, FCS-LOG-001), full PAN, full track/magstripe/chip data, PIN or PIN block, plaintext passwords or phrases, clear cryptographic keys, full national IDs. A COBOL-specific trap: **a program ABEND produces a dump (SYSUDUMP/SYSABEND/CEEDUMP) that captures `WORKING-STORAGE`.** If a clear PAN or key sits in storage at ABEND time it is now in the dump data set. Minimise the lifetime of clear sensitive data, overwrite the field (`MOVE SPACES`/`INITIALIZE`) as soon as it is consumed, and ensure dump data sets are RACF-protected and (ideally) encrypted.

**Log integrity (append-only / WORM / tamper-evidence).** SMF is designed as an append-only audit source: records are written sequentially and offloaded; the SMF data sets / log stream must be RACF-protected so the application ID cannot alter or delete them, and should be encrypted and retained per the applicable framework (PCI-DSS v4.0.1 **Req. 10** and SOX both require tamper-evident retention). For a business audit table in Db2, revoke `UPDATE`/`DELETE` from the application plan/role (grant `INSERT` only), and optionally hash-chain rows (`row.hash = SHA-256(prev_hash || canonical(row))`, computed via ICSF `CSNBOWH` one-way hash) so an altered or deleted row breaks the chain. Keep hosts time-synced (STP/NTP) so SMF and audit timestamps are trustworthy.

## Workflow — payment / transfer / onboarding

On the mainframe there are two execution contexts with **different integrity machinery**: **CICS online** (transactional, syncpoint-managed) and **batch** (checkpoint/restart). Get the context right.

### CICS online transfer — canonical step order

1. **Authenticate & authorize via RACF, not in the program.** The CICS transaction is RACF-protected (TCICSTRN/GCICSTRN class); the signed-on userid is established by CICS. Inside the program, verify *entitlement to this specific account* against a RACF resource or an authorization table — fail closed (deny on any error).
2. **Validate at the boundary.** Numeric money fields as **packed decimal** (`PIC S9(13)V99 COMP-3`) — **never `COMP-1`/`COMP-2` (float)** for money (core rule). Check sign, range, currency, and that the amount is positive. Reject on `NUMERIC` class-test failure before use.
3. **Idempotency gate.** Require a client idempotency key; look it up first (unique index on the ledger/idempotency table). If already present, return the stored result — do **not** re-execute. Insert the key in the *same unit of work* as the posting so a concurrent retry collides on the unique constraint instead of double-spending.
4. **Approval / screening gates before funds move.** Enforce maker-checker / dual control and limit thresholds; for onboarding, KYC/sanctions screening must pass before the account is usable (FCS-AML-001); for in-scope payments apply the AML/sanctions hold (MASAK/OFAC/EU lists).
5. **Execute inside one unit of work.** Debit source, credit destination, write ledger entries, and write the **audit row** — all between syncpoints. Use `EXEC CICS SYNCPOINT` to commit or `EXEC CICS SYNCPOINT ROLLBACK` to back everything out. Under CICS, Db2/VSAM/MQ updates in the UOW are coordinated by **two-phase commit** (CICS is the coordinator) — if any resource cannot commit, all roll back ([ibm](https://www.ibm.com/docs/SSEPEK_12.0.0/apsg/src/tpc/db2z_unitworkcics.html)). An audit row must never persist for a transfer that rolled back, and vice-versa — hence it goes **inside** the UOW.
6. **Emit downstream events only after commit** (e.g. put to MQ *in syncpoint* so the message is delivered only if the UOW commits).

### Batch posting

- Make each posting **idempotent** (unique business key per posting line) so a restart cannot double-post.
- Use **checkpoint/restart** (DFSORT/own checkpoint or a restart table recording the last committed key). On restart, resume after the last committed commit-point — do not reprocess committed work.
- Commit on an interval (`COMMIT` in embedded SQL for Db2; for VSAM-RLS/MQ use RRS), and write the audit row in the same commit scope. A batch job updating Db2 and MQ/VSAM-RLS uses **RRS (Resource Recovery Services)** as the two-phase-commit coordinator.

**Concurrency / locking model:**

- **Db2 (embedded SQL):** rows are locked by the SQL you issue. For a hot balance row take a write lock up front with `SELECT ... FOR UPDATE WITH RS` (or `WITH RR` where you need repeatable reads); Db2's isolation (`CS` cursor stability is the common default, `RR`/`RS` stronger) is set per plan/package or statement. For optimistic concurrency use an `UPDATE ... WHERE balance = :old-balance AND version = :old-version` and check `SQLCODE +100`/zero rows updated → retry. **Always acquire locks on multiple accounts in a deterministic order (e.g. ascending account id)** to prevent deadlocks on transfers; set a lock timeout so a stuck UOW fails rather than hangs.
- **VSAM:** under CICS use the file's update-with-hold semantics (`EXEC CICS READ ... UPDATE` holds the record until `REWRITE`/`SYNCPOINT`); for cross-region sharing use **VSAM RLS** with RRS so locks and recovery are coordinated.
- Never rely on program-level flags for mutual exclusion — the subsystem lock manager is the source of truth.

## Hashing & encryption

The rule is **all crypto goes through ICSF to the hardware (CPACF / Crypto Express), keyed by keys that never appear in the clear in your program.** Do not write a cipher in COBOL, and never embed a key constant in the load module (refusal FCS-SECRET-002/FCS-CRYPTO-001).

### Hashed one-way (passwords, integrity hashes)

- **User passwords are RACF's job, not the program's.** RACF stores password/phrase verifiers using **KDFAES** (key-derivation using AES, salted and iterated) when enabled via `SETROPTS PASSWORD(ALGORITHM(KDFAES))`. A COBOL program **authenticates by calling RACF** (`RACROUTE REQUEST=VERIFY`, or via the signed-on CICS/TSO userid) — it must **never** read, store, or hash a password itself. If you find a program storing or comparing passwords, that is a refusal-policy violation (FCS-SECRET-001/FCS-LOG-001).
- **One-way hashes for data integrity / hash-chaining** use ICSF **One-Way Hash Generate** `CSNBOWH` with **SHA-256/384/512**. **Forbidden:** MD5, SHA-1 for integrity, and any home-grown "hash" built from `MOVE`/arithmetic (FCS-CRYPTO-001).

### Encrypted two-way (data you must recover: PAN*, IBAN, national ID)

> *PAN: the right answer is usually **don't store it** — tokenize via the processor/switch (network token or gateway token). Store CVV **never** (PCI-DSS, FCS-SAD-001). Encrypt PAN only if you are a PCI-scoped entity that genuinely must retain it.

Two layers, both AES-256, both hardware-accelerated by **CPACF** with keys protected by **ICSF**:

**1. Transparent at-rest encryption (preferred — no application crypto code):**
- **DFSMS data set encryption (pervasive encryption):** VSAM/QSAM/sequential data sets are encrypted/decrypted transparently by the access methods. You assign a **key label** pointing to an **AES-256 DATA key in the ICSF CKDS**; the label is attached via the **RACF generic-profile DFP segment** (`ALTDSD '...' DFP(RESOWNER(...) DATAKEY(keylabel))`) or an SMS data class, and stored in the catalog ([ibm](https://ibm.com/docs/en/zos/2.5.0?topic=encryption-setting-up-zos-data-set)). RACF checks the user's authority to the key label via the **CSFKEYS** and **CSFSERV** classes before any decryption ([ibm](https://www.ibm.com/docs/SSJL4D_latest/configuring/cics/data-set-encryption-process.html)). The COBOL program reads/writes normally and holds no key.
- **Db2 for z/OS:** use DFSMS data set encryption on the table space/log/archive data sets (key label via the Db2 subsystem), and/or Db2 native encryption, so cardholder/PII columns are encrypted at rest with ICSF-managed keys ([ibm](https://www.ibm.com/docs/en/SSEPEK_12.0.0/seca/src/tpc/db2z_encryptionsetupexample.html)).

**2. Explicit field/column crypto via ICSF (when a specific field must be encrypted in the record itself):**
- Call **Symmetric Key Encipher `CSNBSYE` / `CSNBSYE1`** (and `CSNBSYD`/`CSNBSYD1` to decipher) for AES. These support modes including **GCM** (authenticated encryption) ([ibm](https://www.ibm.com/docs/en/zos/2.5.0?topic=data-symmetric-key-encipher-csnbsye-csnbsye1-csnesye-csnesye1)). Use **AES-256-GCM**: a **unique 96-bit IV per encryption** (never reused with the same key), a **128-bit auth tag**, and bind context as AAD (e.g. account id). Store IV + tag alongside ciphertext (they are not secret).
- The key is referenced by its **CKDS key label**, not its value: use a **secure key** (wrapped under the ICSF master key in the Crypto Express HSM) or a **protected key** (CPACF wrapping key) so the clear key never enters program storage. **Protected-key CPACF** gives HSM-grade key protection at CPACF speed ([ibm](https://www.ibm.com/docs/en/zos/3.2.0?topic=management-protected-key-cpacf)).

```cobol
      * AES encrypt a field via ICSF Symmetric Key Encipher (CSNBSYE1).
      * The key is a LABEL into the CKDS -- the clear key is never in storage.
      * IV is 12 random bytes from ICSF Random Number Generate (CSNBRNG);
      * mode/tag are set in the rule/chaining-vector parameters.
       CALL 'CSNBRNG'  USING WS-RETURN-CODE WS-REASON-CODE
                             WS-EXIT-LENGTH WS-EXIT-DATA
                             WS-IV-FORM     WS-IV-12BYTE
           END-CALL
           IF WS-RETURN-CODE NOT = 0
               PERFORM CRYPTO-FAILURE          *> fail closed; do NOT store clear
           END-IF

           CALL 'CSNBSYE1' USING WS-RETURN-CODE WS-REASON-CODE
                                 WS-EXIT-LENGTH WS-EXIT-DATA
                                 WS-KEY-LABEL          *> AES-256 key label in CKDS
                                 WS-KEY-PARMS
                                 WS-BLOCK-SIZE
                                 WS-IV-12BYTE          *> unique per encryption
                                 WS-RULE-ARRAY-COUNT
                                 WS-RULE-ARRAY         *> e.g. 'AES     ' 'GCM     '
                                 WS-PLAINTEXT-LENGTH
                                 WS-PLAINTEXT
                                 WS-CIPHERTEXT-LENGTH
                                 WS-CIPHERTEXT
                                 WS-CHAIN-VECTOR
           END-CALL
           IF WS-RETURN-CODE NOT = 0
               PERFORM CRYPTO-FAILURE
           END-IF
           INITIALIZE WS-PLAINTEXT                *> overwrite clear data ASAP
```

**Key management:** master keys live in the **Crypto Express HSM**; operational keys live wrapped in the **CKDS** and are referenced by **label**. Access to key labels and ICSF services is RACF-controlled via **CSFKEYS** (per-key) and **CSFSERV** (per-service) classes — so "who can decrypt" is itself audited in SMF 80. Rotate keys by generating a new labelled key and re-enciphering (ICSF supports key rotation / re-wrap); support decrypting old-key data during the rollover.

**Forbidden (FCS-CRYPTO-001, FCS-SECRET-002):** any cipher implemented in COBOL (reference-modification "scrambling", XOR, `MOVE`-based obfuscation); a key literal in the program or a copybook; a static/reused IV; AES-ECB for structured data; DES/3DES for new work; reading a clear key into `WORKING-STORAGE`; disabling TLS/AT-TLS for data in transit (FCS-TLS-001). Use **AT-TLS** (policy-based TLS in the TCP/IP stack) or z/OS System SSL for sensitive transport — TLS 1.2+.

## Country differences (how the same COBOL/z/OS code changes)

Same programs, controls toggled by region and by subsystem configuration (prefer a config/parameter table over `IF COUNTRY = ...` scattered through business logic):

- **EU — GDPR, PSD2, DORA.** PSD2 **SCA**: add a step-up authentication + **dynamic linking** gate (bind auth to amount+payee) in the online transfer path. GDPR: design PII for erasure — **crypto-shredding** maps naturally to the mainframe: destroy/retire the ICSF key label for a record set and the DFSMS/Db2-encrypted data becomes unrecoverable. **DORA** (in force Jan 2025): ICT operational resilience, incident reporting, and tested recovery — your SMF retention, Db2 audit policy, and CICS/RRS recovery procedures are evidence for it.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trail + segregation of duties on financial-reporting paths — enforce via RACF (separate the IDs that can post from those that can alter ledger/audit objects) and append-only audit tables; SMF 80 is the SOX access evidence. GLBA Safeguards Rule: encrypt customer financial data at rest (DFSMS/Db2 encryption) and in transit (AT-TLS), with access logging. CCPA/CPRA: same deletion/crypto-shred design as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (GDPR-like) governs personal-data processing and explicit consent. **BDDK data-localization:** Turkish banking data must be stored/processed **in Turkey** — the sysplex, Db2, CKDS/HSM, SMF archives, and backups must be in-region; make residency a deployment boundary. **MASAK:** AML/suspicious-transaction reporting hooks in onboarding/transfer are mandatory. National ID = **TCKN** (11 digits, with a checksum) — treat as encrypted PII, mask in every report/audit field, validate the checksum.
- **UK — FCA, UK GDPR, PRA.** FCA operational-resilience and reporting; UK GDPR mirrors EU GDPR; SCA still applies under the UK PSRs. Same SCA and crypto-shred machinery as EU, different reporting endpoints and retention windows.

## Good example

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. XFER01.
      *----------------------------------------------------------------*
      * CICS online funds transfer. Integrity via SYNCPOINT (2PC).     *
      * Money in packed decimal (never COMP-1/2). No crypto, no        *
      * passwords, no PAN/CVV in this program. Audit row written INSIDE *
      * the unit of work. Locks taken in deterministic order.          *
      *----------------------------------------------------------------*
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
       01  WS-AMOUNT           PIC S9(13)V99 COMP-3.
       01  WS-SRC-ACCT         PIC X(18).
       01  WS-DST-ACCT         PIC X(18).
       01  WS-LOW-ACCT         PIC X(18).
       01  WS-HIGH-ACCT        PIC X(18).
       01  WS-IDEMP-KEY        PIC X(36).
       01  WS-SRC-BAL          PIC S9(13)V99 COMP-3.
       01  WS-ACTOR            PIC X(8).
       PROCEDURE DIVISION.
      * 1. RACF established the signed-on user; confirm entitlement.
           EXEC CICS ASSIGN USERID(WS-ACTOR) END-EXEC
           PERFORM CHECK-ENTITLEMENT      *> fail closed on any non-zero
      * 2. Validate amount (positive, numeric, right currency) BEFORE use.
           IF WS-AMOUNT NOT POSITIVE
               PERFORM REJECT-INVALID-AMOUNT
           END-IF
      * 3. Idempotency: a seen key short-circuits (no double-spend).
           EXEC SQL
               SELECT RESULT_CODE INTO :WS-RESULT
               FROM   IDEMPOTENCY
               WHERE  IDEMP_KEY = :WS-IDEMP-KEY
           END-EXEC
           IF SQLCODE = 0
               PERFORM RETURN-STORED-RESULT     *> already done; stop
           END-IF
      * 5. One unit of work. Lock in deterministic (ascending) order.
           IF WS-SRC-ACCT < WS-DST-ACCT
               MOVE WS-SRC-ACCT TO WS-LOW-ACCT
               MOVE WS-DST-ACCT TO WS-HIGH-ACCT
           ELSE
               MOVE WS-DST-ACCT TO WS-LOW-ACCT
               MOVE WS-SRC-ACCT TO WS-HIGH-ACCT
           END-IF
           EXEC SQL
               SELECT BALANCE INTO :WS-SRC-BAL FROM ACCOUNT
               WHERE  ACCT_ID = :WS-LOW-ACCT  FOR UPDATE WITH RS
           END-EXEC
           EXEC SQL
               SELECT BALANCE FROM ACCOUNT
               WHERE  ACCT_ID = :WS-HIGH-ACCT FOR UPDATE WITH RS
           END-EXEC
           EXEC SQL
               SELECT BALANCE INTO :WS-SRC-BAL FROM ACCOUNT
               WHERE  ACCT_ID = :WS-SRC-ACCT
           END-EXEC
           IF WS-SRC-BAL < WS-AMOUNT
               EXEC CICS SYNCPOINT ROLLBACK END-EXEC
               PERFORM REJECT-INSUFFICIENT-FUNDS
           END-IF
      * 4->5. Apply debit + credit + ledger + AUDIT in the same UOW.
           EXEC SQL UPDATE ACCOUNT SET BALANCE = BALANCE - :WS-AMOUNT
                    WHERE ACCT_ID = :WS-SRC-ACCT END-EXEC
           EXEC SQL UPDATE ACCOUNT SET BALANCE = BALANCE + :WS-AMOUNT
                    WHERE ACCT_ID = :WS-DST-ACCT END-EXEC
           EXEC SQL INSERT INTO LEDGER
                    (IDEMP_KEY, SRC, DST, AMT, TS)
                    VALUES (:WS-IDEMP-KEY, :WS-SRC-ACCT, :WS-DST-ACCT,
                            :WS-AMOUNT, CURRENT TIMESTAMP) END-EXEC
           EXEC SQL INSERT INTO AUDIT_LOG            *> INSERT-only role
                    (ACTOR, ACTION, SRC, DST, AMT, TS)
                    VALUES (:WS-ACTOR, 'TRANSFER', :WS-SRC-ACCT,
                            :WS-DST-ACCT, :WS-AMOUNT, CURRENT TIMESTAMP)
           END-EXEC
           IF SQLCODE NOT = 0
               EXEC CICS SYNCPOINT ROLLBACK END-EXEC  *> all-or-nothing
               PERFORM HANDLE-SQL-ERROR
           END-IF
      * Commit everything (Db2 + any VSAM/MQ) via two-phase commit.
           EXEC CICS SYNCPOINT END-EXEC
           PERFORM RETURN-OK.
```

RACF/SMF audits *who touched what*; the `AUDIT_LOG` row records *the business act*; crypto and at-rest protection are handled by DFSMS/Db2 + ICSF outside this program.

## Bad example

```cobol
      * Every line below crosses a red line -- refuse to write this.
       01  WS-PAN      PIC X(16).
       01  WS-CVV      PIC X(4).
       01  WS-PW       PIC X(20).
       01  WS-KEY      PIC X(16) VALUE 'HARDCODEDSECRET1'.   *> key in source (FCS-SECRET-002/FCS-CRYPTO-001)
       01  WS-AMOUNT   COMP-2.                               *> float money (core rule)

           DISPLAY 'CHARGING PAN ' WS-PAN ' CVV ' WS-CVV.    *> logs PAN+CVV (FCS-PAN-001/FCS-SAD-001/FCS-LOG-001)

           EXEC SQL INSERT INTO CARDS (PAN, CVV, PW)         *> stores CVV + plaintext pw
                    VALUES (:WS-PAN, :WS-CVV, :WS-PW) END-EXEC  *> FCS-PAN-001/FCS-SAD-001/FCS-SECRET-001

      * "encrypt" by XOR-ing with a constant key -- home-rolled crypto
           PERFORM VARYING I FROM 1 BY 1 UNTIL I > 16
               COMPUTE WS-ENC(I:1) =
                   FUNCTION CHAR(... WS-PAN(I:1) ... WS-KEY(I:1))  *> FCS-CRYPTO-001
           END-PERFORM

      * move money with no lock, no idempotency, no audit, no syncpoint
           EXEC SQL UPDATE ACCOUNT SET BALANCE = BALANCE - WS-AMOUNT
                    WHERE ACCT_ID = :WS-SRC END-EXEC           *> lost update
           EXEC SQL UPDATE ACCOUNT SET BALANCE = BALANCE + WS-AMOUNT
                    WHERE ACCT_ID = :WS-DST END-EXEC           *> no audit (FCS-AUDIT-001)
           GOBACK.                                             *> no SYNCPOINT: partial post risk
```

Red lines crossed: storing/logging PAN & CVV (PCI-DSS, FCS-PAN-001/FCS-SAD-001/FCS-LOG-001); storing a plaintext password (FCS-SECRET-001); hardcoded key + home-rolled XOR "crypto" instead of ICSF/CPACF (FCS-SECRET-002/FCS-CRYPTO-001); floating-point money (core rule); no lock → lost update; no idempotency → double-post on retry; no audit row on money movement (FCS-AUDIT-001); no `SYNCPOINT` → a mid-transaction failure leaves the debit without the credit. The compliant alternative is the *Good example* above: delegate auth to RACF, crypto to ICSF/DFSMS, integrity to CICS syncpoint, and never let a secret reach storage, a report, a dump, or SMF in the clear. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md).
