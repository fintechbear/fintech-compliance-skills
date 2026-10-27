---
name: "fintech-ledger-reconciliation"
description: "Keep money in a balanced, append-only double-entry ledger and reconcile it against a provider: corrections are reversal entries, never edits; a discrepancy is a flag for review, not authorization to re-pay."
triggers: "ledger, double-entry, posting, reconciliation, reconcile, balance, statement, settlement"
---

# Skill: Fintech Ledger & Reconciliation

**Record money so it is auditable and reconcilable.** Load this when the task posts to a
ledger or reconciles against a provider. Shared rules are in the control catalog; this skill
references them by FCS id. Do NOT build a general recon-engine product here — this is a small,
correct reference.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand

- The DB you store in → `databases/<db>.md`.
- Jurisdiction retention/record-keeping → `regional/<region>.md` (what must be kept and for how long).

## Controls (by FCS id)

| FCS id | In this skill |
|---|---|
| FCS-LEDGER-001 | Balanced double-entry per currency; append-only; unique business reference; corrections by reversal, never by editing a posted row. |
| FCS-RECON-001 | Reconciliation classifies discrepancies (missing/duplicate/delayed/amount or currency mismatch); a discrepancy is a REVIEW flag, not permission to re-pay or auto-adjust. |
| FCS-AUDIT-001 | Postings and their audit entry commit or roll back together. |
| FCS-MONEY-001 | Minor units per ISO 4217; never sum different currencies into one figure. |

## Ledger rules

- Every business event posts **balanced** entries: within one currency, the sum of debits
  equals the sum of credits. Nothing posts unbalanced.
- Rows are **append-only**. A mistake is fixed by posting a **reversal** (and then the correct
  entry), so the original stays visible in history.
- Each posting carries a **unique business reference** (unique constraint) so the same event
  cannot post twice.
- Do not add balances across currencies. If `pending` / `available` / `posted` states are
  needed, define them explicitly; FX/accounting beyond this is out of scope unless stated.

## Reconciliation rules

Compare provider records with internal postings and classify each difference:

- **missing** — provider has it, ledger doesn't (or vice-versa);
- **duplicate** — same business event recorded twice on one side;
- **delayed** — present on both but outside the expected window;
- **amount/currency mismatch** — same event, different figure.

A discrepancy is **detective output for a human/operational review** (FCS-RECON-001). It does
NOT by itself authorize a re-payment, a new charge, or an automatic ledger adjustment.

## Output contract

- No posted row is edited; corrections are reversal entries.
- No currency mixing in a single total.
- Reconciliation emits a classified report; it never moves money on its own.
- Reference: `examples/ts-postgres-harness/ledger.ts` (real PostgreSQL).
