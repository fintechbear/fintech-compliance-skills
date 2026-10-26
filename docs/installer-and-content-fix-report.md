# Installer & content fix report

**Scope:** installer upgrade/migration, link/YAML validation, tests/CI, and the
content/compliance corrections from the repository analysis. Engineering guardrails
only — not legal advice, and not a claim that the repo is "compliant" or
"production-ready". This report states exactly what was changed and what was and was
not verified.

## Commits

- Base (reference for the findings): `19b4f33fdec992a410fc49971129663ff6b4e24e`
- WP1+WP2 (installer + tests + CI): `a6b9cbc14998245226e687d1ad95d171d6c0a388`
- WP3 (content/compliance): `8bf6e8e08fa3663548133379ab96fc0181990962`

Work was done in a separate git worktree on branch `installer-content-hardening`,
off `origin/main`. No reset to the reference commit; the main checkout was untouched.

## Environment

- Local: Windows, Node `v24.14.1`. Test dependency: `js-yaml@^4.1.0` (devDependency
  only; the installer runtime has zero dependencies).
- CI (configured, not run by me): `.github/workflows/verify.yml` on
  `ubuntu-latest` + `windows-latest`, Node 18 and 20.

## Commands run and results

| Command | Result |
|---|---|
| `node --test --test-force-exit installer/test.js` | exit 0 — **15 tests, 15 pass, 0 fail** |
| `node installer/verify.js` | exit 0 — all structural checks passed (28 Codex refs resolve, 0 broken links, frontmatters valid, overwrite protection, migration) |
| `npm pack --dry-run` | tarball contains `installer/index.js` + `skills/` + README + LICENSE (test/verify excluded via `files`) |

The 16th matrix item ("install from the packed npm artifact") is implemented inside
the suite as the `packed artifact` test (it runs `npm pack`, extracts the tarball,
and installs from it); it is one of the 15 passing tests.

## Findings — status

### WP1 — installer & migration

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| A | Old unedited installs skipped (no hash stamp → treated as user-edited) | **fixed** | `installSkillDir`/`classify` reproduce the previous installer's exact output (`legacyOutputs`) and byte-match it → migrate with `.bak`; tests "migration: unedited legacy …" and "… EDITED legacy …" |
| B | Old Codex `AGENTS.md` section not cleaned; stale `skills/…` refs linger | **fixed** | `mergeCodexBlock` removes legacy marker sections (incl. duplicates) and writes one managed block; test "Codex migration: legacy + duplicate …" |
| C | `.fintech-compliance-skills` wiped unconditionally each run | **fixed** | manifest-based ownership + staged-then-swapped writes; unknown user files preserved; rollback on failure; tests "unknown user file …" and "atomicity …" |
| D | `--tool kiro` wrote to `~/.kiro/crew/skills` for all Kiro products | **fixed** | split into `kiro` (`~/.kiro/skills`, `--scope workspace` → `.kiro/skills`) and `kiro-crew` (`~/.kiro/crew/skills`), per kiro.dev/docs/skills; testable `--home`/`--target` resolver; test "Kiro CLI/IDE + Crew resolve …" |

### WP2 — validation, tests, CI

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| A | Link check only handled `../`; `./java.md` (scala) broke after install | **fixed** | `rewriteRelativeLinks` handles `./` and `../`; anchors split off; external URLs untouched; verified on the installed artifact; test "local links …" |
| B | "YAML valid" asserted by regex, not a parser | **fixed** | tests parse every frontmatter with `js-yaml`; colon/quote/backslash/unicode + a negative fixture that must throw |
| C | Test matrix | **fixed** | 15-case suite covering clean installs (claude/kiro/kiro-crew/codex), idempotency, edit-preservation, `--force`, legacy migration (unedited + edited), legacy Codex + duplicates, unknown-file preservation, user text outside block, local links, YAML + negative, bad CLI args, mid-update failure recovery, packed-artifact install. Inventory is checked against the source set, not a loose ">= 20". |
| D | CI/publish gate | **fixed** | `verify.yml` runs `verify` + `test` + `pack` on ubuntu+windows / Node 18,20; `publish.yml` now runs the same gate before `npm publish`; `engines` set to `>=18`. No credentials added; no real publish performed. |

### WP3 — content & compliance

