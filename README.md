# Fintech Compliance Skills

> **Release validation scope: CLI tests were not run for this release by explicit scope decision. Installer/doctor command flows and live Claude Code/Codex/Kiro sessions remain unverified.** The required gate is `npm run test:release:noncli` (pure module, schema, catalog, grader and content tests) plus TypeScript typechecking and the real PostgreSQL .NET and TypeScript harnesses, summarised by the `release-readiness` CI check. A green gate does not certify CLI compatibility, agent effectiveness, or real provider integration. Current scope and evidence: [`docs/development/RELEASE_CLOSURE.md`](docs/development/RELEASE_CLOSURE.md) (shipped in the package).

**Guardrails that make AI coding assistants write regulation-aware financial
software — and refuse to write code that would break the rules.**

When you ask an AI agent (Claude Code, Kiro, Codex, Cursor, …) to "store the card
number" or "log the request", it will happily do the literal thing — including the
unsafe version. These skills sit in front of the agent as a rulebook: before it
writes financial code it loads the relevant rules, follows them, and **stops and
says no** when a request crosses a hard line (storing a raw card number, hashing a
password with MD5, logging a CVV, skipping the AML check).

> ⚠️ **Engineering guardrails, not legal advice.** These files encode widely
> accepted security and compliance practice (OWASP, PCI-DSS, NIST, regulator
> guidance). They do **not** replace a compliance officer or a lawyer. Always
> confirm your obligations for your jurisdiction with a qualified professional.

---

## What this repo is

- A set of **plain-Markdown rule files** ("skills"), one per topic, language, and
  database. Each one tells an AI agent what to **do**, what to **never do**
  (red lines), and shows a good vs. bad code example.
- **Tool-agnostic.** The rules are just Markdown. An installer adapts them into the
  native format of whichever agent you use.
- **Opinionated and specific.** Not "be secure" hand-waving — concrete algorithms
  (Argon2id for passwords, AES-256-GCM + KMS for card data), concrete library names
  per language, concrete logging rules (what is masked, what is never logged).
- **International + local.** The same action is shown changing across the EU, US,
  Turkey and UK, because the right answer depends on where your users are.
- **Open source**, Apache-2.0. Contributions for new jurisdictions, languages and
  databases are welcome.

## What this repo is **not**

- **Not a library or SDK.** There is no code to import, no runtime, no dependency to
  add to your app. It changes how the *agent* writes your code, not your app itself.
- **Not legal or compliance certification.** Following these skills does not make you
  "PCI compliant" or "GDPR compliant" — that is an organisational process. They help
  you avoid the common, well-known engineering mistakes.
- **Not an automatic scanner or linter.** It does not silently read your whole
  codebase in the background and flag issues. It guides code as it is written — and,
  when you explicitly ask, the `fintech-pr-review` skill reviews a specific diff/file
  and reports per-finding (control id, file:line, trigger, evidence) without inventing
  a false-precision score. That on-request review is not a substitute for a scanner or
  a human reviewer.
- **Not a guarantee.** An AI agent can still make mistakes. These skills reduce the
  obvious, dangerous ones; they do not remove the need for human review.

## Who it is for

- **Juniors and teams new to fintech**, who do not yet know every red line by heart.
  The agent carries the checklist so you do not have to memorise it.
- **Anyone using an AI coding agent on financial software** — payments, banking,
  lending, wallets, ledgers, KYC/onboarding, anything touching money or financial PII.

---

## Install

### Easiest — one command, straight from GitHub (no npm account needed)

```bash
npx github:fintechbear/fintech-compliance-skills
```

It asks which agent you use and installs the rules in the right place and format.
That's it — nothing to clone, nothing to publish.

Non-interactive (CI or scripts):

```bash
# Claude Code, into the current project
npx github:fintechbear/fintech-compliance-skills --tool claude --target .

# Kiro CLI / IDE (global skills: ~/.kiro/skills)
npx github:fintechbear/fintech-compliance-skills --tool kiro
#   ...or workspace-scoped (.kiro/skills in the project):
npx github:fintechbear/fintech-compliance-skills --tool kiro --scope workspace --target .

# Kiro Crew (~/.kiro/crew/skills)
npx github:fintechbear/fintech-compliance-skills --tool kiro-crew

# Codex CLI, into the current project
npx github:fintechbear/fintech-compliance-skills --tool codex --target .
```

### Where each tool gets the skills

