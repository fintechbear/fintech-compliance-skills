# Work contract — fintech-compliance-skills evolution (P00–P08)

This is the shared contract every phase (P00–P08) follows. It is derived from the
orchestrator brief. It contains **no** private server details (SSH host, key path,
Tailscale IP); the test server is referred to by the alias **`debian-test`**.

## Scope

- IN: development, in-scope tests, commits/pushes to a **feature branch**, a **draft** PR.
- OUT (do NOT do): direct push to `main`, merge, marking the PR ready-for-review,
  release/tag push, `npm publish`, production deployment, real money movement.

## Branch / base

- PR #7 (`installer-content-hardening`) is **not merged** (origin/main is still the PR#6
  merge). Per the contract, this work runs on a **separate feature branch**
  `fintech-skills-evolution`, based off PR #7's head, and does **not** modify the PR #7
  branch. The new draft PR targets the PR #7 branch (its dependency base) until PR #7
  merges; if PR #7 merges first, rebase onto `origin/main`.
- Frozen comparison reference (NOT a freshness claim):
  `6fc6e9be03f85cd743b99bc7ca1c7a3ca9d2b601`.

## Working tree

- Preserve all user changes. Never `reset`/`clean`/`stash` the user's files.
- If the working tree is dirty, use a separate worktree. No concurrent writers on one tree.

## Evidence & honesty rules

- Verify source and dependency versions for real. Never write exit 0 for an unrun command.
- Reports classify every check as **PASS / FAIL / NOT_RUN / BLOCKED / NEEDS_REVIEW**.
- A link to a source is NOT proof a claim is verified. Separate law / standard / project
  policy / engineering recommendation. No silent ruling on source conflicts.
- Real agent evaluation is only as strong as a real runtime run. Mock responses are never
  counted as agent evidence; absence of a runtime is BLOCKED, with one concrete blocker.
- Installer contract unchanged: a normal reinstall preserves user edits and unknown files;
  `--force` scope is not widened.

## Tooling

- New tools use Node.js/TypeScript, .NET, and shell only. No new Python toolchain, no new
  frontend/SaaS/MCP product.
- Tests must not touch production/real customer data or a live payment account.
- Skill installs in tests use an isolated HOME/USERPROFILE and isolated targets; never the
  real user's agent config.

## Environments

- Repository content is English; the user-facing summary is Turkish.
- `debian-test`: Docker-based isolated Node + PostgreSQL (the host had no system Node).
  Use task-scoped container/network/volume names and loopback-only DB ports. Do not
  system-install Node/.NET, do not `sudo`-change settings, do not remove existing
  containers/volumes. Clean up only this task's own resources.
- Windows host: agent CLIs (`claude`, `codex`, `kiro`), Node, .NET, Docker are present.
  Real-agent experiments, if run, run on Windows; DB tests of generated code run on
  `debian-test`. Evidence is always labelled with which machine produced it.
- SSH host verification is never disabled; private keys are never printed or committed.

## Continuity records (repository)

- `docs/development/WORK_CONTRACT.md` (this file), `PLAN.md`, `STATE.json`,
  `NEXT_SESSION.md`. Raw/secret outputs stay in the isolated workspace; the repo holds
  only cleaned summaries and an evidence manifest. `STATE.json.validated_commit` is the
  last commit actually tested (a commit cannot contain its own hash).
