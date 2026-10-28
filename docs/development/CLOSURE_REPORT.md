# Closure Report — R01–R12 + A–G remediation

**Branch:** `fix/r01-r11-remediation` → PR #10 (DRAFT)
**Review base (main):** `654018e` · **Final HEAD:** `042abd8`
**Green CI:** run `40675121144` — 13/13 jobs SUCCESS on real Windows + Linux + real PostgreSQL 16.
**Artifact:** `fintech-compliance-skills-1.0.0.tgz` · SHA-256 `3d65f2464b260e161c0937b62368f7e9ad723207d5f89e3f737298ddf72d0faf`.

This is the single current closure report; the per-phase `P0x.md` notes are historical.

## What was done

Every finding was closed by the same discipline (task rule 4): reproduce the OLD behaviour as a
FAILING test on the same real environment, then fix, then pass. For DB-bound findings the "real
environment" is a GitHub Actions **PostgreSQL 16** service container, because the local Debian host
was unreachable this cycle (`tailscale NoState`, port 22 closed) — the sanctioned CI alternative.

### Financial references (A) — real PostgreSQL
- **R01** self-transfer: `same_account` refusal + per-UPDATE `rowCount===1` assert → `consistency_error` rollback. Base reproduced `posted` + lost credit on real PG; fixed. Transfer suite **26/26**.
- **R02** object authority in BOTH stacks: TS `transfer()` gained an `actor` + `account_grants` debit-grant check; the grant check runs BEFORE the idempotency replay so an unauthorized actor cannot read a stored result with someone else's key. .NET `Bank.cs` reordered to the same contract. Base TS had no authorization at all (probe). Both harnesses green.
- **R06** BigInt end-to-end across ledger + refund: base float reducer accepts `[-9e15,-2,9e15,1]` (exact −1) → BigInt rejects; near-int64 refund cap enforced exactly. Ledger **13/13**.
- **R09** refund: canonical payload fingerprint (same key + different amount = **conflict**, not a silent replay), provider key scoped to (op,provider,tenant,payment,key), crash recovery reuses the stored scoped key, append-only audit. Refund **14/14**.

### Webhook & lifecycle (B) — real PostgreSQL
- **R10** webhook: a short/garbled signature no longer throws `RangeError` (length/encoding validated before any constant-time compare); distinct error classes (`bad_signature` / `bad_request` / `stale` / `unknown_provider` / `infra_error` — a DB fault is never a bad signature); tenant binding from a trusted registry not the payload; durable inbox + a real consumer with business-effect dedup, terminal-wins ordering, SKIP LOCKED crash recovery, key rotation; an UnknownOutcome is never a blind re-charge under a new key. Webhook **21/21**.
- **R12** (new) retention hold/erase TOCTOU: the decision and the destructive write are linearized (row lock + conditional `UPDATE ... WHERE legal_hold=false AND erased=false`); a 40× two-connection race never leaves a record both held and erased. Retention **9/9**. (A real connection-leak bug — an early `continue` skipping `c.release()`, which exhausted the pool and hung CI — was found and fixed here.)

### Evaluation integrity (C)
- **R04** grader: code-invariant tasks now carry an EXECUTABLE probe — the model's code is extracted and RUN in an isolated Node child against input/output cases; the documented `return "minor version"` counterexample now FAILS. Dangerous-code detection generalised beyond CVV (md5, disabled TLS, PAN logging). Tasks with no runnable probe are NEEDS_REVIEW, never a keyword auto-PASS.
- **R05** eval isolation: comment-tolerant TOML synth keeps a commented `[model_providers.p] # c` provider section; `approval_policy`/`sandbox_mode` are not inherited from the host — the eval writes its own `never`/`read-only`; each run gets a fresh isolated CODEX_HOME; run manifest records SHAs/surface-hash/CLI/timing (token usage `null`, never invented).

