# Security policy

## Reporting a vulnerability

Please do **not** put vulnerability details in a public issue, pull request or discussion.

**Current state (observed 2026-11-02):** GitHub private vulnerability reporting is **not enabled**
for this repository, and no private security mailbox is published here. Until a maintainer enables
private reporting:

1. Open a public issue titled **"Security contact request"** with no technical details.
2. A maintainer will reply with a private channel. Send the details only there.

When private vulnerability reporting is enabled, use **Security → Report a vulnerability** on the
repository page instead, and this section will be updated.

## What is in scope

- The installer and doctor (`installer/`), the control catalog and validators (`controls/`), the
  eval grader (`evals/`), and the guidance in `skills/`.
- Reference harnesses under `examples/` are narrow test references, not production SDKs.

## What this project does not promise

The skills are guidance for coding agents. They are not legal advice, not a compliance
certification, and not a substitute for review by a qualified person.

## Supported versions

Only the latest published version receives fixes.

## Dependency maintenance

`.github/dependabot.yml` opens weekly update PRs for the root package, the TypeScript harness, the
.NET harness and GitHub Actions. Every update must pass the `release-readiness` Verify check before
merge. Do not run `npm audit fix --force`; pick the smallest compatible fixed version.
