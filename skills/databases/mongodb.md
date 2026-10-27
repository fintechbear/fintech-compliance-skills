# Skill: MongoDB for Regulated Fintech

**Purpose.** Make an AI coding agent configure and use MongoDB safely in a regulated
financial system — so PII, card data, and money-movement records are encrypted,
access-controlled, audited, and retained correctly at the *storage* layer. Load this
skill whenever the datastore is MongoDB (self-managed Enterprise/Community, or Atlas)
and it holds customer PII, card data (PAN/CVV), IBANs, national IDs, transaction
ledgers, KYC/AML decisions, or anything an auditor will later inspect. Always load it
together with [`refusal/refusal-policy.md`](../refusal/refusal-policy.md); load the
matching regional file for the user's jurisdiction and the language skill for the
driver you use.

## When to use

Load this skill when any of the following is true and the datastore is MongoDB:

- You store or query PII, card data (PAN/CVV), IBANs, national IDs, or KYC documents.
- You persist money movement (transfers, charges, ledger entries) or their audit trail.
- You configure a cluster's security posture: authentication, authorization (RBAC),
  TLS, encryption at rest, auditing, or data retention.
- You design collections/schemas that an auditor, regulator, or DPO will inspect.
- You write application code (any driver) that reads/writes sensitive fields.

If the task only reads a non-sensitive reference collection with no PII and no money,
you may not need this skill — but if in doubt, load it. **Fast = something was skipped.**

> **Edition matters.** Several storage-side controls below are **MongoDB Enterprise
> Advanced** or **Atlas** features, *not* Community: native **encryption at rest**
> (WiredTiger), the **auditing** facility, **LDAP/Kerberos** external auth, and
> **log redaction** (`redactClientLogData`). CSFLE/Queryable Encryption automatic
> encryption needs Enterprise/Atlas (the `mongocryptd`/Automatic Encryption Shared
> Library); *explicit* (manual) client-side encryption works with Community drivers +
> `libmongocrypt`. Always confirm the deployment edition before relying on a control;
> if the user is on Community, say which controls are unavailable and give the
> compensating control (e.g. explicit CSFLE + disk-level LUKS/cloud-provider
> encryption instead of native WiredTiger at-rest).

---

## Logging — what goes where

MongoDB produces several distinct log/record streams. Keep them straight, because they
have different sensitivity and different retention duties:

1. **Diagnostic log** (`mongod`/`mongos` `systemLog`) — operational: startup, elections,
   slow queries, connection churn. Can **leak data** (query predicates, document
   contents) into slow-query/`COMMAND` lines unless redacted.
2. **Audit log** (Enterprise/Atlas only) — the security evidence trail: auth,
   authorization failures, role/user changes, DDL, and (optionally) CRUD on sensitive
   collections.
3. **Application audit records** — business events you write yourself into an
   append-only collection (money moved, KYC decision), with actor, correlation id,
   idempotency key.

### Which events, which sink, which level

| Event | Sink | Notes |
|-------|------|-------|
| Auth success/failure, user/role create/drop/grant | **Audit log** (`authenticate`, `createUser`, `dropUser`, `createRole`, `grantRolesToUser`) | Actor, source IP, outcome — never the credential |
| Authorization failure (RBAC denial) | **Audit log** (`authCheck` on failure) | Who tried what on which namespace |
| Schema/DDL change (`createCollection`, `dropCollection`, `createIndex`, `dropDatabase`) | **Audit log** | Change-management evidence (SOX) |
| Money movement (transfer, charge, refund, reversal) | **Application audit collection** (append-only) | Correlation id, idempotency key, actor, amount (Decimal128), currency, internal account ids — never PAN |
| Access to another party's financial data | **Application audit collection** + optional audit-log `authCheck` on reads of that namespace | Actor, target, authorization decision |
| KYC/AML/sanctions decision | **Application audit collection** | The *decision*, rule id, case id — never the raw document |
| Slow query / `COMMAND` diagnostics | **Diagnostic log** (non-prod verbosity in prod) | **Must run with `redactClientLogData`** so predicates/values are stripped |
| Unhandled driver/server error | App log + alerting | Stack trace scrubbed of PII; no query values |

