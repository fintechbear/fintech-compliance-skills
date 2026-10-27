# TypeScript + PostgreSQL fintech reference

A **narrow, runnable reference** for the fintech control contracts (transfer, provider/
webhook, ledger/reconciliation, refund/cancel, retention/erasure), in TypeScript
(Node + `pg`) against a **real PostgreSQL 16**. It is the sibling of
`../dotnet-postgres-harness/`: both prove the same transfer invariants, so the contract
is not tied to one language. **This is not a product SDK**, not a framework, and **not a
compliance scanner** — it exists to make the invariants executable.

## What it enforces (by FCS id)

- **FCS-MONEY-001** — `money.ts`: ISO 4217 minor units (USD/EUR/GBP/TRY=2, JPY=0,
  KWD/BHD/OMR=3); rejects zero/negative/over-precision/overflow/unsupported currency.
- **FCS-AUTHZ-001** — accounts are addressed `(tenant_id, id)`; a cross-tenant id is
  `not_found_in_tenant`.
- **FCS-IDEMP-001** — fingerprint `(tenant, operation, key, canonical payload)`; same
  key+payload replays, same key+different payload conflicts, same key across tenants is
  independent. The DB unique PK is the real dedup under concurrency.
- **FCS-AUDIT-001** — debit, credit, audit row and idempotency row commit or roll back
  together in one `SERIALIZABLE` transaction.

## PostgreSQL, not SQL Server

The `.NET` skill text shows a SQL Server `rowversion` token; that assumption is **not**
valid here. This reference uses PostgreSQL-correct mechanisms: an explicit integer
`version` column for optimistic concurrency, `SQLSTATE 23505` for the unique-key dedup,
and `SERIALIZABLE` + `40001` retry for serialization failures.

## Run it

```bash
# needs Docker + Node >=20 + npm on PATH; starts a loopback-only, task-scoped postgres:16
bash run.sh
```

`run.sh` is location-independent, picks a free loopback port, runs `npm ci` then the
suite, propagates the harness exit code, and removes only its own container.

On a host with Docker but **no system Node** (e.g. the Debian test box), use
`run-in-docker.sh` instead — it runs the harness inside a `node:20` container on the
host network against the same loopback-only postgres:16.

To point at an existing database instead, set `PGCONN` and run `npm ci && npm start`.

## Scenarios

`main.ts` runs the money edge cases, currency mismatch, tenant isolation, idempotency
(replay / conflict / tenant-independent), concurrency (20 same-key → one effect;
competing debits never overdraw and at least one succeeds), insufficient funds, atomic
rollback on an injected pre-commit fault, and post-commit-retry. Fault injection lives
only in the test surface (`Faults` in `bank.ts`), never on a production path.

`npm start` chains five suites, each a separate process against the same PostgreSQL:

- `main.ts` — transfer (above).
- `webhook.ts` — provider/webhook: durable outbox before the call, outbound idempotency,
  raw-body signature verify, deduplicated inbox, unknown-outcome state machine. The
  provider is a labelled **test double**, not a real sandbox.
- `ledger.ts` — append-only double-entry ledger + reconciliation (detective only).
- `refund.ts` — refund/cancel: refund bounded by its source capture, partials accumulate,
  **concurrent refunds serialized** so the cap is never raced past, cancel/void vs
  reversal/refund by lifecycle stage, unknown-outcome never double-refunds, tenant scope.
- `retention.ts` — retention/erasure **per data category by legal basis**: mandatory
  financial retention vs active legal hold vs erasable profile data; over-retention and
  over-deletion checked **separately**; crypto-shredding recorded as a technique, never
  claimed as a universal legal erasure. **Durations are DEMO values, not cited regulation.**

Run a single suite with e.g. `npm run refund` or `npm run retention`.
