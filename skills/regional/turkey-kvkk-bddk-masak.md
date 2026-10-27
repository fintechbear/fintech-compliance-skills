# Skill: Turkey (KVKK · BDDK · TCMB · MASAK)

**Load for code serving users in Turkey or Turkish financial institutions.**

## When to use

Processing personal data of people in Turkey (KVKK), or building for an institution
whose ACTIVITY is regulated: banking (BDDK), payment services / e-money (TCMB), or
financial-crime obligations (MASAK). Decide by the institution's role first, then map
the authority — see "Who is actually obligated" below.

## Who is actually obligated (decide this FIRST)

Obligations attach to the institution's **role/activity**, not to "there is a Turkish
user." Map the activity to the authority, then apply that regime:

- **Banks → BDDK.** Banking Law No. 5411 (dated 19/10/2005). BDDK regulates and
  supervises banks and other credit institutions.
- **Payment institutions & e-money institutions → TCMB** (Türkiye Cumhuriyet Merkez
  Bankası / CBRT). Law No. 6493 on Payment and Securities Settlement Systems, Payment
  Services and Electronic Money Institutions (dated 20/6/2013). Since the November
  2019 amendment (amending Law No. 7192, passed 22 November 2019), regulatory and
  supervisory authority for payment/e-money institutions moved **from BDDK to TCMB**;
  today TCMB handles both licensing and supervision in this area. Do NOT lump
  payment/e-money under BDDK.
- **AML/CTF → MASAK.** Law No. 5549 (Prevention of Laundering Proceeds of Crime).
  Obliged entities (banks, payment/e-money institutions, and others listed in the law)
  must identify customers, monitor transactions, report suspicious activity, and
  retain records.
- **Personal data → KVKK.** Law No. 6698. Applies to processing personal data of
  people in Turkey, independent of which financial authority (if any) applies.

**A software vendor SELLING to these institutions is NOT automatically subject to the
institution's BDDK/TCMB/MASAK obligations.** Those duties fall on the regulated
institution (the obliged entity / licence holder). A vendor may still owe KVKK
obligations if it itself processes personal data, and may be bound by contractual /
outsourcing requirements the institution passes down — but it does not inherit a
banking or payment licence regime merely by having regulated customers. Confirm the
vendor's actual data-processing and processing-on-behalf role before assuming any
duty.

## Do

- **Classify the activity first**, then apply only the regime(s) that match (BDDK vs
  TCMB vs MASAK vs KVKK). Don't assume all four apply at once.
- **KVKK — personal data:** explicit consent or another lawful basis; data
  minimization; honor access/correction/erasure requests; keep processing records.
- **KVKK — localization vs cross-border transfer (keep these DISTINCT):**
  - *Cross-border transfer:* sending personal data abroad requires a lawful transfer
    basis under KVKK; don't move it abroad without one.
  - *Data localization:* a separate concept — a requirement to KEEP certain data
    inside Turkey. Sector rules (e.g. BDDK for banks, TCMB for payment/e-money) may
    impose localization on information systems / primary & secondary systems; verify
    the specific rule for the specific activity rather than assuming a blanket "all
    data stays in Turkey."
  - "A user is in Turkey" does NOT by itself trigger every obligation — it is one
    input to the KVKK analysis and says nothing about whether a BDDK/TCMB/MASAK regime
    applies.
- **BDDK (banks):** strong authentication, audit trails, segregation of environments,
  secure key management, and the information-systems controls BDDK requires for banks.
- **TCMB (payment/e-money):** apply Law No. 6493 and its secondary regulation
  (TCMB's implementing regulation and communiqués) for payment-service and e-money
  activity — including information-systems obligations for payment/e-money
  institutions.
- **MASAK — AML:** customer identification, suspicious-transaction reporting, record
  retention per Law No. 5549, for obliged entities.

## Never (red lines)

- **Never process personal data of people in Turkey without a KVKK lawful basis.**
- **Never ship personal data abroad** without the legally required transfer basis.
- **Never skip MASAK customer identification or suspicious-transaction reporting**
  where the institution is an obliged entity.
- **Never bypass BDDK-required authentication or audit controls** for bank services.
- **Never apply the wrong authority to an activity** — payment/e-money is TCMB (Law
  6493), banking is BDDK (Law 5411); do not supervise payment/e-money under BDDK.
- **Never assume a vendor inherits its customer's licence/regulatory obligations** —
  classify the vendor's own role before asserting any BDDK/TCMB/MASAK duty.

## Good example

```python
# 1) Classify the activity -> authority, THEN apply the regime.
def obligations_for(entity):
    regimes = []
    if entity.activity == "banking":
        regimes.append("BDDK")        # Law No. 5411
    if entity.activity in ("payment", "e_money"):
        regimes.append("TCMB")        # Law No. 6493 (not BDDK)
    if entity.is_obliged_entity:
        regimes.append("MASAK")       # Law No. 5549 (AML/CTF)
    if entity.processes_personal_data:
        regimes.append("KVKK")        # Law No. 6698
    return regimes

# KVKK consent + cross-border transfer kept distinct from localization
def store_personal(user, data, consent):
    assert consent.kvkk_basis in KVKK_BASES          # lawful basis for processing
    repo.save(region="tr", user_id=user.id, data=minimize(data),
              consent_ref=consent.id)                 # localization is a separate rule
```

## Bad example

```python
# ❌ lumps payment/e-money under BDDK (should be TCMB / Law 6493)
# ❌ assumes a Turkish user triggers every obligation
# ❌ conflates "keep in Turkey" with "may not transfer abroad"
# ❌ assumes the vendor inherits the bank's obligations
def handle(user):
    apply_bddk_rules(payment_institution)   # wrong authority for payment/e-money
    if user.country == "TR":
        apply_all(["BDDK", "TCMB", "MASAK", "KVKK"])  # not role-based
    ship_to_region("us", user)              # cross-border transfer with no basis
```
