# Skills Index

Load the skills relevant to your task. **Always load `refusal/refusal-policy.md`.**

## Core (always)

- [`core/secure-fintech-coding.md`](core/secure-fintech-coding.md) — baseline rules for all financial code
- [`refusal/refusal-policy.md`](refusal/refusal-policy.md) — the hard limits / when to say no

## Global frameworks

- [`global/pci-dss.md`](global/pci-dss.md) — payment card data
- [`global/iso27001-soc2.md`](global/iso27001-soc2.md) — security controls
- [`global/aml-kyc.md`](global/aml-kyc.md) — financial crime (AML/KYC/sanctions)

## Regional

- [`regional/eu-gdpr-psd2-dora.md`](regional/eu-gdpr-psd2-dora.md) — EU
- [`regional/us-sox-glba-ccpa.md`](regional/us-sox-glba-ccpa.md) — US
- [`regional/uk-fca-gdpr.md`](regional/uk-fca-gdpr.md) — UK
- [`regional/turkey-kvkk-bddk-masak.md`](regional/turkey-kvkk-bddk-masak.md) — Turkey

## Which to load

| Task touches… | Load |
|---------------|------|
| Card data | `pci-dss` |
| Onboarding / transfers | `aml-kyc` + region |
| EU users | `eu-gdpr-psd2-dora` |
| US users / reporting | `us-sox-glba-ccpa` |
| UK users | `uk-fca-gdpr` |
| Turkey users | `turkey-kvkk-bddk-masak` |
| Any audited system | `iso27001-soc2` |