Route the **audit log** and **application audit collection** to storage separate from
the noisy diagnostic log, retain per regulation (commonly **5–7 years**; see your
regional skill), and protect them from edit/delete. Disabling audit logging on money
movement is a hard red line (FCS-AUDIT-001).

### What is MASKED before it reaches any sink

- **PAN** → store/display only first 6 (BIN) + last 4, e.g. `411111******1111`. A full
  PAN in any log is a PCI-DSS violation.
- **CVV / CVC2 / track / PIN** → **never logged in any form, ever**, and never stored
  after authorization (PCI-DSS).
- **Passwords, API keys, bearer/OAuth tokens, session cookies, private keys, the CSFLE
  data-encryption keys** → never logged.
- **National ID / tax id / SSN / TCKN** → masked or dropped.
- **Full IBAN** → mask to last 4 for display; store encrypted (see below).

### Structured logging + redaction mechanism (MongoDB-specific)

- **Diagnostic log:** `mongod` writes **structured JSON logs** (one JSON object per
  line) since 4.4 — ship them to your SIEM and query by field. Run the server with
  **log redaction** so field *values* (query predicates, document data) are replaced
  with `###` in the diagnostic log, leaving metadata intact:

  ```yaml
  # mongod.conf  — Enterprise/Atlas only
  security:
    redactClientLogData: true          # strip data values from the diagnostic log
  ```

  This is the control that stops a slow-query line from quietly dumping a PAN or a
  national ID into the operational log. Without it, `COMMAND` and slow-query entries
  echo the query shape **and the literal values**.

- **Application audit records:** write them as documents into an append-only
  collection and let your language's structured logger (see the matching language
  skill — `structlog`, Logback JSON encoder, zap, etc.) carry only safe fields. Never
  pass a raw document or a sensitive field into a log formatter.

### Log integrity (append-only / WORM / hash chain)

MongoDB has no native WORM mode, so make the application audit collection tamper-evident:

- **Deny `update`/`delete`/`remove` on the audit collection** via a custom RBAC role
  (grant only `insert` + `find`) so even the app identity cannot rewrite history.
  Enforce it in the database, not just the app.
- **Hash-chain** each audit document: store
  `prevHash` and `hash = SHA-256(prevHash || canonicalBson(doc))`. A broken chain
  proves tampering. Use SHA-256 — never MD5/SHA-1 for integrity (FCS-CRYPTO-001).
- For the **audit log** stream, write it to an **append-only destination** (syslog to a
  WORM/object-lock sink, e.g. S3 Object Lock in compliance mode) and alert on any
  attempt to disable auditing. The audit log file on the host can be tampered with by
  root, so ship it off-box promptly.

---

## Workflow — payment / transfer / onboarding

The backbone is the same for a card charge, an account transfer, and a KYC onboarding:
**authenticate → authorize (RBAC) → validate → idempotency gate → do the work in one
multi-document transaction → write the audit document → commit.**

### Step order (transfer / payment)

1. **Authenticate** the connection (SCRAM, x.509/mTLS, or LDAP/Kerberos — see TLS
   section). The application connects as a **least-privilege role**, never as root.
2. **Authorize** the action in app logic + rely on the DB role as the backstop
   (deny-by-default). The app's DB user must not hold `dropDatabase`, `dropCollection`,
   or write access to collections it should only read.
3. **Validate input** at the boundary (driver-side + **JSON Schema validator** on the
   collection, below). Reject malformed amounts/currencies/account ids.
4. **Idempotency gate.** Require a client idempotency key; use a **unique index** on it
   so a retry cannot double-apply (a duplicate insert fails with `E11000` — treat that
   as "already applied" and return the prior result).
5. **Approval gate** where required: amount over a threshold, new payee, or **PSD2 SCA**
   for EU remote payments — an extra authorization bound to amount+payee *before* money
   moves.
6. **Execute inside one multi-document transaction** (below): debit, credit/ledger
   entry, persist the idempotency record, and insert the audit document — all atomic.
7. **Commit.** On any error, the transaction aborts and nothing partial survives.

Money is stored as **`Decimal128`** (BSON `decimal` type, via the driver's
`Decimal128`), never a BSON `double` — binary floats cannot represent `0.10` exactly
and will drift. Represent amounts as `Decimal128` or integer **minor units**.

### Concurrency / locking model

