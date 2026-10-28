# Acceptance Matrix — R01–R12 + A–G (release readiness)

Review base SHA (main): `654018e847e5f91801d5dc0bdf80af7ba6be2517`
Reviewed branch HEAD at task start: `a7b0dd0518c68d30c85c637d179d109666308d2b`
Branch: `fix/r01-r11-remediation` · PR: #10

Legend: status ∈ {DONE, IN_PROGRESS, BLOCKED, NOT_RUN}. "Real env" = where the acceptance
evidence runs (real PostgreSQL via GitHub Actions service container, since local Debian/SSH is
DOWN this wave — `NoState`, port 22 closed). A green installer leg does NOT close a TS-harness
row; adapter self-test does NOT close a real-DB row; two refusal answers do NOT close the full eval.

| ID | Requirement (short) | Impl | Test (failing-first → after) | Real env | Source SHA | Result | Evidence |
|----|---------------------|------|------------------------------|----------|-----------|--------|----------|
| R01 | self-transfer same_account + per-UPDATE rowCount rollback; debit=1/credit=0 path actually triggered | bank.ts | main.ts | real PG (CI ts-harness) | TBD | IN_PROGRESS | needs the forced debit=1/credit=0 rollback test + CI ts-pg job |
| R02 | authenticated actor + source-account grant/ownership (TS AND .NET); replay authz before result leak | bank.ts, Bank.cs | main.ts, Program.cs | real PG (CI) | TBD | NOT_RUN | |
| R03 | packaged doctor resolves controls/profiles/examples at install target; one canonical source chain; tarball install/upgrade | package.json, diagnose.js, index.js | test-diagnose.js | tarball (CI) | partial 06ca5f0 | IN_PROGRESS | install target still lacks controls/profiles/examples |
| R04 | code tasks: real build/test probe (compile/run in sandbox), not keyword; warn+comply across all danger cats; genuine NEEDS_REVIEW closed | grader.js | grader.js self-test | CI evals | partial 5f8e5fc | IN_PROGRESS | `return "minor version"` still PASSes T001/T004/T012/T014 |
| R05 | TOML parse+allowlist+serialize (commented provider kept); real read-isolation via runtime tool path; fresh home; manifest | adapters/codex.js, run.js | isolation.selftest.js, codex.selftest.js | CI evals + runtime | partial cb1d9df | IN_PROGRESS | `[model_providers.p] # c` dropped by line-regex |
| R06 | BigInt end-to-end across transfer/refund/ledger/recon; API/JSON precision; append-only/reversal at DB level | ledger.ts + refund.ts + bank.ts | main.ts, ledger/refund tests | real PG (CI) | partial a7b0dd0 | IN_PROGRESS | refund.ts still uses Number(captured/sum) |
| R07 | doctor cross-checks inventory+manifest+AGENTS refs+real files; delete file+manifest record still = broken; default --target=CWD | diagnose.js | test-diagnose.js | CI installer | partial 2d3960c | IN_PROGRESS | delete file+manifest record → still healthy:true/exit0 |
| R08 | full YAML scalar/mapping/array; keep 400-char desc or explicit error (no silent truncation); nested metadata.version preserved; name↔folder | index.js | test.js | CI installer | partial e6e29a4 | IN_PROGRESS | 400-char trunc; nested metadata → metadata:"" |
| R09 | refund canonical payload/fingerprint; same key+different amount = conflict; provider key tenant/payment/op/provider scope; crash/recovery | refund.ts | refund test | real PG (CI) | NOT_RUN | NOT_RUN | 500→900 same key must conflict (now replays) |
| R10 | webhook sig length/encoding no RangeError; DB error ≠ bad_signature; trusted tenant binding; durable consumer + business dedup; crash/recovery/rotation | webhook.ts | webhook test | real PG (CI) | NOT_RUN | NOT_RUN | timingSafeEqual length mismatch RangeError |
| R11 | own-property check (constructor:123 rejected); validate catalog+profiles+eval tasks; unknown keyword = hard fail; staleness | jsonschema.js, validate-controls.js | validate-controls.selftest.js | CI controls | partial 000460d | IN_PROGRESS | additionalProperties:false accepts `constructor:123` |
| R12 | (new) retention/erasure hold race: decision+destructive write serialized; two-connection race keeps active hold | retention.ts | retention test | real PG (CI) | NOT_RUN | NOT_RUN | read legal_hold=false → unconditional erased=true (TOCTOU) |
| E | CLI list/explain/dry-run/diff/uninstall; unknown flag ≠ install; JSON/exit/--help/tarball | index.js | test.js | CI installer | NOT_RUN | NOT_RUN | |
| F | TS+real-PG CI job; clean npm ci (no install fallback); real tsc --noEmit; publish waits ALL gates; negative-gate proof; one artifact hash | verify.yml, publish.yml | CI | CI | NOT_RUN | NOT_RUN | no TS-PG job; publish skips DB/typecheck/schema |
| G | 23 needs_review source review; README 6 tasks/evidence table; STATE/NEXT/PR; real agent eval (3×3 smoke then 40×3, ≤120 calls) | docs, README, evals | eval run | runtime | NOT_RUN | NOT_RUN | real agent eval blocked on credit last time |

## Blocker log
- 2026-10-28T12:25+03:00 — Debian real-PG host DOWN again (`tailscale ping` → NoState; `Test-NetConnection :22` → False). Per task rule 10/12 + CI alternative clause: real-DB evidence routes through GitHub Actions PostgreSQL 16 service containers (TS + .NET acceptance jobs). This is a sanctioned alternative, NOT a blanket BLOCKED.
