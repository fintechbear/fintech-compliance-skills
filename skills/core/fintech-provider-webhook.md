---
name: "fintech-provider-webhook"
description: "Call a payment provider safely and consume its webhooks: durable intent before the call, outbound idempotency, raw-body signature verification, a durable deduplicated inbox, and an explicit unknown-outcome state machine that is never blindly retried."
triggers: "webhook, payment provider, stripe, callback, outbound payment, provider outcome, idempotency key"
---

# Skill: Fintech Provider & Webhook

**Make provider interactions safe against lost responses, retries and replays.** Load this
when the task calls a payment provider or consumes a provider webhook. Shared rules are in
the control catalog; this skill references them by FCS id.

## Always load first

- [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) — the red lines.
- [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md) — baseline.

## Read on demand

- Provider-specific API detail belongs to the provider's own docs/skill, kept separate from
  the control flow here. For Stripe, see its official skill/docs ([Stripe skills](https://docs.stripe.com/skills),
  [webhooks](https://docs.stripe.com/webhooks), [error/unknown outcome](https://docs.stripe.com/error-low-level)) —
  check the version before copying anything; do not vendor provider content without a licence/version check.
- The DB you store in → `databases/<db>.md`. Durable inbox/outbox dedup is a DB unique
  constraint; isolation/retry behaviour is DB-specific.

## Controls (by FCS id)

| FCS id | In this skill |
|---|---|
| FCS-OUTBOX-001 | Durable intent/outbox row (local tx) BEFORE the provider call; one DB tx can't undo a provider side effect. |
| FCS-WEBHOOK-001 | Verify signature on the RAW body; enforce the provider's replay window; durable deduplicated inbox; ack only after durable acceptance. |
| FCS-OUTCOME-001 | Explicit outcome states; unknown ≠ failure; never blind-retry with a new key. |
| FCS-IDEMP-001 | Outbound idempotency key scoped by (tenant, operation); a retry reuses the SAME key. |
| FCS-AUTHZ-001 | An unknown/unauthorized tenant or provider reference is never bound to another customer's operation. |

## Outbound call (step order)

1. In a local transaction, write a durable **intent/outbox** row: business id, (tenant,
   provider) scope, a stable **outbound idempotency key**, state `not_started` (FCS-OUTBOX-001).
2. Call the provider with that idempotency key. A timeout/5xx leaves the outcome **unknown** —
   do NOT invent a new key and call again (FCS-OUTCOME-001).
3. Record the result as `confirmed_success` / `confirmed_failure`, or leave `pending/unknown`
   for later confirmation (polling or webhook). Terminal states don't flip on later ambiguous
   evidence without an explicit documented rule.

## Inbound webhook (step order)

1. Verify the signature over the **raw bytes** of the request, before any parse (FCS-WEBHOOK-001).
2. Check the provider's timestamp/replay window (provider-defined — don't invent a universal one).
3. Insert a durable **inbox** row keyed by the provider event id; the DB unique constraint is
   the dedup. A duplicate delivery is a no-op that still returns success.
4. Acknowledge (2xx) once the event is **durably accepted**; heavy processing may continue
   asynchronously after that — an accepted event must not be lost.
5. Bind the event to its business object only within the authorized (tenant, provider) scope.

## Scenarios the reference exercises

Same event re-delivered; different event ids for one business event; out-of-order events;
worker crash + restart; retry racing the webhook; key rotation; a tampered/invalid signature;
unknown-outcome left pending (not auto-failed, not blind-retried).

## Output contract

- An unknown outcome is surfaced, never silently converted to success or failure.
- No new money movement is created to "resolve" a timeout.
- Reference: `examples/ts-postgres-harness/webhook.ts` (real PostgreSQL; a provider
  **test double** stands in for the network — labelled as a double, NOT a real sandbox).