- MongoDB uses **WiredTiger document-level concurrency control** with **optimistic
  concurrency**: concurrent writers to *different* documents proceed in parallel;
  concurrent writers to the *same* document conflict and MongoDB retries internally.
- **Multi-document ACID transactions** (replica set / sharded cluster) give atomicity
  across the debit, credit, idempotency, and audit writes. Transactions use
  **snapshot** isolation; a write conflict surfaces as a **`TransientTransactionError`**,
  which the driver's convenient-transaction API (`withTransaction`) **retries
  automatically**. Keep transactions short.
- Where you don't need a full transaction, prefer a **single atomic document update**
  with operators (`$inc`, `$set`) and **guard conditions in the query filter** (e.g.
  `{ _id, balance: { $gte: amount } }`) so the balance check and debit are one atomic
  op — this is the document-model equivalent of optimistic locking and avoids the
  read-modify-write race.

```javascript
// Atomic, idempotent, audited transfer — Node.js driver, replica set required.
// Money as Decimal128; audit row written in the SAME transaction as the money move.
const { MongoClient, Decimal128 } = require("mongodb");

async function transfer(client, { srcId, dstId, amount, idemKey, actor }) {
  const db = client.db("bank");
  const accounts = db.collection("accounts");
  const audit    = db.collection("audit");      // insert-only role (see RBAC)
  const idem      = db.collection("idempotency"); // unique index on `key`
  const amt = Decimal128.fromString(amount);     // never a JS float

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {   // auto-retries TransientTransactionError
      // idempotency gate: unique index makes a replay fail loudly instead of double-paying
      try {
        await idem.insertOne({ key: idemKey, status: "applied", at: new Date() }, { session });
      } catch (e) {
        if (e.code === 11000) throw new Error("ALREADY_APPLIED"); // E11000 duplicate key
        throw e;
      }

      // atomic debit guarded by sufficient-funds filter — no read-modify-write race
      const debit = await accounts.updateOne(
        { _id: srcId, balance: { $gte: amt } },
        { $inc: { balance: Decimal128.fromString("-" + amount) } },
        { session }
      );
      if (debit.modifiedCount !== 1) throw new Error("INSUFFICIENT_FUNDS");

      await accounts.updateOne({ _id: dstId }, { $inc: { balance: amt } }, { session });

      await audit.insertOne({                      // audit record, same transaction
        action: "transfer", src: srcId, dst: dstId,
        amount: amt, currency: "EUR", actor, idemKey, at: new Date()
      }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
}
```

`writeConcern: { w: "majority" }` ensures the committed transfer survives a primary
failover (durability — important for a ledger). Pair with `readConcern: "majority"`/
`"snapshot"` so you never act on rolled-back reads.

### Onboarding / KYC variation

Same backbone, different middle: validate identity input → run KYC/AML/sanctions
screening (never skip — FCS-AML-001) → persist the **decision + case id** to the
append-only audit collection → gate account activation on a passing decision. Store raw
identity documents **encrypted** (CSFLE, below); write only the decision to logs and
audit, never the document contents.

---

## Hashing & encryption

The dividing line: **one-way hash things you only ever need to *verify*** (passwords);
**two-way encrypt things you must *read back*** (PAN, IBAN, national ID). MongoDB offers
layered storage-side encryption; use the right layer for the threat you are defending
against.

### What is HASHED one-way (passwords)

MongoDB is **not** your password store for application users. Application passwords are
hashed **in the application layer** with a memory-hard algorithm — **Argon2id**
(OWASP-recommended) or **bcrypt** as fallback — and only the hash string is stored in a
Mongo document. See the matching **language** skill for the concrete library
(`argon2-cffi`, Spring Security, `golang.org/x/crypto/argon2`, etc.). **MD5 and SHA-1/
SHA-2 are not password hashes** (refusal FCS-SECRET-001/FCS-CRYPTO-001).

MongoDB's *own* database-user credentials use **SCRAM-SHA-256** (salted challenge-
response) by default for auth — that is the server's internal mechanism, separate from
your application users. Prefer SCRAM-SHA-256 over the legacy SCRAM-SHA-1.

### What is ENCRYPTED two-way — three layers

**Layer 1 — Encryption at rest (WiredTiger, Enterprise/Atlas).** Defends against theft
of the physical disk/backup. Transparent to the application.

