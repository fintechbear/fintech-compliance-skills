# Release closure — approved scope

Review base: `ff4b491974503d8b70db2c73e5c1200bbaa780f2` (PR #10). This document supersedes older R01–R12 closure claims.

## Explicit exclusion

**CLI tests: NOT RUN by the owner's explicit decision on 2026-10-28.** This includes installer/doctor command tests and install/update/uninstall smoke tests, packed-artifact CLI execution, Codex/Claude/Kiro runtime/session checks, and the 40×3 live-agent matrix. Earlier CLI/agent runs are historical evidence only; they do not verify this release. Pure parser/config/grader module tests do not invoke those CLIs. CLI compatibility and real-agent filesystem enforcement remain unverified. This is an accepted release limitation, not a passing test.

## Fixes

| Finding | Resolution | Regression evidence |
|---|---|---|
| Host execution + forged grader success | Candidate ES modules execute in QuickJS WebAssembly, with no host callbacks/module loader/process/fs/network; trusted runner compares export results against structured cases. Memory/stack/time budgets, clean child environment; stdout markers are not verdicts. | `evals/release.selftest.js`, `evals/grader.js` |
| Warning + forbidden implementation receives PASS | Known prohibited patterns fail; other code-bearing refusal outputs are NEEDS_REVIEW, never auto-PASS. Pure refusal prose remains supported. | release module regressions |
| Outbound tenant key collision / changed payload | Provider key is hashed over operation/provider/tenant/client key; business binding is checked; a new key cannot create a second intent for an existing business. | real-PG webhook suite |
| Terminal event ordering / parallel first writes | One projection per provider/business, atomic UPSERT, terminal outcome retained; contradictory terminal evidence recorded separately. Tests send actual pending and conflicting terminal events and use parallel consumers. | real-PG webhook suite |
| Refund confirmation without audit | Conditional confirmation + audit use one local transaction; concurrent recovery appends the transition once. Provider calls stay outside the transaction and reuse the saved key. | real-PG refund suite; forced CHECK failure + recovery |
| Unknown external outcome test gap | Labelled provider doubles support effect-success followed by lost response; same-key recovery does not duplicate the effect. These are not real provider sandbox tests. | webhook/refund suites |
| YAML/TOML loss | Full parsers with allow-lists; folded YAML, comments, nested/inline maps, quoted provider names and headers covered. js-yaml is now an installed runtime dependency. | pure module tests; CLI integration NOT RUN |
| Eval read boundary | Explicit minimal + exact-workspace filesystem profile replaces broad legacy read-only config; no personal instructions copied. Runtime CLI enforcement NOT RUN. | configuration tests only |
| Schema unsupported optional branches | Schema preflight visits every properties/definitions/items branch; boolean false rejects; malformed/unsupported schema fails closed. | schema + release module tests |
| Secret/AML attribution | Distinguish password hashes from retrievable encrypted secrets; candidate/PEP/confirmed sanctions matches are distinct; hold/freeze follows applicable law or declared policy. | primary source links in catalog and review notes |

## Required release gate

`.github/workflows/verify.yml` runs the non-CLI module matrix on Windows/Linux × Node 18/20/22/24, grader/config/schema/catalog checks, negative-gate mutations, TypeScript typechecking, .NET and TypeScript harnesses against real PostgreSQL 16. CLI job is explicitly SKIPPED. The publish workflow calls that exact reusable gate, packs once, retains tarball + SHA-256 + inventory, then publishes the same tarball. It never invokes a product CLI.

Use the current PR Checks / Verify run as the authoritative source for pass/fail. Each successful workflow writes `release-evidence` with the full tested `github.sha`, source-tree digest and per-job conclusions. A static document cannot contain its own commit hash; older short HEADs must not be read as the current release subject. Artifact byte hashes are recorded for the actual tarball in the publish workflow, not copied from an older pack.

## Readiness definition

Ready for publication preparation when the required non-CLI gates pass on the current PR head, with the above CLI exclusion disclosed. No comparative agent-effectiveness claim is made. Real provider integration, live agent evaluation and npm account/OIDC authorization are not verified by these tests. Merge/tag/npm publication are separate external actions; no publication is claimed by this report.
