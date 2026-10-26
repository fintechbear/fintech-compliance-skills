# Skill: EU (GDPR · PSD2 · DORA)

**Load for code serving users in the European Union / EEA.**

## When to use

Processing personal data of EU residents, EU payment services, or operational
resilience for EU financial entities.

## Do

- **GDPR — lawful basis & minimization:** collect only needed data, record the
  lawful basis, honor access/erasure/portability requests.
- **GDPR — consent:** explicit, revocable; store proof of consent.
- **PSD2 — Strong Customer Authentication (SCA):** two independent factors for
  electronic payments and account access.
- **PSD2 — open banking:** use licensed APIs; never scrape or store a user's bank
  credentials.
- **DORA — resilience:** log and monitor ICT incidents; have a tested recovery path.

## Never (red lines)

- **Never collect or keep personal data without a lawful basis** or past its retention.
- **Never ignore an erasure/access request path** (build it in).
- **Never bypass SCA** for a payment that legally requires it.
- **Never store third-party bank login credentials** to screen-scrape accounts.

## Good example

```python
# Consent + minimization + erasure support
def store_profile(user, fields, consent):
    assert consent.lawful_basis in LAWFUL_BASES
    data = {k: fields[k] for k in NEEDED_FIELDS}   # minimize
    repo.save(user.id, data, consent_ref=consent.id)

def erase(user_id):
    # GDPR right to erasure is NOT absolute. Before deleting anything, evaluate
    # per data category whether erasure actually applies (GDPR Art. 17(1)) or is
    # overridden by an exemption (Art. 17(3)) — e.g. a legal retention duty.
    for cat in data_categories(user_id):
        if legal_hold_active(user_id, cat):
            # Litigation / regulatory hold freezes deletion for that category.
            continue
        obligation = retention_obligation(cat)      # e.g. AML/KYC & transaction
                                                     # records: ~5–10y (EU AMLD,
                                                     # MASAK/BDDK, US BSA)
        if obligation and not obligation.expired(user_id):
            # MUST retain: financial / AML record-keeping overrides erasure.
            # Keep it in the retained, access-restricted store — do NOT delete.
            continue
        if not erasure_applies(cat, user_id):        # Art. 17(1) grounds absent?
            continue                                 # no right to erase this cat
        # Deletable now: profile / marketing / behavioural PII whose purpose ended.
        repo.hard_delete(user_id, category=cat)
        audit.record("erasure", user=user_id, category=cat)

    # Caveats to document, not assume away:
    #  - Audit, encrypted backups, replicas and prior data exports may lag or
    #    retain copies; erasure is a process across all of them, not one DELETE.
    #  - Backups: erase on restore or let them age out under a documented cycle.
    #  - Crypto-shredding (destroying the per-record key) is operationally useful
    #    but is NOT in all cases legally sufficient erasure — assess per regime.
```

The right to erasure ("right to be forgotten") applies only *when the data is no
longer needed or processing is unlawful* and is subject to the Art. 17(3)
exemptions (notably compliance with a legal obligation). Separate **deletable**
profile/marketing data from **financial records that MUST be retained** for
AML/record-keeping, and keep the retained set access-restricted and audited.
Verify against the European Commission's guidance:
[Information for individuals — your rights (right to erasure)](https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en).

## Bad example

```python
# ❌ grabs everything, no consent, no erasure, scrapes bank login
store(user, request.form)            # collects all fields, no basis
save(bank_username, bank_password)   # credential scraping — forbidden
```
