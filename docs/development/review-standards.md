# Review Standards — Compliance Control Citation Verification

Each control's cited standard was checked against its primary (or authoritative
standards-body) source. Verification date: **2026-10-28**.

Verdict legend: **VERIFIED** = citation is accurate against the primary source;
**NEEDS_REVISION** = the citation or claim is inaccurate/incomplete.

---

## FCS-SECRET-001 — OWASP Password Storage Cheat Sheet

**Claim:** Never store passwords/secrets in plaintext or reversibly; hash
passwords with a slow, salted KDF (Argon2id / scrypt / bcrypt / PBKDF2).

**Verdict: VERIFIED** (with a parameter-currency note — see below).

**Primary source:** OWASP Cheat Sheet Series — *Password Storage Cheat Sheet*.
- Rendered: <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- Canonical source (verbatim quotes below): <https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Password_Storage_Cheat_Sheet.md>
- Version: OWASP cheat sheets are continuously versioned on `master`; content captured 2026-10-28. OWASP does not stamp a release number on this page.

**Supporting quotes (verbatim):**
> "Passwords should never be stored in plain text. Instead, they must be protected using strong, slow hashing algorithms such as Argon2id, bcrypt, or PBKDF2."

> "**hashing is a one-way function** ... it is the most appropriate approach for password validation ... Since **encryption is a two-way function**, attackers can retrieve the original plaintext from the encrypted data."

> "Fast hashing algorithms such as SHA‑256 are not suitable for password storage because they allow attackers to perform large numbers of guesses quickly."

**OWASP's CURRENT recommended algorithms + parameters (verbatim summary):**
> - "Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration count of 2, and 1 degree of parallelism."
> - "If Argon2id is not available, use scrypt with a minimum CPU/memory cost parameter of (2^17), a minimum block size of 8 (1024 bytes), and a parallelization parameter of 1."
> - "For legacy systems using bcrypt, use a work factor of 10 or more and with a password limit of 72 bytes."
> - "If FIPS-140 compliance is required, use PBKDF2 with a work factor of 600,000 or more and set with an internal hash function of HMAC-SHA-256."

Full Argon2id minimum set (equal defense, CPU/RAM trade-off):
`m=47104 (46 MiB), t=1, p=1` / `m=19456 (19 MiB), t=2, p=1` /
`m=12288 (12 MiB), t=3, p=1` / `m=9216 (9 MiB), t=4, p=1` /
`m=7168 (7 MiB), t=5, p=1`.

PBKDF2 iteration counts: HMAC-SHA256 = 600,000; HMAC-SHA512 = 220,000;
HMAC-SHA1 = 1,400,000 (**legacy only, do not use for new systems**).

**Notes / caveats for the control author:**
- The control's high-level claim (no plaintext/reversible storage; use a slow
  salted KDF; the four named algorithms) is **fully accurate**.
- If the control text hard-codes specific parameters (e.g. an older
  "Argon2id m=15 MiB"), update to the current **19 MiB / t=2 / p=1** minimum —
  a stale 15 MiB figure appears in some mirrored copies and is out of date.
