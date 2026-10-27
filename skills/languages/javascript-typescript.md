# Skill: JavaScript / TypeScript (Node.js) for Regulated Fintech

**Purpose.** Make an AI coding agent write Node.js/TypeScript (web front end + Node
back-end services) that is safe to run in a regulated financial system (payments,
risk, customer data). Load this skill whenever the task is in JavaScript/TypeScript
and touches money, customer PII, card data, onboarding/KYC, or anything an auditor
will later inspect. Always load it together with
[`refusal/refusal-policy.md`](../refusal/refusal-policy.md); load the matching
regional file for the user's jurisdiction.

## When to use

Load this skill when any of the following is true and the language is JS/TS (Node.js
services, Express/Fastify/NestJS APIs, or front-end code that handles sensitive data):

- You move money (transfers, payouts, card charges, ledger entries).
- You store or process PII, card data (PAN/CVV), IBANs, or national IDs.
- You build onboarding/KYC, AML screening, or risk scoring.
- You write anything that produces an audit trail or regulatory report.
- You touch authentication, password storage, session/token handling, or secrets.

If the task only renders a chart or formats a string with no sensitive data, you do
not need this skill — but if in doubt, load it. **Fast = something was skipped.**

> **Browser caveat.** The front end is a hostile environment: it holds no secrets,
> does no authoritative validation, and performs no crypto over regulated data. Card
> fields must be collected by the processor's hosted fields / iframe (Stripe Elements,
> Adyen Components) so the raw PAN **never touches your origin or your Node process**.
> Everything in "Hashing & encryption" and the server-side "Workflow" below runs on
> the Node server, never in the browser.

---

## Logging — what goes where

Financial logs are evidence. They must be complete enough to reconstruct who did
what, yet must never themselves become a data breach. The rule is: **log the event
and the actors, never the secret.**

### Which events, which sink, which level

| Event | Sink | Level | Notes |
|-------|------|-------|-------|
| Auth success/failure, MFA, password change | Security/audit log | `info` / `warn` | User id, source IP, outcome — never the credential |
| Money movement (transfer, charge, refund, reversal) | Append-only audit store | `info` | Correlation id, idempotency key, actor, amount, currency, internal account ids (not PAN) |
| Access to another party's financial data | Audit store | `info` | Actor, target account, authorization decision |
| KYC/AML/sanctions decision | Audit store | `info` | Decision, rule id, case id — the *decision*, not the raw document |
| Validation failure, business-rule rejection | App log | `warn` | No PII in the message body |
| Unhandled exception / rejection | App log + alerting | `error` | Stack trace scrubbed of PII |
| Debug tracing | App log (non-prod only) | `debug` | Disabled in production; never dumps request bodies |

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
- **Passwords, API keys, bearer/OAuth tokens, session cookies, `authorization`
  headers, private keys** → redacted entirely.
- **National ID / tax id / SSN / TCKN** → masked (last 2–4 only) or dropped.
- **Full IBAN** → mask to last 4 for display; store encrypted (see below).

### What is NEVER logged

Raw PAN, CVV/PIN/track data, plaintext passwords, decrypted secrets, full government
IDs, raw KYC document contents, encryption keys. If a value belongs in the
"Hashing & encryption" section below, it does not belong in a log.

### Structured logging library + PII redaction mechanism

Use **`pino`** (fast, JSON-first — the de-facto standard for Node services; `winston`
is an acceptable alternative with a `format` pipeline). Structured JSON logs are
queryable and let you attach redaction as *configuration* rather than hoping each call
site remembers to mask. Pino's built-in `redact` option censors values at named paths
on every line, so it works as a backstop even when a caller logs a whole object.

The safest design is still **allow-list by field**: build the log object yourself from
known-safe fields; the `redact` paths are the net that catches mistakes.