| Tool | Where it installs | Format |
|------|-------------------|--------|
| **Claude Code** | `<project>/.claude/skills/<name>/SKILL.md` (`--scope user` → `~/.claude/skills`) | one folder per skill, with YAML frontmatter |
| **Kiro CLI / IDE** | `~/.kiro/skills/<name>/SKILL.md` global (`--scope workspace` → `<project>/.kiro/skills`) | one folder per skill, with YAML frontmatter |
| **Kiro Crew** | `~/.kiro/crew/skills/<name>/SKILL.md` | one folder per skill, with YAML frontmatter |
| **Codex CLI** | `<project>/AGENTS.md` + `<project>/.fintech-compliance-skills/skills/` | a managed instruction block plus the rule files it points at |

Kiro CLI/IDE read skills from `.kiro/skills/` (workspace) and `~/.kiro/skills/`
(global) per the [Kiro docs](https://kiro.dev/docs/skills/); Kiro **Crew** is a
separate product with its own `~/.kiro/crew/skills/` path, so it is a separate target.

The installer is safe to re-run and to upgrade an older install:

- **Idempotent** — re-running produces byte-identical output; the Codex `AGENTS.md`
  keeps a single marker-delimited managed block (never duplicated).
- **Migration** — files written by the previous installer (no hash stamp) are
  recognised by reproducing the old output and matching it exactly, then upgraded to
  the new format with a `.bak` backup. Old Codex sections (including duplicates) are
  collapsed into the one managed block and their stale `skills/...` links removed.
- **Never clobbers your edits** — a `SKILL.md` (or managed Codex file) you changed is
  preserved and skipped unless you pass `--force`. A file we cannot prove is old
  installer output is treated as your edit.
- **Atomic** — writes are staged and swapped in; a failed update leaves the previous
  working install intact.

Flags: `--tool claude|kiro|kiro-crew|codex`, `--scope`, `--target <dir>`, `--home <dir>` (testing), `--force`, `--dry-run`, `--json`, `--help`.

### Pin to an immutable version

`npx github:fintechbear/fintech-compliance-skills` tracks the default branch. For a
reproducible install, pin to a full commit SHA (or to a release tag once one has been
published — no release tag exists yet):

```bash
npx github:fintechbear/fintech-compliance-skills#<full-commit-sha> --tool claude --target .
```

When the package is built from a clean checkout, `npm prepare` records that commit in
`installer/source.generated.json`. Installed skills then link every `controls/…` or
`examples/…` reference to that **exact commit** (`…/blob/<full-sha>/…`), for flat and
Codex installs alike. If the build is not pinned (no git, or uncommitted changes), the
reference stays as text with an explicit "not pinned" note — the installer never guesses
a version tag or points at the moving `main` branch.

### Commands (inspect, preview, remove)

```bash
# list every skill with its controls + verified/needs-review/test evidence
npx github:fintechbear/fintech-compliance-skills list --json

# explain why a profile selects which controls/skills (obligations are DECLARED, not inferred)
npx github:fintechbear/fintech-compliance-skills explain --profile tr-psp-postgres

# preview what an install would change — writes NOTHING
npx github:fintechbear/fintech-compliance-skills diff --tool claude --target .
npx github:fintechbear/fintech-compliance-skills --tool claude --target . --dry-run

# remove only the unchanged managed content we installed (your edits/unknown files are kept)
npx github:fintechbear/fintech-compliance-skills uninstall --tool claude --target . --dry-run
```

An unknown flag or command exits non-zero and never starts an install; every command
takes `--json` for machine output and documents its exit codes via `--help`.

After installing: **Claude Code** — restart or `/reload`; **Kiro** — loads on the
next session; **Codex** — reads `AGENTS.md` automatically at session start.

### Check your install (doctor)

Run a static self-check of what is installed:

```
# run the doctor bin from the package (note: -p selects the package, then the bin name)
npx -p github:fintechbear/fintech-compliance-skills fintech-compliance-skills-doctor
# or, in a clone:  node installer/diagnose.js
```

It reports which targets are installed, whether each managed skill is **current** or has
**drifted** (source is newer — re-run the installer), which files you **edited** (preserved),
and — for the source repo — that every `FCS-…` id a skill cites resolves to the control
catalog. It exits non-zero on a drifted install or an unresolved id, so it is CI-friendly.
It is a **static integrity check of the installed files, not a runtime compliance audit and
not a scanner** — it never claims your own code is compliant.

### Manual (any other agent)

Every skill is just a Markdown file under `skills/`. Point your agent's skill/context
loader at that directory, or paste the relevant file into the agent's context before
a task. Always include `skills/refusal/refusal-policy.md` so the agent knows its
hard limits.

---

## How it works

1. You ask the agent to build something (e.g. "save the customer's card on file").
2. The agent loads the relevant skill(s) — here, `global/pci-dss.md` plus your
   language and database files.
3. The skill tells it what to **do** (tokenise via the processor; if the PAN must
   be stored, render it unreadable — encrypt with managed keys, truncate, keyed-hash
   or tokenise) and what it must **never do** (readable PAN at rest, and — the hard
   PCI-DSS line — Sensitive Authentication Data such as CVV / full track / PIN
   stored after authorization).
4. If the request crosses a red line, the agent **refuses and explains which rule**
   instead of writing the unsafe code.

Every skill follows the same shape, so they are easy to read and extend:

1. **When to use** — the trigger
2. **Do** — required practices
3. **Never (red lines)** — hard stops that trigger a refusal
4. **Good example** — real, idiomatic code
5. **Bad example** — the realistic mistake, with the rule it breaks

---

## What's inside

| Folder | What's inside |
|--------|---------------|
| `skills/core/` | Baseline rules for all financial code (money as integers, idempotency, audit trail, least privilege) **plus six task-skills**: `fintech-transfer`, `fintech-ledger-reconciliation`, `fintech-refund-cancel`, `fintech-provider-webhook`, `fintech-retention-erasure`, `fintech-pr-review` |
| `skills/refusal/` | The hard limits — when and how the agent must say no |
| `skills/global/` | International frameworks: PCI-DSS (card data), ISO 27001 / SOC 2 (controls), AML / KYC / sanctions |
| `skills/regional/` | Jurisdiction rules: EU (GDPR, PSD2, DORA), US (SOX, GLBA, CCPA), Turkey (KVKK, BDDK, MASAK), UK (FCA, UK GDPR) |
| `skills/languages/` | Per-language: Java, Kotlin, Python, C#/.NET, Go, JS/TS, Rust, Scala, COBOL, PL/SQL |
| `skills/databases/` | Per-database: PostgreSQL, Oracle, SQL Server, MySQL/MariaDB, MongoDB, Redis, Db2 |
| `controls/` | The machine-readable control catalog (`catalog.json`), JSON Schemas, and example org profiles |
| `examples/` | Good vs. bad examples, plus **runnable references**: a .NET + PostgreSQL harness and a TypeScript + PostgreSQL harness |

### Evidence & support status

Controls are not asserted on trust. Each control records its source kind (law,
standard, project policy, engineering recommendation) and whether that source was
checked against its primary text; engineering controls are exercised by a **runnable
harness on a real PostgreSQL 16 database in CI** (no mocks). `controls/catalog.json` is
authoritative; this table is a summary. Support levels:

| Control(s) | Source (review status in the catalog) | Executable evidence |
|---|---|---|
| FCS-PAN-001 / SAD-001 / LOG-001 / TLS-001 | PCI DSS **v4.0.1** (Req 3.5.1 / 3.3.1 / 3.4.1+8 / 4.2.1) | refusal rules; graded eval (refusal tasks) |
| FCS-SECRET-001 | OWASP Password Storage Cheat Sheet (Argon2id 19 MiB/t=2/p=1) | refusal/eval |
| FCS-CRYPTO-001 | NIST **SP 800-131A Rev. 2** + FIPS 180-4/197, SP 800-38 | refusal/eval |
| FCS-MONEY-001 | ISO **4217:2015** minor units | `examples/ts-postgres-harness/bank.ts` + .NET harness |
| FCS-AUDIT-001 / IDEMP-001 / AUTHZ-001 | ISO 27001:2022 A.8.15 + SOX §§302/404; project engineering standard | `bank.ts` + `Bank.cs` (real PG, both stacks) |
| FCS-LEDGER-001 / RECON-001 | project engineering standard (double-entry) | `examples/ts-postgres-harness/ledger.ts` (BigInt-exact) |
| FCS-OUTBOX-001 / WEBHOOK-001 / OUTCOME-001 | Stripe webhooks + error-handling docs | `examples/ts-postgres-harness/webhook.ts` |
| FCS-REFUND-001 / REFUNDTERM-001 | project engineering standard | `examples/ts-postgres-harness/refund.ts` |
| FCS-ERASE-001 | engineering recommendation | `examples/ts-postgres-harness/retention.ts` |
| FCS-RETAIN-001 | **needs review** — EU GDPR Art 17(3)(b), EU AMLD Art 40, Turkey KVKK Art 7 and UK GDPR are separate claims, each still to be confirmed against its official text | `examples/ts-postgres-harness/retention.ts` |
| FCS-AML-001 | FATF standards + jurisdiction-specific law | refusal rules; graded eval |
| FCS-EVASION-001 | **needs review** — FATF Recommendations (a standard, not law) verified; national statutes not yet confirmed | refusal rules; graded eval |
| FCS-PRREVIEW-001 / SECRET-002 | project engineering standard | **documents only** — no executable test |

No control asserts a single universal statute; legal duties depend on the entity's
declared role and jurisdiction (`explain --profile`). The provider harnesses use a clearly-labelled **test double**, not a
live bank/Stripe sandbox. Run the catalog check yourself: `node controls/validate-controls.js`.

Each language and database file covers four things in depth:

- **Logging** — which events go where, what is masked (PAN, CVV, passwords, tokens,
  national IDs), what is never logged, and the structured-logging / redaction library
  for that stack.
- **Workflow** — payment / transfer / onboarding step order, where approval gates sit,
  idempotency, the concurrency/locking model, and where the audit record is written.
- **Hashing & encryption** — what is one-way hashed (passwords → Argon2id), what is
  two-way encrypted (card/IBAN/national ID → AES-256-GCM + KMS envelope), the concrete
  APIs for that language/engine, and what is forbidden (MD5/SHA-1, ECB, static keys).
- **Country differences** — how the same code changes for EU / US / Turkey / UK.

## The red lines (summary)

The refusal policy makes the agent stop rather than produce code that would:

- store a card number (PAN) in **readable** form at rest, or store Sensitive
  Authentication Data (CVV / full track / PIN) after authorization — storing the
  PAN is allowed only when rendered unreadable (encryption, truncation, keyed hash,
  tokenisation); our own stricter policy is to not store the CVV at all;
- store or log a password in plaintext, or hash one with MD5/SHA-1;
- write a card number, CVV, password, token or full national ID into a log;
- use weak or home-rolled crypto (MD5, SHA-1, DES, ECB, hardcoded keys);
- use floating-point for money;
- move money without idempotency and an audit record;
- skip a required KYC / AML / sanctions check.

See [`skills/refusal/refusal-policy.md`](skills/refusal/refusal-policy.md) for the full list.

---

## Contributing

New jurisdictions, languages, databases and frameworks are welcome. Keep the file
shape above, cite the regulation or standard **by name and clause** (and set
`verified: true` on a `source_ref` only after checking the primary text — reachability
of a URL is not verification), and **never weaken a red line**. Add a new fixture for a
new output format rather than regenerating historical evidence. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security & maintenance

- **Reporting:** report a suspected rule gap or a dangerous-code false-negative by
  opening a GitHub issue (or a private security advisory for anything exploitable).
  A control change must come with a primary-source citation and, for an engineering
  control, a harness test that exercises it.
- **Reporting a vulnerability:** see [`SECURITY.md`](SECURITY.md).
- **Dependencies:** one runtime dependency, `js-yaml` (skill frontmatter parsing).
  Dev/test tools are `@iarna/toml` and `quickjs-emscripten` (root `package-lock.json`)
  and the harness toolchains (`examples/ts-postgres-harness/package-lock.json`, the .NET
  project). `npm ci` installs the locked set; CI has no `npm install` fallback.
  Dependabot opens weekly update PRs; never use `npm audit fix --force`.
- **Release gate (non-CLI):** `npm run test:release:noncli`, the harness `tsc --noEmit`,
  and the real-PostgreSQL .NET and TypeScript harnesses, aggregated by the
  `release-readiness` Verify check. Installer/doctor command tests (`npm test`,
  `npm run verify`, `installer/test-diagnose.js`) are **not** part of this release gate
  and were not run for this release.

## Publishing to npm (maintainers)

The package can also be published to npm (so the command drops the `github:` prefix).
Publishing is automated by GitHub Actions (`.github/workflows/publish.yml`). It first
runs the full non-CLI **Verify gate** — module tests on Windows/Linux × Node 18–24, the
real-PostgreSQL .NET **and** TypeScript harnesses, the control catalog + schema checks,
the eval self-tests and the negative-gate proof — then packs **once**, keeps the tarball
with its SHA-256 and file list, and publishes **that same tarball** only if the release
guard agrees:

- the run is a `vX.Y.Z` tag equal to `package.json` version, and the tagged commit is
  already on `main`;
- the version is not already on the registry;
- the stamped source commit equals the commit being built.

A manual dispatch is **pack-only** by default; publishing by dispatch needs
`mode=publish`, the release tag ref, and the exact approved `expected_sha`.

Auth (pick one, configured out-of-band on the npm account — not done in this repo):

- **OIDC Trusted Publishing** (recommended, no stored secret): requires the package to
  exist on npm once and a Trusted Publisher configured for this repo+workflow on
  npmjs.com, and a recent npm (the workflow runs Node 24 / npm ≥ 11.5.1 and asserts it
  at runtime for `--provenance`).
- **`NPM_TOKEN`** repo secret (granular automation token) if you prefer a token.

Until an account is configured, the `npx github:…` command above works for everyone
today. The workflow's `npm pack`/`--dry-run` is **not** proof of publish rights — the
Trusted Publisher / token setup is a separate manual step.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