| Area | Status | What changed | Sources verified |
|---|---|---|---|
| .NET money conversion | **fixed** | ISO 4217 exponent-driven minor units; reject unsupported currency + over-precision; `checked`; src/dst currency check; JPY/USD/KWD examples | ISO 4217 exponent tables (Datatrans, 1010data) |
| .NET idempotency & authz | **fixed** | key scoped by (tenant, operation, key) + payload fingerprint → 409; object-level authz; post-commit retry; external-side-effect vs local-txn note | — (design, not a single source) |
| .NET PasswordHasher | **fixed** | PBKDF2-HMAC-SHA512, 100k iters on .NET 8 Identity v3; version-bound, not a constant | dotnet/aspnetcore v8.0.0 `PasswordHasher.cs`; MS Learn `PasswordHasherOptions.IterationCount` |
| PAN / SAD / CVV | **fixed** | PAN storable if rendered unreadable (Req 3.5.1); SAD never stored after auth (Req 3.3.1); "no CVV ever" labelled project policy stricter than the standard; README + refusal-policy made consistent | PCI SSC FAQ 1492, FAQ 1154 |
| Turkey scope | **fixed** | role-based: banks→BDDK (5411), payment/e-money→TCMB (Law 6493), AML→MASAK (5549), data→KVKK (6698); vendor non-inheritance; localization ≠ cross-border transfer | TCMB payment-services page + press release ANO2026-30; BDDK (Law 5411) |
| GDPR erasure | **fixed** | per-category evaluation (legal hold, AML retention, Art. 17 applicability); right not absolute; audit/backup/replica/crypto-shred limits | European Commission right-to-erasure page |
| PostgreSQL isolation + RLS | **fixed** | corrected blanket "READ COMMITTED insufficient"; RLS documented as strong-but-not-absolute with context-setting, role least-privilege, pool reset | postgresql.org transaction-iso docs |

No red line was removed or weakened. The PCI change is a re-classification (PAN vs
SAD) that is stricter and better-scoped, not a loosening; the SAD-after-auth
prohibition is preserved and sharpened.

## Migration behaviour

- A previous-installer `SKILL.md` with no hash stamp is recognised only by an exact
  byte match against the reproduced old output; on match it is upgraded and the
  original saved as `*.bak`. A file that does not match is treated as a user edit and
  left alone. `--force` is opt-in and never the default path.
- Codex: legacy marker sections (and duplicates) are folded into one managed block;
  user text outside the block is preserved; stale `skills/…` references are removed.

## User files preserved

- Edited `SKILL.md` / managed Codex files are skipped unless `--force`.
- Unknown files under `.fintech-compliance-skills/` are carried across re-installs.
- A failed Codex update rolls back to the previous working tree (test-verified).

## Verified official sources

- PCI SSC FAQ 1492 (Apr 2024) and FAQ 1154 (Jul 2025).
- dotnet/aspnetcore `v8.0.0/src/Identity/Extensions.Core/src/PasswordHasher.cs`; Microsoft Learn `PasswordHasherOptions.IterationCount`.
- TCMB payment-services page and press release ANO2026-30; BDDK Banking Law No. 5411.
- European Commission right-to-erasure guidance.
- PostgreSQL current docs, transaction isolation.
- kiro.dev/docs/skills for Kiro CLI/IDE paths.

## Not tested / not verified (explicit)

- **No real agent session was run.** The skills were not loaded into a live Claude,
  Kiro, or Codex session; behavioural effectiveness is not measured here.
- **The .NET Good example was not compiled** (it depends on project types absent
  from this repo). It is labelled *illustrative*, not production-ready.
- **Statute article numbers / retention periods**: GDPR Art. 17(3) exemptions and
  AML retention periods (~5–10y) are referenced from existing content, not freshly
  fetched primary statute text. The PCI requirement numbers (3.3.1 / 3.5.1) come from
  the cited FAQs, not from opening the full PCI DSS v4.0.1 standard.
- **TCMB DUY2026-04 PDF** could not be fetched directly; the claim it supported (TCMB
  supervises payment/e-money under Law 6493) is corroborated by other TCMB sources.
- **Turkey data-localization articles** were described at the level of "verify the
  specific rule", not quoted article-by-article.
- **Pre-.NET 6 PasswordHasher default** (SHA256 / 10,000 iters) is stated from general
  knowledge, not confirmed from the pinned source.
- The content review covered the files listed above; other language/database modules
  were not re-reviewed for compliance accuracy this cycle.

## Remaining blockers

- None blocking the branch. Open follow-ups (not in this change): compile-and-run a
  real .NET + PostgreSQL reference; confirm the statute/retention figures above
  against primary texts; behavioural (agent) evaluation of skills on/off.