```ts
import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // redact is the BACKSTOP. It censors these paths on every log line.
  redact: {
    paths: [
      "password", "pwd", "secret", "token", "accessToken", "refreshToken",
      "apiKey", "cvv", "cvc", "pin", "cardNumber", "pan", "ssn", "tckn",
      "nationalId", "iban", "privateKey", "authorization",
      "req.headers.authorization", "req.headers.cookie",
      "*.password", "*.cvv", "*.pan",      // one level of nesting
    ],
    censor: "[REDACTED]",
  },
  // base fields + ISO timestamp, machine-readable and shippable
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});

// Bind a correlation id / actor once per request so every line is traceable:
export function requestLogger(correlationId: string, actor: string) {
  return log.child({ correlationId, actor });
}

const rlog = requestLogger("req-789", "user_123");
rlog.info(
  { src: "acct_123", dst: "acct_456", amount: "100.00",
    currency: "EUR", idemKey: "idem-abc" },
  "transfer.posted",
);            // no PAN, no secret
```

For partial masking (keep last 4 of a PAN in free text) pass a function to `censor`,
or mask the value before you log it. Regex masking of free-text message strings is a
weak last resort — prefer structured fields with named redact paths.

> **The `redact` config is a safety net, not the primary control.** The primary
> control is never putting a secret into the log object in the first place
> (allow-list the fields you emit). A key you forgot to list will leak.

### Log integrity (append-only / WORM / hash chain)

Audit logs must be tamper-evident:

- Ship audit events to an **append-only / WORM** sink: an object store with object
  lock (e.g. S3 Object Lock in compliance mode), a managed service like AWS
  CloudTrail/CloudWatch with retention locks, or a dedicated immutable log store.
- For local integrity, **hash-chain** records: each record stores
  `hash = SHA-256(prevHash || canonicalJSON(record))` using
  `crypto.createHash("sha256")`. A broken chain proves tampering. Use SHA-256 —
  **never MD5/SHA-1** for integrity.
- Restrict who can read audit logs (they contain actor/account data) and alert on any
  attempt to disable or delete them. Disabling audit logging on money movement is a
  hard red line (FCS-AUDIT-001).

---

## Workflow — payment / transfer / onboarding

The same backbone applies to a card charge, an account transfer, and a KYC
onboarding: **validate → authorize → check idempotency → do the work in one
transaction → write the audit record → commit.**

### Step order (transfer / payment)

1. **Authenticate & authorize.** Confirm the caller and that they may act on the
   source account (middleware / policy check). Deny-by-default.
2. **Validate input** (zod — see below). Reject malformed amounts, currencies,
   account ids *at the boundary* before touching state.
3. **Idempotency gate.** Require a client-supplied `Idempotency-Key`. If a completed
   result exists for that key, return it without re-executing. This prevents
   double-charges on retry — essential for networked payment APIs.
4. **Approval gate** where required: amounts over a threshold, a new payee, or SCA
   (PSD2) for EU remote payments need an additional authorization step *before* the
   money moves.
5. **Execute inside one DB transaction** with locking (below): debit source, credit
   destination (or write the ledger entry), persist the idempotency record, and write
   the audit record — all atomic.
6. **Commit.** On any failure, roll back the whole transaction so no partial transfer
   survives.
7. **Emit the audit event** to the append-only sink (step 5 persists it in the same
   transaction so it cannot be lost if commit succeeds).

**Money is never a JavaScript `number`.** IEEE-754 doubles cannot represent `0.10`
exactly (`0.1 + 0.2 === 0.30000000000000004`) and silently lose precision past 2^53.
Represent money as **integer minor units** (`bigint` cents) or a decimal library
(`decimal.js` / `big.js`), and store it in a DB `DECIMAL`/`NUMERIC` column — never
`FLOAT`/`DOUBLE`.

### Where each control sits

- **Approval gate:** between validation and execution (step 4).
- **Idempotency:** step 3 (check) + step 5 (persist key in the same transaction).
- **Audit record:** step 5, written in the *same* transaction as the money movement
  so it is impossible to move funds without the matching audit row.

### Concurrency / locking model

Node is single-threaded per process, but your service runs many concurrent requests
(and usually many processes/pods) against one database — so the lost-update race is
the DB's problem, solved with DB transactions + locks, not with in-process mutexes.

