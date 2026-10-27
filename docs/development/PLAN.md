# Plan — P00 → P08

Each phase ends with: code/content change, in-scope tests actually run, evidence,
commit, and an updated continuity record. A phase without evidence is not "done".

| Phase | Goal | Depends on | Evidence type |
|---|---|---|---|
| **P00** | Verify state; isolated branch; inventory; access probe; continuity records; baseline tests | — | branch/SHA, inventory, baseline `verify`+`test`, access probe |
| **P01** | Harness reliability, failure-injection tests, CI + publish-runtime prep | P00 | real DB rollback/retry tests, control-flow fault tests, CI job, artifact hash |
| **P02** | Real-agent eval infrastructure + frozen CURRENT_BASELINE | P00 | 40 task specs, split graders, isolation test, 3-task smoke (or BLOCKED), baseline hashes |
| **P03** | Control catalogue, source traceability, profiles | P02 | catalogue+schema, control→source→skill→test links, profile CI checks |
| **P04** | On-demand loading, safe migration, transfer workflow (2 ref stacks) | P03 | canonical SKILL.md, .NET + TS transfer refs, migration tests, packaged artifact |
| **P05** | Webhook/unknown-outcome, ledger, reconciliation | P04 | durable intent/outbox, crash/retry, double-entry tests on real DB |
| **P06** | Refund/cancel, retention/deletion, financial PR review | P05 | positive/negative/boundary tasks, legal claims source-bounded |
| **P07** | Profile selection, CLI diagnostics (list/explain/doctor/dry-run/uninstall), docs | P06 | commands run from tarball, dry-run writes nothing, uninstall preserves user content |
| **P08** | End-to-end acceptance, real-agent comparison, draft PR | P01–P07 | full re-run on committed checkout + artifact, Windows CI, agent eval (or BLOCKED) |

## Execution mode

This dashboard session has no separate-session delegation mechanism available to the
agent, so phases run **sequentially in this one session**, advancing continuity records
in the repo between phases (as the brief allows: "do not pretend a session was opened").

## Capabilities (kept distinct)

1. **Installer test** — deterministic, runs anywhere Node runs.
2. **Working reference test** — .NET / TypeScript against real PostgreSQL (Docker).
3. **Real agent evaluation** — needs a real agent runtime; Windows has `claude`/`codex`/`kiro`
   CLIs present (auth/subscription to be confirmed in P02), `debian-test` has none.

## Known findings posture

F01–F07 / G1–G4 were fixed and tested in prior rounds; they are treated as regressions to
**keep green**, not re-opened as findings without new evidence.
