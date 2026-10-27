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

## Next phase: P04

P03 is PASS: control catalog (`controls/catalog.json`, 13 FCS controls), schema, two example
profiles, and the 58 broken `refusal rule N` citations migrated to permanent FCS ids
(`controls/validate-controls.js` is the CI gate). Legal source_refs are needs_review.

P04 = on-demand loading + safe migration + transfer workflow skill. Build a short
`fintech-transfer` SKILL.md that references controls by FCS id and names when to read the
language/DB/region file; keep canonical content single-sourced; add explicit name/description
metadata; preserve installer manifest/edit-protection/atomicity; add a TypeScript/PostgreSQL
transfer reference alongside the existing .NET one; run the transfer eval tasks as CANDIDATE
if a runtime is usable (else BLOCKED, deterministic tests still run).
## How to run things

- Installer tests: `npm ci && node installer/verify.js && node --test installer/test.js`.
- Harness on `debian-test`: `examples/dotnet-postgres-harness/run.sh` (Docker PostgreSQL,
  loopback-only, task-scoped; cleans up its own container).
- SSH options that pass CI policy here: `-o StrictHostKeyChecking=accept-new
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`
  (never `BatchMode` in a command that also names an `/etc` path — it trips a chmod rule).
