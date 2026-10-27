---
name: "secure-fintech-coding"
description: "Baseline rules for all financial code."
triggers: "secure, fintech, coding, fintech, payment, money"
---

# Skill: Secure Fintech Coding (Core)

**Baseline rules for all financial code.** Load this on every fintech task,
alongside the refusal policy.

## When to use

Any code that touches money, payments, accounts, balances, or personal/financial data.

## Do

- **Money as integers.** Store amounts in minor units (cents) or use a decimal
  type. Never use binary floats (`float`/`double`) for money.
- **Idempotency.** Every money-moving endpoint takes an idempotency key so a retry
  can't double-charge.
- **Audit trail.** Record who did what, when, and the before/after on every balance
  change. Make the log append-only.
- **Validate all input** at the boundary; reject, don't coerce, bad financial input.
- **Least privilege.** Each service/user gets only the access it needs.
- **Encrypt in transit (TLS 1.2+) and at rest** for sensitive data.
- **Secrets from a vault / env, never from source.**
- **Explicit currency** on every amount — never assume one.

## Never (red lines)

See `skills/refusal/refusal-policy.md`. In particular for core work:

- Never use floating point for monetary values.
- Never move money without an audit record.
- Never make a charge endpoint non-idempotent.

## Good example

```python
from decimal import Decimal

def transfer(from_acct, to_acct, amount: Decimal, currency: str, idem_key: str):
    assert amount > 0 and currency in SUPPORTED
    with db.transaction():
        if ledger.already_applied(idem_key):
            return ledger.result(idem_key)       # idempotent retry
        from_acct.debit(amount, currency)
        to_acct.credit(amount, currency)
        audit.record(actor=current_user, action="transfer",
                     amount=amount, currency=currency,
                     frm=from_acct.id, to=to_acct.id, key=idem_key)
```

## Bad example

```python
# ❌ float money, no idempotency, no audit
def transfer(a, b, amount):
    a.balance -= float(amount)   # float rounding errors
    b.balance += float(amount)   # double-charge on retry; no audit trail
```


<!-- fcs-managed-hash:1306bfdbb325ac56 -->
