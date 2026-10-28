# Fintech Compliance Skills

> **Release validation scope (2026-10-28): CLI tests are NOT RUN.** By the owner's explicit decision, installer/doctor command tests, installed-artifact CLI smoke tests, and live Claude Code/Codex/Kiro sessions are excluded from this release. Module tests, schema/catalog checks, TypeScript typechecking, and real PostgreSQL harnesses remain required. A green release gate does not certify CLI compatibility or agent effectiveness. See [current closure and evidence](docs/development/RELEASE_CLOSURE.md).

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
reproducible install, pin to a tag (a release) instead of a moving branch:

```bash
npx github:fintechbear/fintech-compliance-skills#v1.0.0 --tool claude --target .
```

Installed skills embed **pinned source URLs** (`…/blob/v<version>/…`) for any
`controls/…` or `examples/…` reference, so those links resolve from wherever the skill
ends up — the repo tree is not copied into your agent's skill directory.

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

Controls are not asserted on trust. Each citation was checked against its **primary
source**, and the engineering controls are exercised by a **runnable harness on a real
PostgreSQL 16 database in CI** (no mocks). Support levels:

| Control(s) | Source (verified) | Executable evidence |
|---|---|---|
| FCS-PAN-001 / SAD-001 / LOG-001 / TLS-001 | PCI DSS **v4.0.1** (Req 3.5.1 / 3.3.1 / 3.4.1+8 / 4.2.1) | refusal rules; graded eval (refusal tasks) |
| FCS-SECRET-001 | OWASP Password Storage Cheat Sheet (Argon2id 19 MiB/t=2/p=1) | refusal/eval |
| FCS-CRYPTO-001 | NIST **SP 800-131A Rev. 2** + FIPS 180-4/197, SP 800-38 | refusal/eval |
| FCS-MONEY-001 | ISO **4217:2015** minor units | `examples/ts-postgres-harness/bank.ts` + .NET harness |
| FCS-AUDIT-001 / IDEMP-001 / AUTHZ-001 | ISO 27001:2022 A.8.15 + SOX §§302/404; project engineering standard | `bank.ts` + `Bank.cs` (real PG, both stacks) |
| FCS-LEDGER-001 / RECON-001 | project engineering standard (double-entry) | `examples/ts-postgres-harness/ledger.ts` (BigInt-exact) |
| FCS-OUTBOX-001 / WEBHOOK-001 / OUTCOME-001 | Stripe webhooks + error-handling docs | `examples/ts-postgres-harness/webhook.ts` |
| FCS-REFUND-001 / REFUNDTERM-001 | project engineering standard | `examples/ts-postgres-harness/refund.ts` |
| FCS-ERASE-001 / RETAIN-001 | GDPR Art 17(3)(b) vs EU AMLD (≥5y) / Turkey Law 5549 & KVKK | `examples/ts-postgres-harness/retention.ts` |
| FCS-AML-001 / EVASION-001 | FATF + national AML law (jurisdiction-specific) | refusal rules; graded eval |
| FCS-PRREVIEW-001 / SECRET-002 | project engineering standard | qualitative (review skill) |

Law controls are **verified as jurisdiction-specific** — none asserts a single
universal statute. The provider harnesses use a clearly-labelled **test double**, not a
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
- **Dependencies:** the runtime is **dependency-free** (Node built-ins only); the only
  third-party packages are dev/test tools, pinned to exact versions
  (`installer/package.json`, `examples/*/package-lock.json`). `npm ci` installs the
  locked set; CI runs it clean with no `npm install` fallback. Review `npm audit` on
  the dev tools and bump via a PR that keeps the lockfile and CI green.
- **Evidence:** `node controls/validate-controls.js` (catalog + schema + citations),
  `node installer/diagnose.js` (install integrity), and the CI harnesses (real
  PostgreSQL) are the maintenance gates. The publish workflow will not release unless
  all of them pass on the same commit.

## Publishing to npm (maintainers)

The package can also be published to npm (so the command drops the `github:` prefix).
Publishing is automated by GitHub Actions (`.github/workflows/publish.yml`): push a
`v*` tag (matching `package.json` version) and it runs the **full Verify gate** — the
installer matrix, the real-PostgreSQL .NET **and** TypeScript harnesses, the control
catalog + schema self-tests, the eval self-tests and the negative-gate proof — and only
then packs once and publishes **that same tarball**.

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
