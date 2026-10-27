# AGENTS.md — Fintech Compliance Rules

You write code for regulated financial systems. Before writing or changing any
code that touches money, payments, accounts, balances, or personal/financial
data, load and obey the relevant rule files below. **Always** obey
`skills/core/secure-fintech-coding.md` and `skills/refusal/refusal-policy.md`.
If a request would break a red line, refuse and explain which rule — do not
write the non-compliant code.

## Always load

- `skills/core/secure-fintech-coding.md` — baseline for all financial code
- `skills/refusal/refusal-policy.md` — hard limits / when to say no

## Global — Load for the framework in scope

- `skills/global/aml-kyc.md` — Load for onboarding, transfers, payouts, and any flow that moves funds.
- `skills/global/iso27001-soc2.md` — Load for code that must meet an information-security control framework.
- `skills/global/pci-dss.md` — Load whenever code touches payment card data.

## Regional — Load for the user's jurisdiction

- `skills/regional/eu-gdpr-psd2-dora.md` — Load for code serving users in the European Union / EEA.
- `skills/regional/turkey-kvkk-bddk-masak.md` — Load for code serving users in Turkey or Turkish financial institutions.
- `skills/regional/uk-fca-gdpr.md` — Load for code serving UK users or FCA-regulated activities.
- `skills/regional/us-sox-glba-ccpa.md` — Load for code serving US users or US-listed/regulated entities.

## Languages — Load the one you are coding in

- `skills/languages/cobol.md` — Write regulation-compliant COBOL for bank-core and payment systems on z/OS, where security, logging, and crypto are delegated to the platform (RACF, SMF, ICSF/CPACF, DFSMS data set encryption, Db2) rather than coded in the program — with audited, recoverable money movement under CICS/RRS and batch.
- `skills/languages/csharp-dotnet.md` — Write regulation-compliant financial code on .NET (ASP.NET Core, EF Core) using the right first-party crypto, Identity, logging, and persistence primitives.
- `skills/languages/go.md` — Write Go for payment infrastructure that is secure, auditable, and high-throughput by default.
- `skills/languages/java.md` — Write regulation-compliant Java for core banking and payment systems built on Spring Boot / Spring Security, with correct hashing, envelope encryption, PII-safe logging, and audited, concurrency-safe money movement.
- `skills/languages/javascript-typescript.md` — Purpose.
- `skills/languages/kotlin.md` — Write regulation-compliant Kotlin for mobile-banking backends (Spring Boot / Ktor) and Android clients, with correct password hashing, envelope encryption, PII-safe logging, coroutine-safe money movement, and hardware-backed on-device key storage.
- `skills/languages/plsql.md` — Write regulation-compliant Oracle PL/SQL for core banking and payment systems: injection-proof dynamic SQL, correct in-database encryption with `DBMS_CRYPTO` + TDE, PII-safe masked logging, autonomous-transaction audit trails, and fine-grained auditing.
- `skills/languages/python.md` — Purpose.
- `skills/languages/rust.md` — Write Rust for high-assurance financial services that are memory-safe, auditable, and correct-by-construction.
- `skills/languages/scala.md` — Write regulation-compliant Scala for big-data/risk, payment, and core-banking systems built on the Typelevel (cats-effect) or ZIO stack with Akka/Pekko and Spark, with correct hashing, envelope encryption, PII-safe logging, and audited, concurrency-safe, resource-safe money movement.

## Databases — Load the one you store in

- `skills/databases/db2.md` — Configure storage-side controls for an IBM Db2 core-banking schema on both platforms it ships on: Db2 for z/OS (mainframe bank core) and Db2 LUW (Linux/UNIX/Windows). Covers at-rest encryption (Db2 native encryption on LUW, z/OS data set encryption / pervasive encryption on the mainframe), two-tier DEK/MK key management with a centralized KMIP/PKCS#11 keystore or ICSF/UKO, the Db2 audit facility (`db2audit` + `AUDIT` on LUW, audit policies in `SYSIBM.SYSAUDITPOLICIES` on z/OS), RACF as the external security manager via the `DSNX@XAC` access-control exit, Row and Column Access Control (RCAC: `CREATE PERMISSION` / `CREATE MASK`), and Label-Based Access Control (LBAC).
- `skills/databases/mongodb.md` — Purpose.
- `skills/databases/mysql-mariadb.md` — Purpose.
- `skills/databases/oracle.md` — Configure storage-side controls for an Oracle Database core-banking schema: TDE at-rest encryption with an externally managed keystore, on-demand `DBMS_CRYPTO` column encryption for the few fields that need application-layer control, Virtual Private Database / Database Vault access control, Unified + Fine-Grained Auditing on money and data access, and Data Redaction for display masking.
- `skills/databases/postgresql.md` — Storage-side security controls for PostgreSQL holding regulated financial data (PAN, IBAN, balances, PII).
- `skills/databases/redis.md` — Use Redis as a cache / session / rate-limit / queue store that never becomes an unencrypted copy of your regulated data.
- `skills/databases/sql-server.md` — Configure storage-side controls on SQL Server — TDE, Always Encrypted (+ secure enclaves), column-level encryption, Dynamic Data Masking, Row-Level Security, SQL Server Audit, Extensible Key Management, and Ledger tables — so cardholder data, PII, and the audit trail are protected at rest and tamper-evident.

> These rule files live in this repo under `skills/`. Open the one that
> matches your task and follow its Do / Never / examples before coding.
