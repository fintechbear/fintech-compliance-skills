# Repository protection — DRAFT (not applied)

AUD-20261102-F16. This is a **draft**. It was **not** applied: this work had no authority to change
remote repository settings. Nothing below is active until a maintainer applies it.

## Observed state (2026-11-02, GitHub API)

| Setting | Observed |
|---|---|
| `main` branch protection | `protected: false` |
| Repository rulesets | `[]` (none) |
| Release tags | none on `origin` |
| Private vulnerability reporting | `enabled: false` |
| `SECURITY.md`, `.github/dependabot.yml` | added on the closure branch (not on `main` yet) |

## Proposed rulesets (single-maintainer friendly — no mandatory reviewer)

Apply in **Settings → Rules → Rulesets**, or with `gh api` as below.

### 1. `main`

- Block force pushes and deletion.
- Require a pull request before merging, with **0** required approvals (does not lock out a
  single maintainer).
- Require the status check **`release-readiness`** (Verify workflow) to pass.

```json
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [ { "context": "release-readiness" } ] } }
  ]
}
```

### 2. Release tags `v*`

- Block deletion and moves (no re-pointing a published version).

```json
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" } ]
}
```

Apply (maintainer, with admin rights):

```bash
gh api -X POST repos/fintechbear/fintech-compliance-skills/rulesets --input main-protection.json
gh api -X POST repos/fintechbear/fintech-compliance-skills/rulesets --input release-tags.json
```

Also enable **Settings → Code security → Private vulnerability reporting**, then update
`SECURITY.md`.

## npm publication authority (separate, UNVERIFIED)

Not observable from this repository. Before the first publish a maintainer must confirm:

- the `fintech-compliance-skills` package name is available or owned by the maintainer account
  (a public `npm view` returned E404 during the audit);
- the first publish/bootstrap path (npm Trusted Publishing requires the package to exist, or a
  one-time token publish);
- a Trusted Publisher for this repo + `publish.yml`, or an `NPM_TOKEN` secret.

`npm pack` success and green CI do **not** prove publish rights.
