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

## Next phase: P01

Harness reliability + failure-injection tests + CI/publish prep. Reproduce (if still
present on the current code) and fix:
- A: `run.sh` hard-coded `~/fcs-test-run/harness` path (must run from its own location).
- B: `dotnet run` exit code masked by echo/tail (script can return 0 on harness failure).
- C: atomicity test only checks a successful transfer's rows.
- D: concurrent-debit assertion can pass with zero successful transactions.
Then: real-DB rollback + post-commit-retry injection, control-flow fault tests (dotnet/
docker/readiness), add a real PostgreSQL+.NET CI job and Node 22/24 legs, verify npm OIDC
runtime requirements (Node >=22.14.0 / npm >=11.5.1 as of 2026-10-27), pack+verify the
artifact once. Leave `npm publish`/OIDC account config as an explicit BLOCKED.

## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
