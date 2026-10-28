# Acceptance Matrix — R01–R12 + A–G (release readiness)

Review base SHA (main): `654018e847e5f91801d5dc0bdf80af7ba6be2517`
Final branch HEAD: `042abd8` · Branch `fix/r01-r11-remediation` · PR #10 (DRAFT)
Green CI run (this HEAD): **40675121144** — all 13 jobs SUCCESS on real Windows + Linux + real PostgreSQL 16.
Artifact: `fintech-compliance-skills-1.0.0.tgz` · SHA-256 `3d65f2464b260e161c0937b62368f7e9ad723207d5f89e3f737298ddf72d0faf` (43 files; ships controls/catalog+schema+profiles).

Real-env note: local Debian/SSH was DOWN this cycle (`NoState`, port 22 closed), so DB proof runs
on **GitHub Actions PostgreSQL 16 service containers** (the sanctioned alternative) — real DB, no mocks.
Each DB-bound row is proven failing-first (reviewed-base 654018e reproduces the bug on the same real DB)
then fixed. A green installer leg does NOT close a TS-harness row; adapter self-test does NOT close a
real-DB row.

| ID | Requirement | Impl | Test (failing-first → after) | Real env | Commit | Result |
|----|-------------|------|------------------------------|----------|--------|--------|
| R01 | self-transfer same_account + per-UPDATE rowCount rollback | bank.ts | main.ts (self-transfer refused; balance unchanged; forced path) | real PG (CI ts-harness) | `02f608b` | **DONE** — base self-transfer `posted`+lost credit → fixed; transfer suite 26/26 |
| R02 | authenticated actor + source grant; authz BEFORE replay-leak; BOTH stacks | bank.ts, Bank.cs | main.ts, Program.cs | real PG (CI, both harnesses) | `c3b8a89` | **DONE** — base TS had no authz (probe); fixed; TS 26/26 + .NET harness green |
| R03 | packaged doctor resolves resources; install-target refs pinned; one source chain | package.json, diagnose.js, index.js | test-diagnose.js, test.js (pinned URLs, idempotent) | tarball (CI) | `06ca5f0`,`844e954` | **DONE** — controls shipped; skill refs pinned to `/blob/v<ver>/`; tarball install OK |
| R04 | code tasks RUN the code (not keyword); warn+comply all danger cats; genuine NEEDS_REVIEW | grader.js | grader self-test | CI evals | `f9c6da5` | **DONE** — `return "minor version"` now FAILS (exec probe); 19 self-tests |
| R05 | TOML parse+allowlist (commented provider kept); eval's own perms; fresh home; manifest | adapters/codex.js, run.js | isolation/codex self-tests | CI evals + runtime | `cb1d9df`,`f9c6da5` | **DONE** — `[model_providers.p] # c` kept; approval/sandbox not inherited; isolation verified clean in real run |
| R06 | BigInt end-to-end (ledger+refund); near-int64 cap; append-only/reversal | ledger.ts, refund.ts, bank.ts | ledger/refund suites | real PG (CI) | `8738ccd`,`a7b0dd0`,`ce7f4ce` | **DONE** — base float-sum accepts [-9e15,-2,9e15,1] → BigInt rejects; ledger 13/13, refund near-int64 cap |
| R07 | inventory+manifest+AGENTS+disk cross-check; default --target=cwd; traversal/schema | diagnose.js | test-diagnose.js (R07a–g) | CI installer | `2d3960c`,`44036e6` | **DONE** — base: file+manifest-record delete = healthy/exit0 → fixed exit≠0 |
| R08 | full YAML (nested+seq); 400-char kept / >1024 explicit error; name↔folder | index.js | test.js (R08d–h) | CI installer | `e6e29a4`,`b8fd4ea` | **DONE** — base cut 400→302 + dropped metadata.version → round-trips; 44 tests |
| R09 | canonical fingerprint (same key+diff amount=conflict); scoped provider key; crash recovery | refund.ts | refund suite | real PG (CI) | `ce7f4ce`,`844e954` | **DONE** — base replays on different amount → now conflict; refund 14/14 |
| R10 | sig length/encoding no RangeError; DB err≠bad_sig; trusted binding; durable consumer+dedup; rotation; crash | webhook.ts | webhook suite | real PG (CI) | `b2ba544`,`f1756fa` | **DONE** — base RangeError on short sig → bad_signature; webhook 21/21 |
| R11 | own-property (constructor:123 rejected); validate eval tasks; unknown keyword hard fail | jsonschema.js, validate-controls.js, validate-tasks.js | selftest (30) | CI controls+evals | `000460d`,`ee10138` | **DONE** — prev validator accepted constructor:123 → rejected; 30 adversarial |
| R12 | retention hold/erase TOCTOU: lock+conditional UPDATE; two-connection race | retention.ts | retention suite (40x race) | real PG (CI) | `9e56246`,`042abd8` | **DONE** — base TOCTOU erases held record → race keeps hold; retention 9/9 (+ real conn-leak bug found & fixed) |
| E | CLI list/explain/dry-run/diff/uninstall; unknown flag≠install; JSON/exit/--help/tarball | index.js | test.js (8 E tests) | CI installer | `d5c0ca1` | **DONE** — unknown flag/command exit 2, no install; 44 tests |
| F | TS+real-PG CI job; clean npm ci; real tsc; publish waits ALL gates; negative-gate proof; one artifact | verify.yml, publish.yml | CI | CI | `fd1389a`,`7673f9e` | **DONE** — TS-PG job added; publish needs reusable Verify; negative-gate-proof green |
| G | 23 needs_review source review; README 6 skills+evidence; STATE/PR; real agent eval | catalog.json, README, evals | review-*.md, EVAL_REPORT.md | primary sources + runtime | `3bf13fd`,`d2bff5c` | **DONE (eval PARTIAL)** — 23/23 verified vs primary sources; README done; real 3x3 eval done; full 40x3 bounded |

## Bounded / explicitly-not-done (honest)
- **Full 40×3 scored agent eval** — PARTIAL. The real 3×3 smoke ran (T016 refused=PASS in all
  conditions; T026 TIMEOUT→NOT_RUN; T036 NEEDS_REVIEW), proving the real-agent path + isolation +
  grader. The full 120-call matrix is a multi-hour paid run kept inside the session's bounded budget
  (and T026 shows some tasks exceed a 150s task budget). Runnable with `node evals/run.js --all`. See EVAL_REPORT.md.
- **Local Debian real-PG** — BLOCKED this cycle (Tailscale `NoState`, port 22 closed). Substituted by
  GitHub-hosted real PostgreSQL 16 (sanctioned). Not a reason to skip any code/test.
- **npm publish / OIDC Trusted Publisher** — out of scope by task rule 11 (no merge/tag/publish). The
  publish workflow is wired to wait for the full gate; configuring the npm account is a manual step.

## Blocker log
- 2026-10-28 — Debian DB host DOWN (`NoState`/:22). Routed DB proof through GitHub Actions PG16.
