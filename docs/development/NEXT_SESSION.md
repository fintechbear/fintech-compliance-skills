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

## Next phase: P02

P01 is PASS (commit c248fb6): harness hardened (findings A-D fixed), real-DB rollback +
post-commit-retry tests, shell control-flow fault test, CI real-PostgreSQL job + Node 24,
publish.yml OIDC runtime. Debian: installer 27/27, shell-fault 4/4, harness 25/25.
BLOCKED: npm publish / OIDC account config (manual). See docs/development/P01.md.

P02 = real-agent evaluation infrastructure + frozen CURRENT_BASELINE (content hashes of
6fc6e9b). Build evals/ (40 tasks: 15 valid / 10 dangerous / 10 scope-ambiguity / 5
off-topic), split dev vs hidden-regression, three conditions (WITHOUT_SKILLS /
CURRENT_BASELINE / CANDIDATE), separated graders, isolation test (HOME alone may not stop
global CLI config — verify against the real CLI). Windows has claude/codex/kiro CLIs
(auth unconfirmed): attempt a 3-task smoke; if no usable runtime, mark the real eval
BLOCKED (never mock). 
## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
