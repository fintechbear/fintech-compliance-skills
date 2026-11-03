# Skills Index

Load the skills relevant to your task. **Always load `refusal/refusal-policy.md`.**

## Core (always)

- [`core/secure-fintech-coding.md`](core/secure-fintech-coding.md) — baseline rules for all financial code
- [`refusal/refusal-policy.md`](refusal/refusal-policy.md) — the hard limits / when to say no

## Core task skills (load the one matching the task)

- [`core/fintech-transfer.md`](core/fintech-transfer.md) — move money between accounts (authorize, idempotency, atomic debit+credit+audit)
- [`core/fintech-provider-webhook.md`](core/fintech-provider-webhook.md) — call a payment provider and consume its webhooks
- [`core/fintech-ledger-reconciliation.md`](core/fintech-ledger-reconciliation.md) — double-entry ledger and provider reconciliation
- [`core/fintech-refund-cancel.md`](core/fintech-refund-cancel.md) — cancel, void or refund a payment by lifecycle state
- [`core/fintech-retention-erasure.md`](core/fintech-retention-erasure.md) — retention, legal hold and erasure per data category
- [`core/fintech-pr-review.md`](core/fintech-pr-review.md) — review a financial code change against the controls

## Global frameworks

- [`global/pci-dss.md`](global/pci-dss.md) — payment card data
- [`global/iso27001-soc2.md`](global/iso27001-soc2.md) — security controls
- [`global/aml-kyc.md`](global/aml-kyc.md) — financial crime (AML/KYC/sanctions)

## Regional

- [`regional/eu-gdpr-psd2-dora.md`](regional/eu-gdpr-psd2-dora.md) — EU
- [`regional/us-sox-glba-ccpa.md`](regional/us-sox-glba-ccpa.md) — US
- [`regional/uk-fca-gdpr.md`](regional/uk-fca-gdpr.md) — UK
- [`regional/turkey-kvkk-bddk-masak.md`](regional/turkey-kvkk-bddk-masak.md) — Turkey

## Languages (load the one you code in)

Each file covers logging, workflow, hashing/encryption and country differences for that language.

- [`languages/java.md`](languages/java.md) — Java (core banking, Spring Boot)
- [`languages/kotlin.md`](languages/kotlin.md) — Kotlin (mobile banking backends + Android)
- [`languages/python.md`](languages/python.md) — Python (fintech, risk, data)
- [`languages/csharp-dotnet.md`](languages/csharp-dotnet.md) — C# / .NET (enterprise finance)
- [`languages/go.md`](languages/go.md) — Go (payment infrastructure, high throughput)
- [`languages/javascript-typescript.md`](languages/javascript-typescript.md) — JavaScript / TypeScript (web + Node services)
- [`languages/rust.md`](languages/rust.md) — Rust (high-assurance services)
- [`languages/scala.md`](languages/scala.md) — Scala (big data / risk)
- [`languages/cobol.md`](languages/cobol.md) — COBOL (z/OS mainframe bank core)
- [`languages/plsql.md`](languages/plsql.md) — PL/SQL (Oracle stored procedures)

## Databases (load the one you store in)

Each file covers storage-side controls: encryption at rest, column encryption, auditing, access control, masking and retention.

- [`databases/postgresql.md`](databases/postgresql.md) — PostgreSQL
- [`databases/oracle.md`](databases/oracle.md) — Oracle Database
- [`databases/sql-server.md`](databases/sql-server.md) — Microsoft SQL Server
- [`databases/mysql-mariadb.md`](databases/mysql-mariadb.md) — MySQL / MariaDB
- [`databases/mongodb.md`](databases/mongodb.md) — MongoDB
- [`databases/redis.md`](databases/redis.md) — Redis
- [`databases/db2.md`](databases/db2.md) — IBM Db2 (mainframe / LUW)

## Which to load

| Task touches… | Load |
|---------------|------|
| Card data | `pci-dss` |
| Onboarding / transfers | `aml-kyc` + region |
| Entity regulated in the EU, or EU personal data | `eu-gdpr-psd2-dora` |
| Entity regulated in the US, or US reporting | `us-sox-glba-ccpa` |
| Entity regulated in the UK, or UK personal data | `uk-fca-gdpr` |
| Entity regulated in Turkey, or Turkish personal data | `turkey-kvkk-bddk-masak` |

A user's country alone triggers only the personal-data analysis for that country. Licensing duties (banking, payment/e-money, AML reporting) follow the entity's declared role and activity — see the regional skill.
| Any audited system | `iso27001-soc2` |
| A specific language | the matching `languages/<lang>.md` |
| A specific database | the matching `databases/<db>.md` |
