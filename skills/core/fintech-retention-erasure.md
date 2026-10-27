---
name: "fintech-retention-erasure"
description: "Decide data retention and erasure per data category by its legal basis: keep mandatory financial records, never delete data under legal hold, erase profile data with no obligation; check over-retention and over-deletion separately, and never claim crypto-shredding is a universal legal erasure."
triggers: "retention, erasure, right to be forgotten, data deletion, legal hold, record keeping, GDPR, KVKK, anonymization, crypto-shredding"
---

# Skill: Fintech Retention & Erasure

**Keep what the law requires kept; erase what the law lets you erase — per category, not in
one blanket rule.** Load this for a data retention schedule, a deletion/erasure feature, or a
"right to be forgotten" request. Shared rules live in the control catalog; this skill
references them by FCS id. One narrow workflow, not a data-governance platform.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand

- Your jurisdiction's actual retention minimums and erasure rights → `regional/<region>.md`.
  The durations in the reference are DEMO data, NOT cited regulation.
- The DB you store in → `databases/<db>.md`. Retention class and legal-hold flag live with the data.

## Controls (by FCS id)

| FCS id | In this skill |
|---|---|
| FCS-RETAIN-001 | Retention is per data category by legal basis: mandatory financial retention vs active legal hold vs erasable profile data. No single blanket rule. |
| FCS-ERASE-001 | Over-retention AND over-deletion are both failures, checked separately; crypto-shredding is a technique, not a universal legal erasure guarantee. |
| FCS-AUTHZ-001 | An erasure request only ever reaches the requester's own (tenant, subject) data. |
| FCS-AUDIT-001 | A deletion/erasure action is itself audited (who, what category, basis, when). |

## Decide per data category

For each category of data, classify its **legal basis** first, then act:

1. **Mandatory financial/transaction records** — must be kept for a required minimum
   (e.g. AML / tax / accounting record-keeping). An erasure request does NOT delete these
   until their retention expires. Minimise/segregate instead of delete.
2. **Under active legal hold** — must NOT be deleted while the hold is active, even if it
   would otherwise be erasable. The hold wins.
3. **Erasable profile/marketing data** — no retention obligation → erase on a valid request.

A single rule applied to everything ("delete all user data after N days", or "keep everything
forever") is wrong: it either over-deletes category 1/2 or over-retains category 3.

## Two failures, checked separately (FCS-ERASE-001)

- **Over-retention** — erasable data kept past its basis. A retention sweep must actually
  remove it.
- **Over-deletion** — data still under a retention obligation or legal hold got deleted. This
  is a compliance failure, not a feature.

Test both directions; passing one does not imply the other.

## Crypto-shredding caveat

Destroying the encryption key ("crypto-shredding") renders ciphertext unreadable and is a
legitimate engineering technique — but it is **not** a universal guarantee that a regulator
accepts the data as "erased" (backups, key escrow, and definitions vary). Do not present
crypto-shredding as satisfying an erasure duty by itself; state it as a technique whose legal
sufficiency is jurisdiction-specific.

## Output contract

- Retention/erasure decisions are made per category by legal basis, never one blanket rule.
- A legal hold blocks deletion; a mandatory-retention record is not erased early.
- Over-retention and over-deletion are both reported.
- Crypto-shredding is never claimed as a universal legal erasure.
- Reference: `examples/ts-postgres-harness/retention.ts` (real PostgreSQL; durations are
  labelled DEMO values, not cited regulation).
