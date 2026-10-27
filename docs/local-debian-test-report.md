# Local Debian test report

Real test execution of PR #7 (`installer-content-hardening`) on the user's own Debian
server over Tailscale. Engineering evidence only — not a claim the repo is "compliant"
or "production-ready". No secrets, keys, or tokens are recorded here.

## Server identity (verified)

| Field | Value |
|---|---|
| hostname | `fintechbear-test-linux` |
| OS | Debian GNU/Linux 13 (trixie) |
| arch | x86_64 |
| connection | Tailscale `100.95.46.28:22`, user `finttechbear`, key-based (StrictHostKeyChecking not disabled) |
| git remote (test clone) | `https://github.com/fintechbear/fintech-compliance-skills.git` |
| isolated workspace | `~/fcs-test-run/` (fresh clone; no existing project touched) |

## Environment versions (recorded on the server)

| Tool | Version | How used |
|---|---|---|
| Debian | 13 (trixie) | host |
| Docker | 29.8.1 (overlayfs) | isolated Node + PostgreSQL |
| Node | 18.20.8 / 20.20.2 / 22.23.4 | via `node:{18,20,22}-bookworm-slim` (system had no Node; nothing installed system-wide) |
| npm | 10.8.2 / 10.8.2 / 10.9.9 | with each Node |
| .NET SDK | 10.0.401 | built the harness |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg13+2) | `postgres:16` container, loopback-only `127.0.0.1:55432`, task-scoped |

## Commit tested

- Start / reference head of PR #7: `0ca19a9…` (reproduced against) and the current branch
  head at test time: **`361f7a2aa226f678e215359cc97a292db327b8ba`** (cloned fresh on the
  server; `git rev-parse HEAD` confirmed on the box).
- No reset to the reference SHA; `main` untouched; nothing pushed/merged/published from here.

## Section 3–4 — Node test matrix (really executed on Debian)

Each Node version ran, in its own container, with the repo copied in (so `node_modules`
never landed in the host clone): `npm ci` → `npm run verify` → `npm test`. Logs:
`~/fcs-test-run/logs/node{18,20,22}.log`, driver `~/fcs-test-run/logs/matrix.out`.

| Node | `npm ci` | `npm run verify` | `npm test` | exit |
|---|---|---|---|---|
| 18.20.8 | ok (no `||install` fallback) | All installer checks passed | **27 pass / 0 fail / 0 skipped** | 0 |
| 20.20.2 | ok | passed | **27 pass / 0 fail / 0 skipped** | 0 |
| 22.23.4 | ok | passed | **27 pass / 0 fail / 0 skipped** | 0 |

`matrix.out` ends with `=== MATRIX DONE overall_exit=0 ===`. Fixture line-ending sanity on
the server: `CR lines in installer/fixtures/pr5/claude/java.SKILL.md: 0` (LF preserved).

### The four previous-round bugs (G1–G4) — independently executed, by name

From `logs/node20.log` (identical on 18/22), all `ok`:

- `F01` user instructions after a legacy Codex section byte-preserved; `F01b` AGENTS.md backed up.
- `F02` A→B update: unchanged managed files become B, edited preserved+reported, unknown kept, old manifest-key tolerated; `F02b` `--force` replaces.
- `F03` AGENTS.md rename failure rolls the tree back; `F03b` first-install failure leaves no partial success.
- `F04` unedited old install upgrades (incl. 6 content-changed); `F04b` edited old file preserved.
- `F05a/b/c` marker-less / preceding-user-text / duplicate legacy Codex sections.
- `F07` `./ ../` + anchor links.
- `G1` edited managed Codex file survives repeated re-installs.
- `G2` user text referencing `skills/` after a legacy section preserved.
- `G3` manifest-less old Codex rule files upgrade to current source.
- `G4` partial/failed AGENTS.md write never corrupts the active file (5 stages: temp-write, rename, tree-commit, first-install, rollback-failure).

These are the acceptance criteria in task sections 4A–4D; they passed when actually run on
Debian, not merely asserted "fixed" in a report. No `not ok` line appears in any of the
three logs; `overall_exit=0`.

## Section 5 — packaged artifact

Built in a `node:20` container from the server clone:

- artifact: `fintech-compliance-skills-1.0.0.tgz`
- sha256: `e6ebd7588c4735ee8db184b6edf92cf3a3ffa1a1546e841bbfba8f6a563f9d91`
- extracted and installed from the tarball (`node package/installer/index.js --tool claude --target /tmp/pkgtest --home /tmp/pkgtest`) → **26 skills installed**, confirming the packaged installer behaves like the source checkout. (The in-suite `packed artifact` test also runs `npm pack` + extract + install and is one of the 27 passing tests.)

## Section 6 — .NET + PostgreSQL executable harness (really executed)

The repo's `csharp-dotnet.md` "Good example" is labelled illustrative/uncompilable and
targets **SQL Server**. A faithful, executable re-implementation of its **rules** was run
against a **real PostgreSQL 16** DB with **provider-correct** mechanisms (see
`examples/dotnet-postgres-harness/README.md` for the SQL-Server→PostgreSQL mapping:
`23505` unique violation instead of `2601/2627`; an explicit `version` column instead of
SQL Server `rowversion`; `40001` serialization retry). The SQL-Server `rowversion`
assumption is **not** carried over.

- .NET SDK 10.0.401, Npgsql 8.0.5, PostgreSQL 16.15, loopback-only container.
- Log: `~/fcs-test-run/logs/dotnet-pg.log`. Result: **`HARNESS SUMMARY: pass=23 fail=0`**, harness exit 0.
- Container removed on exit (no leftover `fcs-pg16-*` containers; `docker ps -a` filter empty).

Scenarios executed (real driver / schema / unique constraint / transaction):
zero, negative, over-precision, overflow, unsupported currency; 0/2/3-decimal currencies;
source/dest currency mismatch; same tenant/operation/key + same payload replay; same key
+ different payload conflict; different tenants same key string isolated; 20 concurrent
identical same-key requests → exactly one financial effect; competing concurrent debits
never overdraw (no negative balance, `CHECK balance_minor >= 0` + optimistic version +
serializable retry); out-of-tenant account access (not found); unauthorized source account
(forbid); debit+credit+audit+idempotency atomicity.

Relationship to the doc: this harness tests the **rules**, not the doc's exact code; it is
**not** a new product SDK. Static/compile checks are **not** presented as runtime tests —
every line above was produced by running the harness.

## Section 7 — real agent verification

**Not run.** The server has no Claude / Codex / Kiro agent CLI installed
(`command -v claude codex kiro` → none), so no live skill-discovery or
legitimate/refused/context task set was executed. Reported as not-run, not mocked.

## Not executed / out of scope this cycle

- Live agent-session evaluation (Section 7) — no agent runtime on the server.
- Windows results — Debian is not Windows evidence; Windows is covered only by GitHub
  Actions (`windows-latest` matrix legs), confirmed green on the final commit (see the CI
  note in the PR). This report does not itself run on Windows.
- Permission/symlink edge tests in Section 5 were covered at the API/CLI level by the
  suite (bad `--tool`/`--scope` exit non-zero; unique staging names; atomic rename), not as
  a separate OS-permission matrix with a dedicated unprivileged user.

## Log paths (on the server)

- `~/fcs-test-run/logs/node18.log`, `node20.log`, `node22.log`, `matrix.out`
- `~/fcs-test-run/logs/dotnet-pg.log`
