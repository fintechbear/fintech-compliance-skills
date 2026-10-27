# Next session handoff

## Where we are

- Branch: **`fintech-skills-evolution`** (based off PR #7 head `6fc6e9b`; PR #7 is the
  unmerged dependency base — do NOT modify the PR #7 branch).
- Frozen comparison reference: `6fc6e9be03f85cd743b99bc7ca1c7a3ca9d2b601`.
- Read first, in order: `docs/development/WORK_CONTRACT.md`, `PLAN.md`, `STATE.json`.
- P00 is **PASS** (branch, inventory, access probe, continuity records, baseline tests).

## Environment quick facts

- Windows host: `claude`/`codex`/`kiro` CLIs present (auth unconfirmed), Node v24, .NET 10, Docker.
- `debian-test`: Debian 13, Docker 29.8.1, .NET 10.0.401, PostgreSQL via `postgres:16`
  container; **no system Node** (use `node:NN` containers), **no agent CLI**.
- Private connection details are NOT in the repo; they were provided out of band.

## Next phase: P05

P04 is PASS (commit 5debe0a): `skills/core/fintech-transfer.md` (task-focused, FCS-id
references, explicit metadata); `examples/ts-postgres-harness/` TS+pg reference proving the
same contract as the .NET one — **17/17 on real PostgreSQL 16.15** (debian-test). installer
F04/F04b now fixture-derived (no hard-coded 26); installer 27/27; CI green.

P05 = webhook / ambiguous provider outcome / ledger / reconciliation. Add two small task
entries (provider+webhook; ledger+reconciliation) that reference controls by FCS id. Durable
intent/outbox before the provider call; outbound idempotency key; webhook signature on raw
body; durable inbox + dedup via DB constraint; UnknownOutcome is NOT auto-failed and never
blind-retried; small double-entry ledger (balanced per currency, append-only, reversal
entries); reconciliation examples (missing/duplicate/delayed/amount-mismatch). Prove on real
DB; a provider test-double is allowed but must be labelled as such, not a real Stripe sandbox.
Do NOT build a new commercial connector or recon-engine product in this repo.
## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
