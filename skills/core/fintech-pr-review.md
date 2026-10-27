---
name: "fintech-pr-review"
description: "Review a financial code change against the control catalog: report each finding with its FCS control id, file and line, what triggered it, the evidence, a confidence level, and the review's own limits. Review the changed risk surface, not just added lines; never emit an unverified finding as fact or an automatic compliance score."
triggers: "code review, PR review, financial PR, diff review, compliance review, review changes, secure code review"
---

# Skill: Fintech PR Review

**Review financial code changes with evidence, not a score.** Load this when the task reviews
a diff or PR touching payment/financial code. Shared rules live in the control catalog; this
skill references them by FCS id. This is a review **discipline**, not a scanner and not a
certifier.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand

- The control definitions you cite live in the repo's control catalog (`controls/catalog.json`).
- Language-specific pitfalls → `languages/<lang>.md`; DB-specific pitfalls → `databases/<db>.md`.

## Controls (by FCS id)

| FCS id | In this skill |
|---|---|
| FCS-PRREVIEW-001 | Per-finding: control id + file/line + trigger + evidence + confidence + review limits; review the changed risk surface; no unverified finding as fact; no automatic numeric score. |

The review *applies* the whole catalog — every finding cites the specific FCS id it is about.

## What to review

Review the **changed risk surface**, not only the added lines. A change is risky when it:

- touches money math, a ledger/audit path, auth/tenant checks, crypto, secrets, or logging;
- **removes or weakens** an existing control (a deleted check is a finding, and a deleted line
  is invisible if you only read additions);
- changes a call into a provider, a retry, or an idempotency key;
- changes a retention/erasure or refund-cap rule.

Read enough surrounding code to judge the change — a diff hunk alone can hide the control it
breaks.

## Per-finding format (FCS-PRREVIEW-001)

Each finding carries, at minimum:

- **control** — the FCS id it relates to (e.g. `FCS-REFUND-001`);
- **location** — `file:line` (or range);
- **trigger** — what matched / what you noticed;
- **evidence** — the actual snippet or the concrete reason, not a restated rule;
- **confidence** — high / medium / low (how sure you are it is a real issue);
- **limits** — what this review did NOT or could NOT check (no runtime, no DB, partial context).

## Hard rules

- **No unverified finding as fact.** If you are not sure, say `confidence: low` and state what
  would confirm it — do not assert a violation you did not verify.
- **No automatic compliance score.** Do not emit a number like "87% compliant"; it is false
  precision. Qualitative judgement is **NEEDS_REVIEW**, routed to a human, not a pass.
- **Not a scanner.** This skill does not certify the code as compliant; it surfaces
  evidence-bearing findings and marks its own uncertainty. Keep the repo's "not a scanner"
  framing consistent anywhere the review is described.

## Output contract

- Every finding has control id, location, trigger, evidence, confidence, and stated limits.
- The review covers removed/weakened controls, not just added lines.
- No finding is asserted beyond its evidence; no numeric compliance score is produced.
- Uncertain or qualitative items are returned as NEEDS_REVIEW for a human.
