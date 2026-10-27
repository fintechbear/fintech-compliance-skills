# Installer & content fix report

**Scope:** installer upgrade/migration, loss-of-data safety, link/YAML validation,
tests/CI, and the content/compliance corrections for this repository. Engineering
guardrails only — **not** legal advice, and **not** a claim that the repo is
"compliant", "secure", or "production-ready". This report states exactly what was
changed and what was and was not verified.

## Commits

- Reference the independent review ran against: `05590bf40e670da1de5bd13f877f30f864e51f20`
  (the current head of PR #7 at the start of this work — the findings F01–F07 were
  reproduced against this tree).
- Earlier branch history (already on PR #7 before this work):
  - `a6b9cbc` — WP1+WP2 (first installer/test pass)
  - `8bf6e8e` — WP3 (first content pass)
  - `05590bf` — WP4 (first report)
- This work (new commits on the same branch `installer-content-hardening`):
  - **`4da322c`** — WP1+WP2: fix F01–F07 installer/migration/CI bugs + offline fixture-based tests
  - **`fa2642c`** — WP3: source-verify content; fix 2 proven factual errors

Done in a separate git worktree off `origin/main`. No reset to any reference commit;
`main` was never pushed to; PR #7 was not merged; no npm publish was run.

## Environment

- Local: Windows, Node **v24.14.1**. Test dependency: `js-yaml@^4.3.2` (devDependency
  only; the installer runtime has **zero** dependencies).
- CI (configured; **not** run by me — see "Remaining blockers"):
  `.github/workflows/verify.yml` on `ubuntu-latest` + `windows-latest`, Node **18, 20, 22**.

## Commands run and results (local, on HEAD `fa2642c`)

| Command | Result |
|---|---|
| `npm ci` (after `rm -rf node_modules`) | exit 0 — 2 packages, 0 vulnerabilities |
| `node installer/verify.js` | exit 0 — all structural checks pass (28 Codex refs resolve, 0 broken links, YAML valid, overwrite protection, inventory == source) |
| `node --test installer/test.js` | exit 0 — **23 tests, 23 pass, 0 fail**, ~4.5s |

The test command no longer uses `--test-force-exit` (F06): the suite terminates on its
own, so the command now matches the declared `engines` (`>=18`).

## Historical fixtures (offline, from real old code)

Migration recognition and the F04/F05 tests depend on byte-exact output from the
**previous** installers, captured by running them from git history — never regenerated
from current code.

- `installer/fixtures/pr5/claude/*.SKILL.md` — output of commit
  **`b742e893f8c7eb69e194807d458b3f4f5022af7c`** (PR#5 installer: unescaped
  frontmatter, no link rewrite, **no** hash stamp).
- `installer/fixtures/pr6/claude/*.SKILL.md` — output of commit
  **`19b4f33fdec992a410fc49971129663ff6b4e24e`** (PR#6 installer: quoted frontmatter,
  link rewrite, **with** hash stamp).
- `installer/fixtures/FIXTURES.json` — provenance (source commits + per-file sha256
  prefixes). Fixtures are pinned to LF in `.gitattributes` so the hashes match on every OS.
- The runtime recognises an unedited old file via a fixed `LEGACY_FILE_HASHES` table in
  `installer/index.js`, generated from those fixtures (old code), not from the current
  installer.

## Findings F01–F07 — status

Each was reproduced as a failing regression test against `05590bf`, root-caused, fixed,
and re-checked with the same test unchanged.

| ID | Finding | Status | Root cause | Verification |
|---|---|---|---|---|
| **F01** | Codex migration could delete user text **after** a legacy section; no AGENTS.md backup | **fixed** | legacy-section removal ran to EOF/greedy | `mergeCodexBlock` now bounds a legacy section to its **last `skills/` reference** and keeps everything after it verbatim; AGENTS.md backed up to `.bak` (never overwriting an existing backup). Tests `F01`, `F01b`, `F05b` |
| **F02** | Codex update left old rules; manifest keys `core/file.md` vs lookup `skills/core/file.md`; managed files mistaken for user files; `--force` couldn't update | **fixed** | two different manifest-key conventions | single contract: keys are `skills/<group>/<file>`; a legacy prefix-less manifest is normalised on read. A→B update replaces unchanged managed files, preserves + reports an edited one, keeps unknown files; `--force` replaces. Tests `F02`, `F02b`, `11` |
| **F03** | No rollback if AGENTS.md **write** failed (tree already swapped, backup already deleted) | **fixed** | backup deleted before the final write | the tree backup is kept until **both** the tree swap **and** the AGENTS.md write succeed; a write failure restores the previous tree; first-install failure leaves no "success". Failure is injected at the **write** stage (stubbed `fs.writeFileSync` for `AGENTS.md`), not the read stage. Tests `F03`, `F03b` |
| **F04** | Real old Claude install didn't fully upgrade: 20/26 upgraded, 6 content-changed files mistaken for user edits | **fixed** | `legacyOutputs` reproduced from **current** body, which differs from the old body for changed files | recognition now uses a **byte-exact full-file hash table** captured from the real old installers; the 6 changed modules upgrade, an actually-edited old file is preserved byte-for-byte. Tests `F04` (26/26 migrate, 0 skipped, `.bak` == original), `F04b` (edited → preserved) |
| **F05** | Marker-less legacy Codex section (old installer on an empty target wrote no marker) not recognised → 26 stale `skills/…` refs left | **fixed** | only the marker path was handled | the legacy **heading** is recognised with or without the marker; marker-less, with-marker, duplicate, and mixed sections all collapse to one managed block and old refs are removed. Tests `F05a`, `F05b`, `F05c` |
| **F06** | Node 18 CI fails: `--test-force-exit` in `npm test` not supported on Node 18 | **fixed** | flag unavailable on the declared minimum | flag removed (suite exits cleanly on its own; no handle leak masked). `engines` stays `>=18`; CI matrix adds Node 22. Verified by a clean `node --test` run exiting 0 |
| **F07** | Anchor links (`./java.md#hashing--encryption`) not rewritten | **fixed** | regex didn't capture the `#anchor` | `rewriteRelativeLinks` rewrites `./` and `../` `.md` paths **and preserves the anchor**; inline/fenced code and external URLs untouched. Tests `F07`, `12` |

### Full installer review (beyond F01–F07)

- Targets covered: claude (project + `--scope user`), kiro (`~/.kiro/skills` + `--scope
  workspace`), kiro-crew (`~/.kiro/crew/skills`), codex. Testable `--home`/`--target`
  resolver so no test writes to a real home.
- Staging/backup use **unique, non-colliding** names (`.fcs-stage-<pid>-<ts>` /
  `.fcs-old-<pid>-<ts>`) instead of fixed `.old`/`.tmp`, so a concurrent run or a real
  user `*.old` file is not clobbered. No orphan staging/backup dirs after a failed run
  (asserted in `F03`).
- Bad CLI args (`--tool nope`, `--scope bogus`) exit non-zero with a message (test `14`).
- Inventory is compared to the **source set**, not a loose `>= 20` (verify.js + test `1`).

## Content & compliance (WP3)

The compliance content had already been revised on this branch before this task. Per
the instruction "if a problem is already fixed, verify it rather than re-applying", I
**independently source-verified** the strong claims and fixed **only** genuine errors.
Full per-claim findings with source URLs + dates are in the four reports under
`scratch/findings/` (summarised here).

| File / area | Status | Primary source (checked 2026-10-27) |
|---|---|---|
| csharp-dotnet money (ISO 4217 exponent, reject over-precision, `checked`, src/dst currency) | **already fixed — VERIFIED** | ISO 4217:2015; exponent groupings |
| csharp-dotnet PasswordHasher versioning | **CORRECTED** | dotnet/aspnetcore v5.0.0/v6.0.0/v7.0.0/main `PasswordHasher.cs` — the upgrade to SHA512/100,000 landed in **.NET 7**, not pre-.NET 6 (v6 still used SHA256/10,000). Text was off by one version; fixed. |
| csharp-dotnet Argon2id (19 MiB / t=2 / p=1) | **already fixed — VERIFIED** | OWASP Password Storage Cheat Sheet |
| csharp-dotnet idempotency + object-level authz | **already fixed — VERIFIED** | internal consistency of prose vs. illustrative code |
| PCI PAN / SAD / CVV (Req 3.5.1 / 3.3.1), tokenization-preference vs stricter project policy | **already fixed — VERIFIED, no contradictions across pci-dss/refusal/README** | PCI DSS v4.0.1 Req 3.5.1 / 3.5.1.1 / 3.3.1; PCI SSC FAQ (hashed PAN; SAD-before-auth); 31 Mar 2025 keyed-hash date |
| Turkey authority mapping (BDDK 5411 / TCMB 6493 / MASAK 5549 / KVKK 6698), localization ≠ cross-border, vendor non-inheritance | **CORRECTED** | BDDK Law 5411; Law 6493 (20/6/2013); the BDDK→TCMB transfer amendment date was **22 November 2019 (amending Law No. 7192)**, per the U.S. Library of Congress Global Legal Monitor — file said "20 November"; fixed. Everything else VERIFIED. |
| GDPR erasure not absolute (Art. 17(1)/(3)), per-category, legal hold/backup/replica; AML retention 5–10y; PSD2 no screen-scraping | **already fixed — VERIFIED** | Regulation (EU) 2016/679 Art. 17; Directive (EU) 2015/849 Art. 40 (5y floor, up to 10y via MS extension); PSD2 Dir (EU) 2015/2366 + RTS 2018/389 |
| PostgreSQL READ COMMITTED atomic-UPDATE debit + 40001 retry; RLS owner-bypass/FORCE/superuser limits/context trust | **already fixed — VERIFIED** | PostgreSQL docs §13.2.1–13.2.3 and §5.9 (ddl-rowsecurity) |

**No red line was removed or weakened.** Both content edits are factual corrections
(a version boundary and a date) backed by a primary source.

## Migration behaviour (summary)

- A stamp-less `SKILL.md` is migrated **only** on a byte-exact match to a known old
  installer output (hash table); the original is saved as `*.bak`. A non-match is
  treated as a user edit and left alone. `--force` is opt-in, never the default.
- Codex: marker-less / marked / duplicate / mixed legacy sections fold into one managed
  block; user text outside the block is byte-preserved; stale `skills/…` refs removed;
  AGENTS.md is backed up first.

## User data preserved / rollback (test-verified)

- Edited `SKILL.md` and edited managed Codex files are skipped unless `--force` (`5+6`,
  `F02`, `F04b`).
- Unknown files under `.fintech-compliance-skills/` survive re-install (`11`).
- A failure writing AGENTS.md rolls the rule tree back to the previous good version and
  leaves no orphan staging dirs (`F03`, `F03b`).

## Not tested / not verified (explicit)

- **No real agent session was run.** Skills were not loaded into a live Claude, Kiro, or
  Codex session; behavioural effectiveness is not measured.
- **The .NET "good example" was not compiled** (it depends on project types not in this
  repo). It is labelled *illustrative*; its idempotency/authz logic was reviewed for
  internal consistency only, not executed.
- **CI was configured but not executed by me.** The results above are from the SAME
  checkout CI runs (`npm ci` + `verify` + `test`) on local Windows/Node 24. The Node
  18/20/22 × ubuntu/windows matrix result for commit `fa2642c` must be read from GitHub
  Actions after push (see Remaining blockers).
- **Some statute text was read via reputable secondary reproductions** (e.g. EUR-Lex
  mirrors, PCI SSC FAQ pages, Library of Congress) rather than always the first-party
  PDF; the TCMB DUY/press-release PDFs were corroborated across multiple TCMB sources
  rather than opened article-by-article. The KVKK Art. 9 (2024, Law 7499) transfer
  reform is not cited in the file (a non-error omission, left as-is).
- The content review covered the files listed; **other language/database modules were
  not re-reviewed** for compliance accuracy this cycle.

## Correction to the previous report

The prior report (`05590bf`) listed "15 tests" and marked the pre-.NET-6 PasswordHasher
figure and the Turkey amendment date as settled. This cycle: the suite is **23 tests**;
the PasswordHasher version boundary was **wrong (.NET 7, not pre-.NET 6)** and is fixed;
the Turkey date was **wrong (22 Nov 2019, Law 7192)** and is fixed. The previous
"Remaining blockers: none" is replaced by the explicit list below.

## Remaining blockers

- **CI result for the final commit (`fa2642c`) must be confirmed on GitHub Actions**
  after the branch is pushed. Local runs pass; the cross-platform/Node-matrix result is
  only authoritative from Actions on that exact commit.
- Open follow-ups (out of scope here): compile-and-run a real .NET + PostgreSQL
  reference; a live agent-session evaluation of the skills; first-party PDF confirmation
  of the remaining statute/retention figures.
