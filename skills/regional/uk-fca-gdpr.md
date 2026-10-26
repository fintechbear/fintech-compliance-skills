# Skill: UK (FCA · UK GDPR)

**Load for code serving UK users or FCA-regulated activities.**

## When to use

UK payment/financial services under FCA rules, or personal data of UK residents
(UK GDPR / Data Protection Act 2018).

## Do

- **FCA — Consumer Duty:** design flows that deliver good outcomes; clear,
  non-deceptive disclosures; no dark patterns.
- **FCA — SCA / safeguarding:** strong customer authentication; where you hold
  client money, keep it segregated and reconciled.
- **UK GDPR:** lawful basis, minimization, honor access/erasure rights, breach
  notification.
- **Operational resilience:** monitoring, incident logging, tested recovery.

## Never (red lines)

- **Never use dark patterns** to push a financial decision (hidden fees,
  manipulated defaults, hard-to-cancel).
- **Never commingle client money** with company funds where segregation is required.
- **Never process UK personal data without a lawful basis** or ignore erasure rights.
- **Never bypass SCA** on a payment that requires it.

## Good example

```python
# Clear disclosure + SCA + segregated client money
def start_payment(amount, currency, user):
    show_fees_clearly(amount)                    # Consumer Duty: no hidden fees
    require_sca(user)                            # strong auth
    client_money.hold(amount, currency, segregated=True)
```

## Bad example

```python
# ❌ hidden fee, no SCA, client money mixed with ours
def start_payment(amount, user):
    charge(amount + SECRET_FEE)                  # dark pattern
    company_account.credit(amount)               # commingled client funds
```