**Prisma — interactive transaction + pessimistic row lock.** Prisma's
`$transaction(async (tx) => …)` runs the callback atomically; set `isolationLevel`
for the guarantee you need. Prisma has no first-class `SELECT … FOR UPDATE` in the
query builder, so take the row lock with `tx.$queryRaw` inside the transaction, then
do the writes through `tx`.

```ts
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();

async function transfer(
  srcId: number, dstId: number, amountCents: bigint,
  idemKey: string, actor: string,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // idempotency gate — return prior result instead of re-executing
      const existing = await tx.idempotencyRecord.findUnique({ where: { key: idemKey } });
      if (existing) return;

      // pessimistic lock in a STABLE order (ascending id) to avoid deadlocks
      const [first, second] = [srcId, dstId].sort((a, b) => a - b);
      await tx.$queryRaw`SELECT id FROM "Account"
                         WHERE id IN (${first}, ${second})
                         ORDER BY id FOR UPDATE`;

      const src = await tx.account.findUniqueOrThrow({ where: { id: srcId } });
      if (src.balanceCents < amountCents) throw new Error("INSUFFICIENT_FUNDS");

      await tx.account.update({ where: { id: srcId }, data: { balanceCents: { decrement: amountCents } } });
      await tx.account.update({ where: { id: dstId }, data: { balanceCents: { increment: amountCents } } });
      await tx.idempotencyRecord.create({ data: { key: idemKey, status: "applied" } });
      await tx.auditEntry.create({
        data: { action: "transfer", src: srcId, dst: dstId,
                amountCents, currency: "EUR", actor, idemKey },
      });                                        // audit written in the SAME tx
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 },
  );
}
```

`READ COMMITTED` + `FOR UPDATE` is the common, correct choice for ledgers; serializable
gives the strongest guarantee but can raise serialization errors — **retry on
`40001`/deadlock with bounded backoff**, do not swallow them.

**TypeORM — transaction + `setLock("pessimistic_write")`.** Pessimistic locks are
only valid inside a transaction (TypeORM throws otherwise):

```ts
await dataSource.transaction("SERIALIZABLE", async (manager) => {
  const [first, second] = [srcId, dstId].sort((a, b) => a - b);
  const accounts = await manager.getRepository(Account)
    .createQueryBuilder("a")
    .setLock("pessimistic_write")              // emits SELECT … FOR UPDATE
    .where("a.id IN (:...ids)", { ids: [first, second] })
    .orderBy("a.id", "ASC")                    // stable lock order
    .getMany();
  // …debit/credit, persist idempotency + audit, all via `manager`…
});
```

**Optimistic locking** (a `@VersionColumn` in TypeORM, or a `version` field you
check-and-increment in Prisma) is best when contention is low; retry on the version
conflict. Never read-modify-write a balance outside a transaction.

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

Use the **`argon2`** npm package (`ranisalt/node-argon2`, native binding) with the
**Argon2id** variant — the OWASP-recommended, memory-hard, PHC-winning algorithm
(RFC 9106). Its defaults are **argon2id, `memoryCost: 65536` (64 MiB), `timeCost: 3`,
`parallelism: 4`, `hashLength: 32`, version 0x13**, which exceed OWASP's *minimum*
(**Argon2id m=19 MiB (19456 KiB), t=2, p=1**). Keep or raise the defaults on server
hardware; tune so a single hash takes ~0.25–0.5 s on your production CPU, and
re-benchmark periodically.

If a native build is impossible, `node:crypto` **`scrypt`** is a pure-standard-library
fallback (OWASP fallback: cost `N=2^17`, `r=8`, `p=1`). **bcrypt** is also acceptable
(work factor ≥ 10). **MD5 and SHA-1/SHA-2 are NOT password hashes** — a fast hash is
crackable at billions/sec; using them for passwords is a red line (FCS-SECRET-001, FCS-CRYPTO-001).

```ts
import * as argon2 from "argon2";

// Defaults are Argon2id, 64 MiB, t=3, p=4 — stronger than OWASP minimum.
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });   // random salt embedded in PHC string
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  const ok = await argon2.verify(storedHash, plain);       // constant-time compare
  // on success, transparently upgrade old/weak hashes:
  // if (ok && argon2.needsRehash(storedHash, { type: argon2.argon2id })) { /* re-hash + persist */ }
  return ok;
}
```