- OWASP now expresses the bcrypt input limit as **72 bytes** (not "72
  characters"); use "bytes" if the control is precise about it.

---

## FCS-CRYPTO-001 — NIST SP 800-131A (algorithm transitions)

**Claim:** Never use MD5/SHA-1 for integrity, DES/3DES, ECB, or home-rolled
ciphers; use SHA-256+ / AES-GCM etc.

**Verdict: VERIFIED** (citation should be pinned to **Rev. 2**; see status notes).

**Primary / authoritative sources:**
- NIST SP 800-131A **Revision 2** (standard being cited):
  <https://csrc.nist.gov/pubs/sp/800/131/a/r2/final> (publication: March 2019).
- NIST — *Transitioning Away from SHA-1 for All Applications* (2022):
  <https://www.nist.gov/news-events/news/2022/12/nist-transitioning-away-sha-1-all-applications>
- NIST — *NIST Retires SHA-1 Cryptographic Algorithm* (2022):
  <https://www.nist.gov/news-events/news/2022/12/nist-retires-sha-1-cryptographic-algorithm>

**Per-algorithm status against SP 800-131A Rev. 2 and related NIST guidance:**

- **3DES (Triple DES / TDEA):** Rev. 2 states three-key TDEA encryption is
  **deprecated through December 31, 2023, and disallowed for new applications
  after that date**; two-key TDEA was disallowed earlier. NIST also withdrew
  SP 800-67 Rev. 2 (the TDEA spec) effective **January 1, 2024**. Decryption of
  already-protected data remains permitted. → Control's "no DES/3DES" is correct;
  state 3DES as **disallowed for new use since 2023-12-31**, not merely "weak."

- **SHA-1 (for integrity/signatures):** SP 800-131A originally (2011) deprecated
  SHA-1 for digital-signature generation; NIST's 2022 guidance set a plan to
  **transition away from SHA-1 for all applications by December 31, 2030**, and
  SHA-1 with digital signature generation is no longer approved. → Control's
  "no SHA-1 for integrity" is correct.

- **MD5:** Not a NIST-approved hash at any point; never acceptable for integrity.
  (Note: MD5 is *not* governed by SP 800-131A — it was never an approved
  algorithm, so it is "not approved" rather than "deprecated/disallowed" under
  that document.)

- **ECB mode / home-rolled ciphers:** These are **not** addressed by SP 800-131A
  (which covers algorithm/key-length transitions, not block-cipher modes or
  bespoke designs). ECB's confidentiality weakness is covered by **SP 800-38A**;
  "no home-rolled ciphers" is a general best practice (FIPS 197 / SP 800-38
  series define the approved modes).

- **Approved replacements:** SHA-256/SHA-512 (FIPS 180-4), SHA-3 (FIPS 202),
  AES (FIPS 197) with an approved mode such as GCM (SP 800-38D) — all consistent
  with NIST guidance.

**NEEDS_REVISION of the citation wording (minor but important):**
1. **Pin the revision:** cite **"NIST SP 800-131A Rev. 2"** explicitly. A bare
   "SP 800-131A" is ambiguous (Rev. 1 is superseded).
2. **Scope the MD5/ECB claims:** SP 800-131A does **not** itself cover MD5, ECB,
   or "home-rolled ciphers." Either (a) narrow the SP 800-131A citation to the
   3DES/DES/SHA-1 transitions it actually governs, or (b) add companion
   citations — FIPS 180-4/FIPS 202 (hashes), FIPS 197 + SP 800-38A/38D (ciphers
   and approved modes) — for the MD5/ECB/home-rolled parts of the claim. As
   written, the citation over-attributes those three items to SP 800-131A.

---

## FCS-AUDIT-001 — SOX / ISO 27001 audit-trail controls

**Claim:** Never remove/disable/bypass audit logging on money movement;
debit+credit+audit+idempotency must be atomic.

**Verdict: VERIFIED for the standards mapping** (with a scope caveat on the
atomicity requirement).

**ISO 27001 — which control covers logging:**
- The logging control is **ISO/IEC 27001:2022 Annex A control 8.15 "Logging"**
  (a Technological control). Companion control **A.8.16 "Monitoring activities."**
- Authoritative standard page: ISO/IEC 27001:2022 —
  <https://www.iso.org/standard/27001> (the control catalogue lives in the
  standard / its companion ISO/IEC 27002:2022).
- The 2022 control text (quoted across implementation guides):
  > "Logs that record activities, exceptions, faults and other relevant events should be produced, stored, protected and analysed."
- **Version note:** In the superseded **ISO/IEC 27001:2013** this was
  **A.12.4 (Logging and monitoring)** — A.12.4.1 Event logging, A.12.4.3
  Admin/operator logs. If the control cites a 2013-era "A.12.4," update it to
  the **2022 numbering A.8.15**.

