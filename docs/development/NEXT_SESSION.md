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

## Current phase: P08 (final) — PARTIAL

P00–P07 all PASS. P08 deterministic end-to-end gate is GREEN (grader 10/10, adapter 5/5,
isolation 8/8, controls 23/33/0, citation idempotent, installer verify + 27/27, diagnose 9/9;
new CI job `eval-harness-selftests`). Config-isolation prerequisite from P02 is CLOSED
(`prepareCodexHome` + `isolation.selftest` 8/8; empirically auth-only→401, auth+config→real
completion). The grader was hardened after a REAL agent refusal (typographic apostrophe
U+2019) was a false-negative; re-grade → PASS.

The ONLY open item is the **full 40×3 scored eval**, NOT_RUN this cycle:
- Agent latency: codex on this host hits the 150–160s timeout on most calls (one T016
  CANDIDATE returned in 60s and PASSed); a 120-call matrix can't complete reliably here.
- Account/cost: ~14k tokens/call, no budget authorized; Claude BLOCKED (low credit).

To finish P08 when capacity/budget allow: `node evals/run.js --all` (isolated home, deterministic
grader, already wired). Record the run id + a cleaned summary (raw outputs are gitignored).
Then decide PR #8 readiness — it stays a draft off the unmerged PR #7 base (`6fc6e9b`); merge
is gated on PR #7 landing first.



## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