- Self-managed **Enterprise Advanced**: WiredTiger native encryption with **AES-256**.
  Default cipher is **AES-256-CBC**; **AES-256-GCM** is available **on Linux only** (not
  Windows). Manage the master key with a **KMIP-compliant KMS/HSM** — do **not** use a
  local keyfile in production (a keyfile on the same host protects against nothing if
  the host is compromised).
- **Atlas**: data is **always** encrypted at rest with AES-256 using the cloud
  provider's disk encryption (cannot be disabled); you may additionally bring your own
  key via **Customer Key Management** (AWS KMS / GCP KMS / Azure Key Vault) for
  envelope encryption and crypto-shredding.
- **Community Edition has no native at-rest encryption** — use **OS/volume encryption**
  (LUKS, dm-crypt, cloud provider EBS/PD encryption) as the compensating control.

```yaml
# mongod.conf — self-managed Enterprise, KMIP-backed at-rest encryption (preferred)
security:
  enableEncryption: true
  kmip:
    serverName: kmip.internal.example.com
    port: 5696
    clientCertificateFile: /etc/mongo/kmip-client.pem
    serverCAFile: /etc/mongo/kmip-ca.pem
# encryptionCipherMode defaults to AES256-CBC; AES256-GCM is Linux-only.
# Do NOT use `security.encryptionKeyFile` (local keyfile) in production.
```

> At-rest encryption protects data **only when the disk is at rest**. It does **not**
> protect against a compromised DBA, a leaked connection, or an attacker with query
> access — those see plaintext. For field-level confidentiality against the database
> operator itself, use Layer 3.

**Layer 2 — Encryption in transit (TLS).** See the TLS subsection below — mandatory for
any sensitive data (FCS-TLS-001).

**Layer 3 — In-use / client-side field encryption (CSFLE & Queryable Encryption).**
The strongest storage-side control: fields are encrypted **in the driver, on the
client, before** they reach the server, so the server, its logs, its backups, and even
a MongoDB/Atlas operator **only ever see ciphertext**. This is the control that lets you
store a PAN, IBAN, or national ID where the database itself cannot read it.

- **CSFLE (Client-Side Field Level Encryption)** — GA. Two algorithms:
  - **Deterministic** (`AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic`): the same
    plaintext always yields the same ciphertext, so you can run **equality queries** on
    the field. The trade-off: deterministic encryption leaks equality/frequency, so use
    it only on high-cardinality values you must look up by (don't use it on low-entropy
    fields like a boolean or a country code).
  - **Random** (`AEAD_AES_256_CBC_HMAC_SHA_512-Random`): maximum confidentiality, **not
    queryable**. Use for fields you only ever read back after fetching the document (CVV
    must never be stored at all, but e.g. a scanned ID image, a full IBAN you don't
    query on).
- **Queryable Encryption (QE)** — GA since **MongoDB 7.0** for **equality**; **range**
  queries are GA in 8.0+. It uses a structured-encryption scheme so the server can run
  those queries **without** deterministic encryption's frequency leakage — prefer QE
  over deterministic CSFLE when you need to query an encrypted field. **Prefix/suffix/
  substring** queries are **public preview only in 8.2 — do NOT enable them in
  production** (the preview format is incompatible with the future GA and is not
  supported for production data).
- **Crypto primitive:** both CSFLE and QE encrypt field values with the authenticated
  **AEAD AES-256-CBC** algorithm (HMAC-SHA-512 for integrity). The **Data Encryption
  Keys (DEKs)** live in a **key vault collection**, and each DEK is itself wrapped by a
  **Customer Master Key (CMK)** held in a **KMS** (AWS KMS, Azure Key Vault, GCP KMS, or
  KMIP/HashiCorp Vault) — envelope encryption. **Never** use a local-filesystem master
  key outside dev/demo.

```javascript
// CSFLE: encrypt `nationalId` deterministically (queryable by equality) and
// `idDocument` randomly (not queryable). Driver + libmongocrypt; KMS holds the CMK.
const kmsProviders = { aws: { accessKeyId: "...", secretAccessKey: "..." } }; // from secret mgr, NOT source
const keyVaultNamespace = "encryption.__keyVault";

const schemaMap = {
  "bank.customers": {
    bsonType: "object",
    encryptMetadata: { keyId: [DEK_ID] },           // DEK id from the key vault
    properties: {
      nationalId: {
        encrypt: { bsonType: "string",
          algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic" } // equality-queryable
      },
      idDocument: {
        encrypt: { bsonType: "binData",
          algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random" }        // read-back only
      }
    }
  }
};

const secureClient = new MongoClient(uri, {
  autoEncryption: { keyVaultNamespace, kmsProviders, schemaMap }
});
// Inserts/reads of customers now encrypt/decrypt nationalId & idDocument transparently.
// The server stores and returns only ciphertext for those fields.
```

