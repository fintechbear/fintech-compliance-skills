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

## Next phase: P06

P05 is PASS (commit e2d2ae1): provider/webhook + ledger/reconciliation skills + controls
(FCS-OUTBOX/WEBHOOK/OUTCOME/LEDGER/RECON-001); TS references on real PostgreSQL 16.15 —
transfer 17 + webhook 9 + ledger 7 = **33/33, exit 0**. installer router now lists core task
skills; installer 27/27; CI green.

P06 = three narrow workflow entries, each independently triggerable (no single mega-skill):
(A) refund/cancel (source payment + tenant + lifecycle; partial/full; never exceed paid;
concurrent refunds cap; unknown-outcome double-refund prevention; cancel/void/reversal/refund
are provider-specific terms, not universal synonyms); (B) retention/erasure (data-category
based legal basis; legal hold vs mandatory financial retention vs erasable profile data;
crypto-shredding is NOT a universal legal erasure guarantee; over-retention AND over-deletion
tested separately; durations are demo data, not cited regulation); (C) financial PR review
(new code vs changed risk surface; per-finding control id + file/line + trigger + evidence +
confidence + review limits; no unverified finding or automatic compliance score; update the
README "not a scanner" line consistently). Qualitative review beyond deterministic tests is
NEEDS_REVIEW / real-agent, not auto-passed.
## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
