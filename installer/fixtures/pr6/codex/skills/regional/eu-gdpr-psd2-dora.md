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

def erase(user_id):                                 # GDPR right to erasure
    repo.hard_delete(user_id); audit.record("erasure", user=user_id)
```

## Bad example

```python
# ❌ grabs everything, no consent, no erasure, scrapes bank login
store(user, request.form)            # collects all fields, no basis
save(bank_username, bank_password)   # credential scraping — forbidden
```
