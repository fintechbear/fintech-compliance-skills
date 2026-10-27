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

## Next phase: P08 (final)

P07 is PASS (commit dbb52c8): `installer/diagnose.js` install self-check (zero-dep, reuses the
installer's own classify) + `test-diagnose.js` smoke (9/9) + CI wiring (source diagnose in
control-catalog, diagnose smoke on every installer matrix leg) + `doctor` bin/README. CI green.

P08 = end-to-end acceptance + the deferred real-agent eval. Pull everything together:
1. **Full installer + harness + catalog + diagnose gate** green on a clean checkout (it already
   is in CI; confirm on `fintech-skills-evolution` head and record the run id).
2. **The deferred 40×3 scored agent eval** (evals/ already has schema + 40 tasks + a
   deterministic grader with 8/8 self-test + a codex adapter with 5/5 self-test + CURRENT_BASELINE).
   Blockers from P02: account/credit limits, config-isolation vs the global CLI config. Run what
   is genuinely runnable (bounded Codex), mark the rest NOT_RUN/BLOCKED honestly — never present a
   mock as a real agent evaluation. The CANDIDATE evals for P04/P05/P06 task skills live here too.
3. Qualitative items (fintech-pr-review discipline, refusal judgement) are NEEDS_REVIEW, not
   auto-pass. Degenerate outputs (refuse-all, empty) never PASS.
4. Final honest report + decide PR #8 readiness (still a draft off the unmerged PR #7 base).


## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