`argon2.hash` generates a cryptographically random salt per call and encodes all
parameters in the PHC string, so verification and `needsRehash` (for seamless
upgrades) work without storing params separately. **`node:crypto` scrypt fallback:**

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPasswordScrypt(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPasswordScrypt(stored: string, plain: string): boolean {
  const [, saltB64, keyB64] = stored.split("$");
  const key = Buffer.from(keyB64, "base64");
  const test = scryptSync(plain, Buffer.from(saltB64, "base64"), key.length,
                          { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return key.length === test.length && timingSafeEqual(key, test);  // constant-time
}
```

Always compare with `crypto.timingSafeEqual`, never `===`, to avoid timing leaks.

### Encrypted two-way — PAN, IBAN, national ID

Use **`node:crypto` AES-256-GCM** (`createCipheriv("aes-256-gcm", key, iv)`) — an AEAD
cipher giving confidentiality *and* integrity; **no npm package is needed.** Protect
the data key with a **KMS envelope**: the master key lives in a KMS/HSM (AWS KMS, GCP
KMS, Azure Key Vault, HashiCorp Vault); you encrypt data with a per-use **data key** and
store only the KMS-wrapped data key alongside the ciphertext.

```ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// dataKey is a 32-byte key unwrapped from KMS per operation -> AES-256.
export function encryptField(plaintext: Buffer, dataKey: Buffer, aad: Buffer) {
  const iv = randomBytes(12);                              // 96-bit IV, UNIQUE per encryption
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(aad);                                      // binds context, e.g. user id
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();                         // 16-byte GCM auth tag
  return { iv, ciphertext, tag };                          // store all three
}

export function decryptField(iv: Buffer, ciphertext: Buffer, tag: Buffer, dataKey: Buffer, aad: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);                                // throws on tamper / wrong key
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

Critical GCM rule: **a (key, nonce) pair must never repeat.** Reusing an IV with the
same key catastrophically breaks GCM. Generate a fresh 96-bit random IV per encryption
(or a guaranteed-unique counter) and rotate data keys well before the IV space is a
concern. Store IV + 16-byte auth tag next to the ciphertext; `setAuthTag` is what makes
decryption fail loudly on tampering.

Best of all for PANs: **don't store them** — tokenize via the processor and keep only a
token + masked PAN (see "Bad example" and the PCI-DSS skill).

### Key management, rotation, what is FORBIDDEN

- Keys live in a **KMS/HSM**, never in source, `.env` files committed to git, or the
  database next to the data they protect.
- **Rotate** master keys on a schedule and on suspected compromise; store a
  `keyId`/`keyVersion` per record so you can decrypt old data and re-encrypt lazily.
- Separate duties: the service that encrypts should not also be able to export master
  key material.
- Keep TLS verification ON (Node default). **Never** set
  `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false` for sensitive traffic
  (FCS-TLS-001).
- **Forbidden (red lines, FCS-CRYPTO-001, FCS-SECRET-002):** hardcoded keys or IVs, static/reused
  nonces, **ECB mode** (`aes-256-ecb`), DES/3DES, `Math.random()` for anything
  security-sensitive (use `crypto.randomBytes`/`randomUUID`), home-rolled crypto,
  MD5/SHA-1 for integrity or passwords, disabling TLS validation.

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
  dependencies (npm supply chain included) must be documented and testable.
- **US — SOX, GLBA, CCPA.** SOX: change-management and audit trails for anything
  affecting financial reporting (immutable audit logs, segregation of duties). GLBA:
  safeguard customer financial info (encryption at rest/in transit, access control).
  CCPA/CPRA: consumer data access/deletion rights — track where PII lives.
- **Turkey — KVKK, BDDK, MASAK.** KVKK (Turkey's GDPR analogue): consent, data subject
  rights, VERBİS registration where applicable. **BDDK** banking rules may require
  **data localization** — customer/financial data kept on infrastructure in Turkey; do
  not default a cloud deployment to an offshore region. **MASAK**: AML/suspicious-
  transaction reporting — your AML pipeline must produce MASAK-compatible reports and
  retain records.
- **UK — FCA, UK GDPR.** FCA operational-resilience and consumer-duty expectations;
  UK GDPR mirrors EU GDPR post-Brexit. UK SCA requirements track PSD2-equivalent rules.

The same `transfer()` above is unchanged in logic across regions; what changes is the
approval gate (SCA for EU), the audit retention period, the data residency of the DB,
and which regulator's report the AML decision feeds.

---

## Good example

Idiomatic, defensible TypeScript: validated input at the boundary with **zod**, money
as integer minor units (`bigint`), idempotent + audited money movement, no secrets
logged.

```ts
import { z } from "zod";
import { log } from "./logger";
import { transfer } from "./transfer";        // the locked, idempotent, audited fn above

// Validate at the edge. zod gives a runtime check AND a static type.
const TransferRequest = z.object({
  srcAccount: z.string().regex(/^\d+$/),
  dstAccount: z.string().regex(/^\d+$/),
  // money as a minor-unit integer string -> bigint; reject floats & sub-cent
  amountCents: z.string().regex(/^\d+$/).transform((s) => BigInt(s)).refine((v) => v > 0n, "must be positive"),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),   // ISO-4217
  idempotencyKey: z.string().min(8).max(200),
});
type TransferRequest = z.infer<typeof TransferRequest>;

export async function handleTransfer(rawBody: unknown, actor: string): Promise<void> {
  // authz is enforced in middleware (deny-by-default) before we get here.
  const parsed = TransferRequest.safeParse(rawBody);     // never throws on bad input
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.map((i) => i.path) }, "transfer.validation_failed");
    throw new ValidationError(parsed.error);             // no PII in the log
  }
  const req = parsed.data;

  await transfer(Number(req.srcAccount), Number(req.dstAccount),
                 req.amountCents, req.idempotencyKey, actor);   // locks + audit, atomic

  log.info({ src: req.srcAccount, dst: req.dstAccount,
             amount: req.amountCents.toString(), currency: req.currency,
             idemKey: req.idempotencyKey }, "transfer.accepted");  // no PAN, no secret
}
```

zod validates at the boundary (shape, positivity, ISO currency, minor-unit integer),
the amount stays a `bigint`, the DB work is the locked/idempotent/audited `transfer()`,
and the log line carries only safe fields. `safeParse` returns a result object so bad
input is handled, not thrown as an unhandled rejection.

## Bad example

```ts
// ❌ Bad — multiple red lines in a few lines of code
import crypto from "node:crypto";

async function storeCard(db: any, user: any, pan: string, cvv: string, pw: string) {
  user.card = pan;                                   // storing raw PAN (PCI red line)
  user.cvv = cvv;                                    // storing CVV after auth — forbidden
  user.password = crypto.createHash("md5").update(pw).digest("hex");  // MD5 "hash" — broken (FCS-SECRET-001/FCS-CRYPTO-001)
  console.log(`saved card ${pan} cvv ${cvv} for ${user.ssn}`);        // logging PAN+CVV+SSN
  await db.save(user);
}

function pay(a: any, b: any, amount: number) {
  a.balance -= 19.99 * amount;                       // float money -> rounding drift
  b.balance += 19.99 * amount;                       // no transaction, no lock, no idempotency
  // no audit record written at all                  // money moved invisibly (FCS-AUDIT-001)
}
```

**The red lines it crosses:** stores raw PAN and CVV (PCI-DSS, FCS-PAN-001);
"hashes" a password with MD5 (FCS-SECRET-001/FCS-CRYPTO-001); logs PAN, CVV, and SSN via `console.log`
with no redaction (FCS-LOG-001); uses binary `number` float for money (silent rounding
errors); moves funds with no transaction, no row lock, no idempotency key, and
**no audit record** (FCS-AUDIT-001 — bypassing audit on money movement). An agent asked to
write this must **refuse** per
[`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and offer the compliant
`handleTransfer` / tokenize-the-card pattern instead.
