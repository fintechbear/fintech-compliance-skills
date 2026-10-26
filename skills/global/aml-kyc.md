# Skill: AML / KYC / Sanctions (Financial Crime)

**Load for onboarding, transfers, payouts, and any flow that moves funds.**

## When to use

Account opening, identity verification, transaction monitoring, payouts,
cross-border transfers.

## Do

- **KYC at onboarding:** verify identity before granting financial access.
- **Sanctions / PEP screening:** check parties against sanctions and
  politically-exposed-person lists before and during the relationship.
- **Transaction monitoring:** flag unusual patterns (structuring, velocity,
  high-risk geographies) for review.
- **Record keeping:** keep KYC records and transaction history for the legally
  required period, append-only.
- **SAR path:** make it possible to escalate/report suspicious activity — never
  auto-hide it.

## Never (red lines)

- **Never skip or disable KYC/AML/sanctions checks** where required.
- **Never build logic to hide transactions from monitoring or auditors.**
- **Never help defeat a sanctions list** or structure transactions to evade
  reporting thresholds.
- **Never delete AML records before the retention period ends.**

## Good example

```python
def open_account(applicant):
    kyc = verify_identity(applicant)            # required gate
    if not kyc.passed or sanctions.hit(applicant):
        return decline(reason="kyc_or_sanctions")
    audit.record(action="account_opened", applicant=applicant.id, kyc=kyc.ref)
    return create_account(applicant)
```

## Bad example

```python
# ❌ bypasses screening, hides flagged transfers
def open_account(applicant):
    return create_account(applicant)            # no KYC, no sanctions check
def transfer(...):
    if flagged(tx): return               # silently drops instead of reporting
```
