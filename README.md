# Fintech Compliance Skills

A set of **agent skills** that make AI coding assistants write financial software
that respects international and local regulations — and **refuse** to write code
that would break them.

Each skill is a plain Markdown file. An AI agent reads it before writing code and
follows its rules. When a request would violate a hard rule, the agent is
instructed to **stop and refuse**, not to produce the unsafe code.

> ⚠️ These skills are engineering guardrails, not legal advice. They encode
> widely accepted security and compliance practices. Always confirm obligations
> with a qualified compliance/legal professional for your jurisdiction.

## Quick install (one command)

New to this? You don't need to copy files by hand. Run one command and pick your tool:

```bash
npx fintech-compliance-skills
```

It asks which agent you use and installs the skills in the right place and format:

| Tool | Where it installs | Format |
|------|-------------------|--------|
| **Claude Code** | `<project>/.claude/skills/<name>/SKILL.md` | one folder per skill, with frontmatter |
| **Kiro** | `~/.kiro/crew/skills/<name>/SKILL.md` | one folder per skill, with frontmatter |
| **Codex CLI** | `<project>/AGENTS.md` | single instruction file that points at the rules |

Non-interactive (CI or scripts):

```bash
# Claude Code, into the current project
npx fintech-compliance-skills --tool claude --target .

# Kiro (always installs to ~/.kiro/crew/skills)
npx fintech-compliance-skills --tool kiro

# Codex CLI, into the current project
npx fintech-compliance-skills --tool codex --target .
```

After installing: Claude Code — restart or `/reload`; Kiro — loads on the next session; Codex — reads `AGENTS.md` automatically at session start.

## How it works

1. The agent loads the relevant skill(s) for the task (e.g. storing card data → PCI-DSS).
2. The skill tells it what to **do** and what it must **never do** (red lines).
3. If the request crosses a red line, the agent refuses and explains why.

## Structure

| Folder | What's inside |
|--------|---------------|
| `skills/core/` | Rules that apply to all financial code |
| `skills/global/` | International frameworks (PCI-DSS, ISO 27001, SOC 2) |
| `skills/regional/` | Jurisdiction-specific rules (EU, US, Turkey, UK) |
| `skills/languages/` | Per-language rules (Java, Kotlin, Python, C#, Go, JS/TS, Rust, Scala, COBOL, PL/SQL) |
| `skills/databases/` | Per-database rules (PostgreSQL, Oracle, SQL Server, MySQL/MariaDB, MongoDB, Redis, Db2) |
| `skills/refusal/` | When and how the agent must say no |
| `examples/` | Good vs. bad code examples |

## Skill file format

Every skill follows the same shape:

1. **When to use** — the trigger
2. **Do** — required practices
3. **Never (red lines)** — hard stops that trigger a refusal
4. **Good example**
5. **Bad example**

## Using these with an agent

Point your agent's skill loader at the `skills/` directory, or paste the relevant
skill into the system/context before a task. The `refusal/` skill should always be
loaded so the agent knows its hard limits.

## Contributing

New jurisdictions and frameworks are welcome. Keep the file format above, cite the
regulation by name, and never weaken a red line. See `CONTRIBUTING.md`.

## License

Apache License 2.0 — see `LICENSE`.