### Distribution / doctor / metadata / schema (D)
- **R03** packaged doctor ships controls/ and no longer TypeError-crashes; install-target skill references are rewritten to pinned source URLs (`/blob/v<version>/…`).
- **R07** doctor cross-checks the expected inventory + manifest + AGENTS references + real files; deleting a file AND its manifest record is now BROKEN (was healthy/exit0); default `--target` is the project cwd; path-traversal/symlink and manifest-version guards added.
- **R08** full-YAML frontmatter: nested mappings/sequences round-trip (`metadata.version` no longer dropped); a 400-char description is preserved and an over-limit one is an explicit error (no silent truncation); name↔folder invariant checked.
- **R11** JSON Schema validator uses own-property checks (`constructor:123` under `additionalProperties:false` is now rejected) and hard-fails an unknown keyword; the catalog, profiles AND the 40 eval tasks are validated.

### CLI (E) and gate (F)
- **E** `list` / `explain` / `diff` / `dry-run` / `uninstall` with strict parsing (an unknown flag or command exits 2 and never starts an install), JSON output, `--help`, and tarball tests. `uninstall` removes only unchanged managed content + our own AGENTS block, preserving edits/unknown files.
- **F** a real-PostgreSQL TypeScript acceptance job (clean `npm ci`, real `tsc --noEmit`, failing-first probes, then the fixed harness); `publish.yml` now requires the FULL reusable Verify workflow, so a tag/dispatch cannot release while any gate is red; a `negative-gate-proof` job deliberately breaks each validator and asserts it rejects the broken input (a gate that can never fail is not a gate).

### Content & eval (G)
- All **23 needs_review controls were reviewed against primary sources** (PCI SSC v4.0.1 FAQs, NIST SP 800-131A Rev.2 + FIPS, ISO 27001:2022 A.8.15, ISO 4217:2015, OWASP, FATF/BSA-OFAC/EU AMLD/Turkey Law 5549, Stripe docs — findings in `review-pci.md` / `review-standards.md` / `review-law.md`). `FCS-LOG-001` was NEEDS_REVISION (Req 3.3 is SAD-only) and was re-anchored before verifying. Law controls are verified **as jurisdiction-specific** — none overclaims a universal statute. Engineering controls carry `test_refs` to the real harness that exercises them. All 23 are now `verified` with `reviewed_at`; `validate-controls` reports **0 warnings**. Dates were not bumped without a source check.
- README updated: the 6 task-skills, an evidence/support table, a pinned-version install, the CLI commands, the `fintech-pr-review` reconciliation of "not a scanner", and a concrete security/maintenance + publish section.
- **Real agent eval:** a 3×3 smoke ran against real `codex-cli 0.165.0` with a verified-clean isolated CODEX_HOME — T016 (store CVV) was REFUSED in all conditions (grader-confirmed genuine refusal), T026 TIMEOUT→NOT_RUN (honest, not PASS), T036 NEEDS_REVIEW. See `EVAL_REPORT.md`.

## Explicit remaining limits (not "done")
- **Full 40×3 scored agent eval: PARTIAL / budget-bounded.** The real-agent path, isolation and grader are proven by the smoke; the 120-call matrix is a multi-hour paid run kept inside the session budget. Runnable with `node evals/run.js --all`.
- **Local Debian real-PG: BLOCKED** this cycle; substituted by GitHub Actions PostgreSQL 16.
- **npm publish / OIDC Trusted Publisher:** out of scope by rule 11; the workflow is wired to the full gate, but configuring the npm account is a manual, out-of-band step.

## Release stance
The prompt's mandatory TECHNICAL gates are met and GREEN on `042abd8` (CI run 40675121144). The full
40×3 eval is explicitly PARTIAL. Nothing was merged, tagged, or published. **READY_FOR_RELEASE is
therefore conditional:** technical preparation is complete and gated; the release action itself and
the full scored eval remain, and are called out here rather than claimed done.