### Key management, rotation, what is FORBIDDEN

- **CMKs live in a KMS/HSM**, never in source, env files committed to git, `mongod.conf`,
  or the database next to the data. DEKs live in the key-vault collection, encrypted by
  the CMK.
- **Rotate** the CMK and DEKs on a schedule and on suspected compromise; CSFLE/QE
  support **key rotation** via `rewrapManyDataKey` (re-wrap DEKs under a new CMK without
  re-encrypting every document). For at-rest, MongoDB supports **master key rotation**
  (KMIP) without re-encrypting the whole dataset.
- **Crypto-shredding** for GDPR/KVKK right-to-erasure: destroy a per-subject DEK and the
  subject's encrypted fields become unrecoverable — a practical "delete" when physical
  purge is hard.
- **Forbidden (red lines, refusal FCS-SECRET-002/FCS-CRYPTO-001/FCS-TLS-001):** local master keyfile in production,
  hardcoded keys, home-rolled crypto, MD5/SHA-1 for integrity or passwords, ECB mode,
  storing CVV at all, and disabling TLS certificate validation.

### TLS (in transit) — mandatory

Encrypt all client↔server and intra-cluster traffic. Never allow plaintext for
sensitive data (FCS-TLS-001).

```yaml
# mongod.conf — require TLS, validate certs. Atlas enables TLS by default.
net:
  tls:
    mode: requireTLS                       # reject any non-TLS connection
    certificateKeyFile: /etc/mongo/server.pem
    CAFile: /etc/mongo/ca.pem
    # allowConnectionsWithoutCertificates: false  # require client certs (mTLS)
    # DO NOT set tlsAllowInvalidCertificates / tlsAllowInvalidHostnames in production
```

- Use **`requireTLS`** in production; use valid CA-signed certificates. MongoDB enforces
  a **minimum 128-bit cipher** strength.
- **`allowInvalidCertificates` / `allowInvalidHostnames`** disable the checks that stop
  MITM — forbidden in production (FCS-TLS-001). An invalid cert is *only* enough to
  establish the TLS pipe, never enough to authenticate.
- For strong auth, use **x.509 client certificates (mTLS)** or **LDAP/Kerberos**
  (Enterprise) instead of password auth where your environment supports it.

---

## Access control, redaction & retention (storage-side controls)

### RBAC — least privilege

MongoDB enforces **Role-Based Access Control**; an authenticated user has **no access**
except what their roles grant (deny-by-default). **Always enable authorization**
(`security.authorization: enabled` / `--auth`); an open MongoDB with no auth is the
classic breach.

- Grant the **narrowest built-in role** that fits (`read`, `readWrite`, `dbAdmin`,
  `userAdmin`, `clusterMonitor`); avoid `root`, `dbOwner`, and cluster-wide admin for
  application identities.
- Create **custom roles** with exact privileges when built-ins are too broad — this is
  how you make the audit collection **insert-only**:

```javascript
// Custom role: the app can append to and read audit, but never update/delete it.
db.adminCommand({
  createRole: "auditAppender",
  privileges: [{
    resource: { db: "bank", collection: "audit" },
    actions: [ "insert", "find" ]          // NO update, remove, dropCollection
  }],
  roles: []
});
// Separate app role for business data; keep the money-mover off DDL actions entirely.
```

- Separate duties: distinct DB users for the app, for migrations/DDL, for backups, and
  for human DBAs. Humans authenticate individually (no shared admin account) so the
  audit log attributes actions to a person.

### Field-level redaction (serving different data to different roles)

- **`$redact`** aggregation stage implements **field-level access control**: tag
  documents/subdocuments with an access field and let `$redact` keep/drop content per
  the caller's clearance — so one collection can serve different field sets to different
  roles without copies.
