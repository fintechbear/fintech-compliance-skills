---
name: "fintech-transfer"
description: "Implement a correct, auditable money transfer: authorize, validate currency/amount, gate on idempotency, screen, then apply debit+credit+audit+idempotency atomically. Load when the task moves funds between accounts."
triggers: "transfer, move money, debit, credit, payment, send funds, ledger posting"
---

# Skill: Fintech Transfer

**Implement a money transfer that is authorized, idempotent, currency-correct, and
atomically audited.** Load this when a task moves funds between accounts. It is
task-focused on purpose: the shared rules live once in the control catalog and the
refusal policy, referenced here by **FCS id**, not restated.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand (do NOT assume a sibling skill is already loaded)

The agent must read these itself when the task touches them — nothing auto-loads them:

- The language you are coding in → `languages/<lang>.md` (e.g. `languages/csharp-dotnet.md`,
  `languages/javascript-typescript.md`). Concurrency token, crypto primitives and money
  type are language-specific.
- The database you store in → `databases/<db>.md` (e.g. `databases/postgresql.md`). The
  unique-constraint behaviour and isolation/retry story are DB-specific — a SQL Server
  `rowversion` assumption is NOT valid on PostgreSQL (use an explicit version column +
  `SQLSTATE 23505` + `SERIALIZABLE`/`40001` retry).
- The user's jurisdiction → `regional/<region>.md`, and `global/aml-kyc.md` when screening
  applies. Whether screening is REQUIRED depends on the obliged-entity role, not on "a user
  lives in country X" — see `controls/profiles/`.

## Controls this skill enforces (by FCS id)

| FCS id | In this workflow |
|---|---|
| FCS-AUTHZ-001 | The actor is authorized to move funds from the SOURCE account; tenant isolation holds. |
| FCS-MONEY-001 | Amount is minor-units per ISO 4217 (0/2/3 decimals); reject zero/negative/over-precision/overflow/unsupported currency; never mix currencies in one posting. |
| FCS-IDEMP-001 | Fingerprint = (tenant, operation, key, canonical payload). Same key+payload replays one effect; same key+different payload is a conflict; same key across tenants is independent. |
| FCS-AML-001 | KYC/AML/sanctions screening where required; a hit is warn+audit+hold, never a silent pass. |
| FCS-AUDIT-001 | Debit, credit, ledger/audit entry AND the idempotency record commit or roll back together, in one transaction. |

## Step order

1. **Authorize** — authenticated principal; check the actor may debit the SOURCE account
   (FCS-AUTHZ-001). Reject cross-tenant access to either account.
2. **Validate** — parse the amount into minor units for the posting currency; reject
   zero/negative/over-precision/overflow and unsupported currencies; source and destination
   share the currency (FCS-MONEY-001).
3. **Idempotency gate** — look up (tenant, operation, key). If seen with the SAME canonical
   payload, return the stored result and do nothing. If seen with a DIFFERENT payload,
   reject as a conflict (FCS-IDEMP-001). The real guarantee is a DB unique constraint, not an
   in-memory check — the key row is inserted in the SAME transaction as the effect.
4. **Screen** — where required, run sanctions/AML; a hit holds the transfer and is audited
   (FCS-AML-001). Record the decision + case id.
5. **Apply atomically** — in one transaction: debit source, credit destination, write the
   ledger/audit record, insert the idempotency row. All commit or all roll back
   (FCS-AUDIT-001). On a serialization failure, retry a bounded number of times; on an
   insufficient-balance check, fail the transfer without partial effect.
6. **Respond** — the stored idempotent response is what a safe retry replays, even if the
   caller lost the first response after commit.

## Output contract

A transfer implementation produced under this skill MUST:

- refuse (not "work around") any request that crosses a red line, naming the FCS id;
- carry the five controls above with a test for each invariant (see the reference harnesses);
- store money as integer minor units or a decimal type — never a binary float;
- leave no partial state on any failure path (no debit without the matching credit+audit).

## Reference implementations

Two small, working transfer references apply exactly this contract against a REAL database:

- `examples/dotnet-postgres-harness/` — C# / .NET on PostgreSQL.
- `examples/ts-postgres-harness/` — TypeScript (Node) on PostgreSQL.

Both are narrow references, not a product SDK. They exist to make the invariants runnable.
