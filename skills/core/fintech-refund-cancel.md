---
name: "fintech-refund-cancel"
description: "Undo or return a payment correctly: pick the lifecycle-correct operation (cancel/void before capture, reversal/refund after), bound every refund by its source capture so the total never exceeds what was paid, serialize concurrent refunds, and never double-refund on an unknown provider outcome."
triggers: "refund, cancel, void, reversal, chargeback, return payment, partial refund, undo payment"
---

# Skill: Fintech Refund & Cancel

**Return money without ever returning more than was taken.** Load this when the task cancels,
voids, reverses or refunds a payment. Shared rules live in the control catalog; this skill
references them by FCS id. This is ONE narrow workflow, not a payments product.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand

- The outbound provider call + unknown-outcome handling → [`core/fintech-provider-webhook.md`](../core/fintech-provider-webhook.md).
- How the reversal posts to the ledger → [`core/fintech-ledger-reconciliation.md`](../core/fintech-ledger-reconciliation.md).
- The DB you store in → `databases/<db>.md`. The refund cap is enforced with a DB lock/constraint.
- The specific provider's cancel/void/refund API and terms → that provider's own docs.

## Controls (by FCS id)

| FCS id | In this skill |
|---|---|
| FCS-REFUND-001 | A refund is bounded by its source capture; running sum of refunds never exceeds the captured amount; partials accumulate; concurrent refunds serialized. |
| FCS-REFUNDTERM-001 | cancel/void (before capture) vs reversal/refund (after capture) are distinct, provider-specific, not synonyms. |
| FCS-OUTCOME-001 | An unknown refund outcome is not auto-success/failure and is never re-sent with a new key. |
| FCS-IDEMP-001 | A refund carries its own idempotency key scoped by (tenant, operation); a retry reuses the SAME key. |
| FCS-LEDGER-001 | The refund posts as a reversal/adjusting entry, never by editing the original payment row. |
| FCS-AUTHZ-001 | A refund only touches a payment inside its own (tenant, provider) scope. |

## Pick the right operation (lifecycle)

The operation depends on WHERE the payment is in its lifecycle — and the names differ per
provider, so confirm against the provider's docs, don't assume all four exist:

- **Before capture** (authorized/held, no money moved yet) → **cancel / void** the authorization.
- **After capture** (money taken) → **reversal / refund** returns money.

Never substitute one for another (e.g. "refund" a payment that was only authorized): the
money state is different. If the provider doesn't offer the operation you want, that is a real
constraint, not something to paper over.

## Refund rules (after capture)

1. Resolve the **source capture** (its id, captured amount, currency, tenant, provider).
2. Take a lock on that payment (or a DB constraint) so concurrent refunds **serialize**
   (FCS-REFUND-001). Two refunds must not each read "0 refunded so far" and both pass.
3. Compute `already_refunded + this_refund`; **reject** if it exceeds the captured amount.
   Partial refunds are allowed and accumulate against the one capture.
4. Call the provider with a stable refund **idempotency key** (FCS-IDEMP-001). A timeout
   leaves the outcome **unknown** — do not issue a second refund with a new key
   (FCS-OUTCOME-001); confirm via polling/webhook.
5. On confirmed success, post the **reversal** entry to the ledger (FCS-LEDGER-001).

## Output contract

- Sum of refunds against a capture is `<= captured amount`, always, even under concurrency.
- cancel/void and reversal/refund are chosen by lifecycle stage, not used as synonyms.
- An unknown refund outcome never causes a second money movement.
- Reference: `examples/ts-postgres-harness/refund.ts` (real PostgreSQL; provider is a labelled
  **test double**, not a real sandbox).
