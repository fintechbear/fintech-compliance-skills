# Fintech Compliance Skills

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
- **Not a scanner or linter.** It does not read your existing codebase and flag
  issues. It guides code as it is written.
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

Flags: `--tool claude|kiro|kiro-crew|codex`, `--scope`, `--target <dir>`, `--home <dir>` (testing), `--force`, `--help`.

After installing: **Claude Code** — restart or `/reload`; **Kiro** — loads on the
next session; **Codex** — reads `AGENTS.md` automatically at session start.

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
3. The skill tells it what to **do** (tokenise via the processor, never store the
   PAN) and what it must **never do** (raw PAN at rest, CVV stored at all).
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
| `skills/core/` | Baseline rules for all financial code (money as integers, idempotency, audit trail, least privilege) |
| `skills/refusal/` | The hard limits — when and how the agent must say no |
| `skills/global/` | International frameworks: PCI-DSS (card data), ISO 27001 / SOC 2 (controls), AML / KYC / sanctions |
| `skills/regional/` | Jurisdiction rules: EU (GDPR, PSD2, DORA), US (SOX, GLBA, CCPA), Turkey (KVKK, BDDK, MASAK), UK (FCA, UK GDPR) |
| `skills/languages/` | Per-language: Java, Kotlin, Python, C#/.NET, Go, JS/TS, Rust, Scala, COBOL, PL/SQL |
| `skills/databases/` | Per-database: PostgreSQL, Oracle, SQL Server, MySQL/MariaDB, MongoDB, Redis, Db2 |
| `examples/` | Good vs. bad code examples |

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

- store a raw card number (PAN) in plaintext, or store a CVV at all;
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
shape above, cite the regulation or standard by name, and **never weaken a red
line**. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Publishing to npm (maintainers)

The package can also be published to npm (so the command drops the `github:`
prefix). Publishing is automated by GitHub Actions (`.github/workflows/publish.yml`):
push a `v*` tag and it publishes. Pick one auth method once — OIDC trusted publishing
(no stored secrets) or an `NPM_TOKEN` repo secret. Until then, the
`npx github:…` command above works for everyone, today.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
