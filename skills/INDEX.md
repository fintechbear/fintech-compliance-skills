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
| EU users | `eu-gdpr-psd2-dora` |
| US users / reporting | `us-sox-glba-ccpa` |
| UK users | `uk-fca-gdpr` |
| Turkey users | `turkey-kvkk-bddk-masak` |
| Any audited system | `iso27001-soc2` |
| A specific language | the matching `languages/<lang>.md` |
| A specific database | the matching `databases/<db>.md` |