- **Read-only views** (`db.createView` with a `$project` that omits or masks sensitive
  fields) give a role a masked projection (e.g. `pan` → last-4 only) while the base
  collection stays restricted.
- These are **authorization/presentation** controls — they are *not* a substitute for
  CSFLE/QE when you must keep the value from the server itself. Combine: CSFLE for
  confidentiality against the DB, `$redact`/views for which authorized role sees which
  field.

### Retention / TTL indexes

- A **TTL index** (`expireAfterSeconds` on a `Date` field) makes `mongod` automatically
  delete documents after their retention window — a background thread sweeps roughly
  **every 60 seconds**. Use it to **enforce data-minimization**: expire transient data
  (sessions, OTP tokens, short-lived KYC artifacts, verbose event logs) on a defined
  schedule.

```javascript
// Delete session/OTP docs 30 minutes after creation.
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 1800 });

// Partial TTL: expire only soft-deleted PII rows after the regulatory minimum,
// keep everything else indefinitely.
db.customers.createIndex(
  { deletedAt: 1 },
  { expireAfterSeconds: 0,                          // delete at the clock time in deletedAt
    partialFilterExpression: { deletedAt: { $exists: true } } }
);
```

- **Caution:** TTL is best-effort and background — deletion is not instantaneous, so do
  not rely on it for *immediate* erasure (use an explicit delete + crypto-shred for a
  GDPR/KVKK erasure request). And **do not** set an aggressive TTL on records you are
  legally required to *retain* (audit/money-movement records: 5–7 years) — TTL that
  deletes audit data too early is itself a compliance failure.

---

## Country differences (how the same configuration changes)

The MongoDB mechanisms stay the same; the *obligations around them* change. Load the
matching regional skill for specifics.

- **EU — GDPR, PSD2, DORA.** GDPR: lawful basis, data minimization (TTL indexes),
  right to erasure (design for **crypto-shredding** via per-subject CSFLE DEKs), breach
  notice within 72h. **PSD2 SCA**: remote electronic payments need strong customer
  authentication with **dynamic linking** (auth bound to amount+payee) — your approval
  gate must capture and bind both. **DORA** (in force since **17 January 2025**): ICT
  risk management, incident reporting, a register of ICT third-party providers (Atlas is
  such a provider — document it), and resilience testing of your audit/backup path.
- **US — SOX, GLBA, CCPA/CPRA.** SOX: immutable audit trails and segregation of duties
  for anything touching financial reporting — enable the **audit log** on DDL and
  privileged actions, and keep the application audit collection insert-only. GLBA:
  safeguard customer financial info (encryption at rest + in transit + RBAC).
  CCPA/CPRA: consumer access/deletion rights — track where PII lives (encrypted fields,
  TTL for minimization).
- **Turkey — KVKK, BDDK, MASAK.** KVKK: consent, data-subject rights, VERBİS
  registration where applicable. **BDDK** banking rules commonly require **data
  localization** — keep customer/financial data on infrastructure **in Turkey**; for
  Atlas, pin the cluster to a Turkish/approved region and do **not** default to an
  offshore region. **MASAK**: AML/suspicious-transaction reporting and record retention.
- **UK — FCA, UK GDPR.** FCA operational-resilience and consumer-duty expectations; UK
  GDPR mirrors EU GDPR post-Brexit; UK SCA tracks PSD2-equivalent rules.

The same cluster config is unchanged in logic across regions; what changes is the
**deployment region** (localization), the **audit retention period**, which
**regulator's report** the AML decision feeds, and whether SCA dynamic-linking is
mandatory on the approval gate.

---

## Good example

Idiomatic, defensible MongoDB fintech setup: auth on, TLS required, at-rest encryption,
CSFLE for the national id, JSON Schema validation, Decimal128 money, atomic+audited
transfer, insert-only audit, TTL for transient data.

```javascript
// --- Collection validator: enforce shape + types at the storage layer ---
db.createCollection("accounts", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "balance", "currency"],
    properties: {
      balance:  { bsonType: "decimal" },            // Decimal128, never double
      currency: { bsonType: "string", pattern: "^[A-Z]{3}$" } // ISO-4217
    }
  }},
  validationLevel: "strict", validationAction: "error"
});

// --- Idempotency: unique index makes a replayed transfer fail loudly ---
db.idempotency.createIndex({ key: 1 }, { unique: true });

// --- Retention: expire OTP/session docs automatically (data minimization) ---
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 1800 });

// --- Audit collection is insert-only via the auditAppender custom role (see RBAC) ---
// --- Money movement uses the atomic, audited transfer() shown earlier, with
//     writeConcern majority + snapshot readConcern, over a TLS connection whose
//     client authenticates by x.509, and nationalId encrypted by CSFLE. ---
```

