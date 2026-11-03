# Release closure — current scope

This file is shipped in the npm package. It supersedes the 2026-10-28 closure text (review base
`ff4b491`), which is historical and is **not** evidence for the current candidate.

## Scope statement

**CLI tests were not run for this release by explicit scope decision. Installer/doctor command
flows and live Claude Code/Codex/Kiro sessions remain unverified.**

Also not run: the packed product CLI smoke test, the 40×3 live-agent evaluation, and any real
provider sandbox (payment/webhook harnesses use labelled test doubles). This is a declared
limitation, not a passing test.

## Required gate (what "green" means)

| Gate | Where |
|---|---|
| `npm run test:release:noncli` — grader, release module tests, task/schema/catalog validators, citation check, evidence rules, profile selector, skill inventory, AGENTS byte-preservation, install transaction fault tests, Codex ownership planner, resource resolver, content consistency, publish guard | Verify `modules` job, Windows + Linux × Node 18/20/22/24 |
| `tsc --noEmit`, pure money test, `npm audit` (TS harness) | Verify `ts-harness` |
| Failing-first base probes, then every TS module against real PostgreSQL 16 | Verify `ts-harness` |
| .NET rule harness against real PostgreSQL 16 | Verify `harness` |
| Negative-gate proof (each validator fails on a deliberately broken input, incl. re-opened F04/F12/F16) | Verify `negative-gate-proof` |
| Single aggregate | Verify **`release-readiness`** |

The authoritative pass/fail for a commit is its Verify run and the `release-evidence` artifact
(full tested SHA + tree + per-job results). A static document cannot contain its own commit hash.

## Audit closure

The 2026-11-02 audit set (`AUD-20261102-F01` … `F16`) and its per-finding status, evidence and
remaining limits are recorded in the repository at `docs/development/AUDIT-2026-11-02.md`, with the
machine-readable manifest `docs/development/result-manifest.json`.

## Not claimed

No comparative agent-effectiveness claim; no legal completeness or certification claim; npm
account ownership / Trusted Publisher setup is not verified by any test here; merge, tag, GitHub
release and npm publication are separate actions and are not claimed by this document.
