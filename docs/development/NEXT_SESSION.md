# Next session

**State:** R01–R12 + A–G remediation on `fix/r01-r11-remediation` (PR #10, DRAFT). HEAD `042abd8`.
Full Verify gate GREEN on real Windows + Linux + real PostgreSQL 16 — CI run **40675121144**.
All 23 controls verified vs primary sources; `validate-controls` 0 warnings. Nothing merged/tagged/published.

## What remains (explicit, bounded)

1. **Full 40×3 scored agent eval** (currently PARTIAL). The real 3×3 smoke is done and proves the
   path (real codex, isolated CODEX_HOME, grader). To finish the matrix:
   - `node evals/run.js --all` against real `codex-cli` with an authorized budget.
   - Raise the per-task timeout above 150s for the slow task classes (T026 timed out at 150s).
   - Keep ≤120 calls, no new quota, no unlimited retries. Re-grade only affected tasks after fixes.
   - Record runtime/model/timeout/permission-failure/truncation visibly; a critical FAIL must not be
     hidden by an average; qualitative results judged for real (no keyword auto-PASS of own output).
   - Add the runtime read-isolation sentinel test (allowed sentinel readable; forbidden prep/grader
     sentinel NOT readable through the agent's own tool path) — the config-leak isolation is already
     proven by `eval-harness-selftests`.

2. **Release action** (out of scope here by rule 11): once a human authorizes it,
   - tag `v1.0.0` (publish.yml waits for the full gate, packs once, publishes that tarball);
   - configure the npm Trusted Publisher (OIDC) or `NPM_TOKEN` — a manual, out-of-band step.

3. **Local Debian real-PG** was down this cycle; if it returns, the TS/.NET harnesses + baseline
   probes can also be run there for an independent second real-DB confirmation (CI PG16 already covers it).

## Do NOT
- Do not mark the full eval or release as done without the above.
- Do not merge/tag/publish without explicit authorization.
- Do not regenerate historical fixtures (`installer/fixtures/`); add a new fixture for a new format.
- Do not set a control `verified` without a primary-source check (dates alone are not a review).

## Key pointers
- Closure: `docs/development/CLOSURE_REPORT.md`; matrix: `ACCEPTANCE_MATRIX.md`; machine manifest:
  `result-manifest.json`; eval: `EVAL_REPORT.md`; source reviews: `review-{pci,standards,law}.md`.
- Real-PG harnesses: `examples/ts-postgres-harness/` (+ `baseline-regression.sh` failing-first probes),
  `examples/dotnet-postgres-harness/`. CLI + doctor: `installer/index.js`, `installer/diagnose.js`.