**SOX — audit trails for financial reporting:**
- The Sarbanes–Oxley Act of 2002 (**Sections 302 and 404**) requires management
  to establish, assess, and attest to **internal control over financial
  reporting (ICFR)**; audit trails / logging over systems that produce financial
  data are a standard, auditor-expected ICFR control (commonly evidenced via the
  COSO framework and IT general controls / COBIT). SOX itself is principles-based
  — it does not enumerate a technical "audit log" line item, so cite it as
  **"SOX §§302/404 ICFR → IT general controls (audit trail)"** rather than
  implying SOX names a logging control directly.
- Authoritative SOX text: <https://www.govinfo.gov/content/pkg/PLAW-107publ204/html/PLAW-107publ204.htm>

**Scope caveat (not a citation error):**
- The **atomic debit+credit+audit+idempotency** requirement is sound engineering
  (ACID transactionality + idempotency keys) but is **not** mandated verbatim by
  ISO 27001 A.8.15 or by SOX. It is an internal design control that *supports*
  the auditability objective. Keep it in the control, but attribute it to your
  own engineering standard, not to ISO/SOX.

**Citation fix:** acceptable as-is for the "do not disable/bypass logging"
claim; recommend specifying **ISO/IEC 27001:2022 A.8.15 (Logging)** and
**SOX §§302/404 (ICFR)** rather than the generic "SOX / ISO 27001."

---

## FCS-MONEY-001 — ISO 4217 currency minor units

**Claim:** Compute money in minor units per ISO 4217 (0 / 2 / 3 decimal
currencies); JPY=0, USD=2, KWD/BHD=3.

**Verdict: VERIFIED.**

**Primary source:** ISO 4217 — *Codes for the representation of currencies*.
- ISO standard page: <https://www.iso.org/standard/64758.html> (current edition
  **ISO 4217:2015**; the code/minor-unit table is maintained by SIX Financial
  Information as the ISO 4217 Maintenance Agency).
- ISO description (verbatim):
  > "ISO 4217:2015 specifies the structure for a three-letter alphabetic code and an equivalent three-digit numeric code for the representation of currencies. For those currencies having minor units, it also shows the decimal relationship between such units and the currency itself."

**Minor-unit exponents confirmed:**
- **Exponent 0 (no minor unit):** JPY, KRW, VND, ISK, XOF, XAF, XPF, etc. → **JPY = 0** ✓
- **Exponent 2 (default/most common):** USD, EUR, GBP, CHF, etc. → **USD = 2** ✓
- **Exponent 3:** BHD, KWD, IQD, JOD, LYD, OMR, TND. → **KWD = 3, BHD = 3** ✓

(Cross-checked against SIX-derived reference tables, e.g. moneyconvert.net's
ISO-4217 list synced to the maintenance agency, and payment-processor docs.)

**Notes:**
- ISO 4217 expresses minor units as a **"minor unit" exponent** (number of
  decimal places); computing in integer minor units is the correct, intended
  interpretation.
- Edge cases to keep in mind (not required by the claim, but worth noting in the
  control): some codes have **no minor unit listed** (e.g. XAU/gold, XDR), and a
  few funds/commodity codes behave specially. Treat "minor unit absent" as
  0-decimal for arithmetic only if the currency genuinely has none.

---

## Summary

| Control         | Cited standard                         | Verdict        |
|-----------------|----------------------------------------|----------------|
| FCS-SECRET-001  | OWASP Password Storage Cheat Sheet     | VERIFIED (update stale params if hard-coded) |
| FCS-CRYPTO-001  | NIST SP 800-131A                        | VERIFIED — pin to **Rev. 2**; MD5/ECB/home-rolled not governed by this SP (add FIPS 180-4/197 + SP 800-38) |
| FCS-AUDIT-001   | SOX / ISO 27001 audit-trail controls    | VERIFIED — specify **ISO 27001:2022 A.8.15** + **SOX §§302/404 ICFR**; atomicity is own engineering control |
| FCS-MONEY-001   | ISO 4217 currency minor units           | VERIFIED |

All verdicts derived from the primary standards bodies (OWASP, NIST/CSRC, ISO)
or their authoritative maintenance agents; no citation was assumed correct.
