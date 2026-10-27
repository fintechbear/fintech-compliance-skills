---
name: turkey-kvkk-bddk-masak
description: Load for code serving users in Turkey or Turkish financial institutions.
triggers: turkey, kvkk, bddk, masak, regulation, jurisdiction, country
---

# Skill: Turkey (KVKK · BDDK · MASAK)

**Load for code serving users in Turkey or Turkish financial institutions.**

## When to use

Processing personal data of people in Turkey (KVKK), banking/payment systems under
BDDK oversight, or financial-crime obligations (MASAK).

## Do

- **KVKK — personal data:** explicit consent or another lawful basis; data
  minimization; honor access/correction/erasure requests; keep processing records.
- **KVKK — data localization awareness:** be deliberate about cross-border
  transfer of personal data; don't move it abroad without the required basis.
- **BDDK — banking rules:** strong authentication, audit trails, segregation of
  environments, secure key management for regulated financial services.
- **MASAK — AML:** customer identification, suspicious-transaction reporting,
  record retention per Law No. 5549.

## Never (red lines)

- **Never process personal data of people in Turkey without a KVKK lawful basis.**
- **Never ship personal data abroad** without the legally required transfer basis.
- **Never skip MASAK customer identification or suspicious-transaction reporting**
  where required.
- **Never bypass BDDK-required authentication or audit controls** for regulated services.

## Good example

```python
# KVKK consent + localization-aware storage
def store_personal(user, data, consent):
    assert consent.kvkk_basis in KVKK_BASES
    repo.save(region="tr", user_id=user.id, data=minimize(data),
              consent_ref=consent.id)             # kept in-region unless basis exists
```

## Bad example

```python
# ❌ no KVKK basis, exports data abroad silently, no MASAK id
save(user, request.form)
ship_to_region("us", user)        # cross-border transfer with no basis
```
