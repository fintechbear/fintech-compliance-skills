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

## Next phase: P07

P06 is PASS (commit 7bd85a8): refund/cancel + retention/erasure + financial-PR-review skills
+ controls (FCS-REFUND/REFUNDTERM/RETAIN/ERASE/PRREVIEW-001, 23 total); TS references on real
PostgreSQL 16.15 — transfer 17 + webhook 9 + ledger 7 + refund 9 + retention 7 = **49/49,
exit 0**. installer 27/27; validate-controls 23 controls / 33 skills / 0 errors; verify.js all
pass.

P07 = CLI diagnostics. A small, zero-/low-dependency diagnostic the installer ships (or a
`controls/` script) that a developer runs to self-check their install: which targets are
present (claude/kiro/kiro-crew/codex), whether managed blocks are current vs drifted, whether
every skill's FCS-id references resolve to the catalog, and whether any legacy numbered
citation has crept back. It must be HONEST about what it cannot check (it is a static
self-check, not a runtime compliance audit — reuse the "not a scanner" framing). Wire it into
CI as its own job if deterministic. Qualitative/agent-side checks stay NEEDS_REVIEW for P08.

## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
