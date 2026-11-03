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
    if not kyc.passed:
        return decline(reason="kyc_failed")
    s = sanctions.screen(applicant)             # returns a match STATE, not a boolean
    audit.record(action="screened", applicant=applicant.id, result=s.state, case=s.case_id)
    if s.state == "confirmed_sanctions_match":
        return block(reason="sanctions", case=s.case_id)        # legal basis: applicable sanctions law
    if s.state == "candidate_match":
        return pending_review(case=s.case_id)                   # not a decline: an analyst decides
    if s.state == "pep":
        require_enhanced_due_diligence(applicant, case=s.case_id)  # risk-based, not an auto-decline
    # "clear" or a recorded false-positive decision continues
    audit.record(action="account_opened", applicant=applicant.id, kyc=kyc.ref, screening=s.case_id)
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

## Match handling and scope

A candidate name match, a false positive, PEP classification and a confirmed sanctions match are distinct decisions. Record the screening/case decision and apply the applicable jurisdiction and institution policy. PEP status triggers risk-based due diligence, not a universal automatic freeze or rejection. Holds/freezes require the applicable sanctions/legal basis or an explicitly declared institution policy. Required screening must never be bypassed.