```yaml
# mongod.conf — the secure baseline these app-level controls rely on
security:
  authorization: enabled            # RBAC on — deny by default
  enableEncryption: true            # WiredTiger at-rest (Enterprise)
  kmip: { serverName: kmip.internal.example.com, port: 5696,
          clientCertificateFile: /etc/mongo/kmip-client.pem,
          serverCAFile: /etc/mongo/kmip-ca.pem }
  redactClientLogData: true         # keep data values out of the diagnostic log
net:
  tls: { mode: requireTLS, certificateKeyFile: /etc/mongo/server.pem,
         CAFile: /etc/mongo/ca.pem }
auditLog:                           # Enterprise auditing of security events
  destination: file
  format: JSON
  path: /var/log/mongodb/audit.json
  filter: '{ atype: { $in: ["authenticate","authCheck","createUser","dropUser",
            "createRole","grantRolesToUser","createCollection","dropCollection"] } }'
```

Why it's defensible: authorization is on (deny-by-default), transport is `requireTLS`
with valid certs, data is encrypted at rest (disk theft) **and** the national id is
encrypted client-side (the server/operator never sees it), the diagnostic log is
redacted, security events are audited to a JSON audit log, money is `Decimal128` moved
atomically with a majority-durable transaction, every transfer writes an audit document
to an insert-only collection, and transient data self-expires.

## Bad example

```javascript
// ❌ Bad — multiple red lines in one setup
// mongod started with NO --auth and bound to 0.0.0.0, no TLS:
//   mongod --bind_ip 0.0.0.0            // open to the internet, no authentication (FCS-AUTHZ-001)

// App connects with TLS validation disabled and stores everything in the clear:
const client = new MongoClient(
  "mongodb://admin:hunter2@db:27017",             // hardcoded credentials (FCS-SECRET-002)
  { tls: true, tlsAllowInvalidCertificates: true } // disables MITM protection (FCS-TLS-001)
);

async function saveCard(db, user, pan, cvv, pw) {
  await db.collection("users").insertOne({
    pan,                                            // raw PAN stored (PCI, FCS-PAN-001/FCS-SAD-001)
    cvv,                                            // CVV stored after auth — forbidden (FCS-PAN-001/FCS-SAD-001)
    password: require("crypto").createHash("md5")   // MD5 "hash" — broken (FCS-SECRET-001/FCS-CRYPTO-001)
      .update(pw).digest("hex")
  });
  console.log(`saved card ${pan} cvv ${cvv} for ${user.ssn}`); // logs PAN+CVV+SSN (FCS-LOG-001)
}

async function pay(db, a, b, amount) {
  // float money + read-modify-write with no transaction, no lock, no idempotency
  const src = await db.collection("acct").findOne({ _id: a });
  await db.collection("acct").updateOne({ _id: a }, { $set: { balance: src.balance - 19.99 * amount } });
  await db.collection("acct").updateOne({ _id: b }, { $inc: { balance: 19.99 * amount } });
  // no audit record written at all — money moved invisibly (FCS-AUDIT-001)
}
```

**The red lines it crosses:** runs with no authentication and no TLS, open to the
network (FCS-TLS-001/FCS-AUTHZ-001); hardcodes credentials (FCS-SECRET-002) and disables certificate
validation (FCS-TLS-001); stores raw PAN and CVV (PCI-DSS, FCS-PAN-001/FCS-SAD-001); "hashes" a password with
MD5 (FCS-SECRET-001/FCS-CRYPTO-001); logs PAN, CVV, and SSN (FCS-LOG-001); uses JS `float` for money (silent
rounding drift) and a non-atomic read-modify-write with no transaction, no idempotency,
and **no audit record** (FCS-AUDIT-001 — bypassing audit on money movement). An agent asked to
write this must **refuse** per
[`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and offer the compliant
baseline (auth + TLS + at-rest + CSFLE, Decimal128, atomic audited transaction,
insert-only audit) shown above instead.
