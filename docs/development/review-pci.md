# PCI DSS Citation Review — Fintech Compliance Controls

**Standard verified against:** PCI DSS v4.0.1 (current; published June 2024, mandatory as of 31 Mar 2025).
**Method:** Each cited clause checked against PCI SSC primary sources (official FAQs and published documents). Nothing inferred — where the standard text behind a login wall could not be quoted directly, the SSC's own authoritative FAQ wording is cited.

| Control | Cited clause | Verdict |
|---|---|---|
| FCS-PAN-001 | Req 3.5.1 | VERIFIED |
| FCS-SAD-001 | Req 3.3.1 | VERIFIED |
| FCS-LOG-001 | Req 3.3 / logging hygiene | NEEDS_REVISION |
| FCS-TLS-001 | Req 4 | VERIFIED (scope note) |

---

## (1) FCS-PAN-001 — "PCI DSS Req 3.5.1 (render PAN unreadable)"

**Verdict: VERIFIED**

The requirement number is correct for v4.0.1. Requirement 3.5.1 governs rendering the PAN unreadable **when stored (data at rest)**, and specifies the acceptable methods the control claims.

- PCI SSC FAQ 1222: *"Only the Primary Account Number (PAN) must be rendered unreadable when it is stored, in accordance with Requirement 3.5.1. Other elements of cardholder data, such as cardholder name, expiration date, or service code, do not need to be rendered unreadable, even if stored with the PAN."*
  — <https://www.pcisecuritystandards.org/faqs/1222>
- PCI SSC FAQ (8-digit BIN / masking & truncation): *"PCI DSS Requirement 3.5.1 applies when PAN is stored (i.e., data at rest). This requirement specifies four acceptable methods for rendering PAN unreadable when stored."* The four methods are one-way hashes based on strong cryptography (keyed — see 3.5.1.1), truncation, index tokens, and strong cryptography with associated key-management (3.5.1 → 3.6/3.7).
  — <https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/how-can-an-entity-meet-pci-dss-requirements-for-pan-masking-and-truncation-if-it-has-migrated-to-8-digit-bins/>

**Version/numbering note (important, and the control got this right):** In PCI DSS **v3.2.1 this was Requirement 3.4**. The v4.x renumbering moved "render PAN unreadable" to **3.5.1**. The control cites the correct v4.0.1 number, not the legacy 3.4.

**Scope accuracy of the claim:**
- "never store PAN readable" — accurate (3.5.1 covers stored PAN).
- "storage only when rendered unreadable (strong crypto + managed keys, truncation, keyed hashing, tokens)" — accurate; those are exactly the four acceptable methods. Note v4.0.1 adds **3.5.1.1** requiring hashes to be **keyed cryptographic hashes** (future-dated best practice, mandatory 31 Mar 2025). If the control relies on hashing, it should reference 3.5.1.1 for the keyed-hash obligation.
- "never log it" — this part is **not** a 3.5.1 obligation. 3.5.1 is about stored PAN; the "do not log readable PAN" angle is handled through masking (3.4.1) and the general storage/display rules, not 3.5.1. The core 3.5.1 citation is sound; if the control bundles a "never log PAN" assertion under 3.5.1 specifically, tighten that cross-reference (see FCS-LOG-001 below).

---

## (2) FCS-SAD-001 — "PCI DSS Req 3.3.1 (no SAD retention after authorization)"

**Verdict: VERIFIED**

Requirement number is correct for v4.0.1. Req 3.3.1 prohibits retaining Sensitive Authentication Data (SAD) after authorization, even if encrypted.

- PCI SSC FAQ: *"With respect to SAD, PCI DSS Requirement 3.3.1 prohibits storage of SAD after authorization, even if encrypted."*
  — <https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/for-pci-dss-can-sensitive-account-data-be-stored-before-authorization/>
- PCI SSC FAQ (max retention period): *"any storage of sensitive authentication data (including full track data, card verification codes/values, and PIN block data) is prohibited after authorization per PCI DSS Requirement 3.3."*
  — <https://pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/what-is-the-maximum-period-of-time-that-cardholder-data-can-be-stored>

**Scope accuracy of the claim:** The claim — never retain full track / CVV/CVC/CAV2 / PIN after authorization — maps exactly to the three SAD categories and their sub-requirements in v4.0.1:
- **3.3.1.1** — full track (magnetic stripe / chip equivalent) data not retained after authorization.
- **3.3.1.2** — card verification code (CVV/CVC/CAV2/CID) not retained after authorization.
- **3.3.1.3** — PIN / PIN block not retained after authorization.

Optional improvement (not a defect): consider citing **3.3.1.1 / 3.3.1.2 / 3.3.1.3** for traceability to each SAD element, but the parent **3.3.1** citation is accurate as written.

---

## (3) FCS-LOG-001 — "PCI DSS Req 3.3 / logging hygiene"

**Verdict: NEEDS_REVISION**

The cited clause does not match the breadth of the control's claim. The claim is a broad logging-hygiene rule — *"never log secrets / card data / passwords / tokens / full government IDs."* **Requirement 3.3 (and 3.3.1) is narrowly about Sensitive Authentication Data**, not a general secrets/credential/PII logging control.

- Req 3.3 scope is SAD only: *"any storage of sensitive authentication data (including full track data, card verification codes/values, and PIN block data) is prohibited after authorization per PCI DSS Requirement 3.3."*
  — <https://pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/what-is-the-maximum-period-of-time-that-cardholder-data-can-be-stored>

**What is wrong (overclaimed scope / under-cited):**
- **SAD in logs** *is* covered by Req 3.3 — logging CVV/track/PIN counts as retention and is prohibited after authorization. So that slice of the claim is supported. (PCI SSC confirms SAD must not be retained even in audit logs, with a narrow issuer-only exception — <https://oneuptime.com/blog/post/2026-09-25-pci-dss-sensitive-authentication-data-in-audit-logs/view>, which cites the SSC position.)
- **Readable PAN in logs** is **not** Req 3.3 — it falls under Req 3.4.1 (masking when displayed) and 3.5.1 (render unreadable when stored). Logs are a storage/display surface.
- **Passwords / authentication credentials** in logs are **not** Req 3.3 — they fall under **Requirement 8** (e.g., 8.3.x — credentials rendered unreadable / strong cryptography; 8.6 for application/system accounts).
- **Generic "secrets / tokens / full government IDs"** are **not** addressed by Req 3.3 at all. Full government IDs (e.g., SSN) are outside PCI DSS scope entirely unless they are account data; they belong to other frameworks, not PCI DSS Req 3.3.

**Recommended revision:** Split the citation to match scope:
- For "never log full track / CVV / PIN" → **Req 3.3.1** (and 3.3.1.1/.2/.3). ✔ correct anchor.
- For "never log readable PAN" → **Req 3.4.1** (masking on display) and **Req 3.5.1** (render unreadable when stored).
- For "never log passwords / credentials / tokens" → **Req 8.3.x / 8.6** (protection of authentication factors). PCI DSS has no single requirement for "tokens" generically.
- "Full government IDs" → note this is **out of PCI DSS scope**; cite an internal data-handling / privacy policy instead of a PCI DSS requirement.

As currently written, "Req 3.3 / logging hygiene" overclaims — Req 3.3 only supports the SAD portion.

---

## (4) FCS-TLS-001 — "PCI DSS Req 4 (strong cryptography in transit)"

**Verdict: VERIFIED (with a scope-precision note)**

Requirement 4 is correctly identified. In v4.0.1, Requirement 4 is *"Protect Cardholder Data with Strong Cryptography During Transmission Over Open, Public Networks."*

- PCI SSC v4.0 highlights: *"Protect cardholder data with strong cryptography during transmission over open, public networks."*
  — <https://www.pcisecuritystandards.org/1-3-pci-dss-v4-0-highlights_approved_5-26/>

**Scope precision (not an error, but tighten for audit traceability):**
- The specific sub-requirement that mandates **strong cryptography and no acceptance of unprotected/plaintext transmission, with valid/trusted certificates and secure protocol configuration**, is **Requirement 4.2.1** (and 4.2.1.1 for an inventory of trusted keys/certs; 4.2.1.2 for wireless). In **v3.2.1 this was Requirement 4.1**; v4.x renumbered it to **4.2.1**. If the control needs to anchor "never disable TLS cert validation / never allow plaintext transport," cite **4.2.1** specifically rather than the top-level "Req 4."
- **Caveat on scope of the claim:** PCI DSS Req 4 applies to **cardholder data transmitted over open, public networks**. The control's phrasing "plaintext transport for sensitive data" is **broader** than PCI DSS Req 4's object — Req 4 is about CHD on public networks, not all "sensitive data" on all networks. The citation is accurate for CHD-in-transit; if the control intends to cover broader internal/sensitive-data transport, Req 4 only partially backs that (Req 4 does not mandate encryption on trusted internal networks, and does not govern non-CHD sensitive data). Keep Req 4 as the anchor for CHD-in-transit and note the broader internal-transport intent is a policy extension beyond PCI DSS.

**Net:** requirement number (4) is correct; recommend citing **4.2.1** for the precise control and flagging that "sensitive data" is broader than PCI DSS's "cardholder data over public networks."

---

## Summary of required actions

1. **FCS-LOG-001 (NEEDS_REVISION):** Do not cite "Req 3.3" for the whole logging-hygiene claim. Req 3.3 covers SAD only. Re-anchor each clause: SAD→3.3.1; readable PAN→3.4.1/3.5.1; credentials/passwords→Req 8.3.x/8.6; government IDs→out of PCI DSS scope (use internal policy).
2. **FCS-PAN-001 (VERIFIED):** Correct (3.5.1, not legacy 3.4). If relying on hashing, additionally cite **3.5.1.1** (keyed cryptographic hashes, mandatory 31 Mar 2025). Keep the "never log PAN" assertion out of the 3.5.1 anchor (see item 1).
3. **FCS-SAD-001 (VERIFIED):** Correct (3.3.1). Optionally cite 3.3.1.1/.2/.3 for per-element traceability.
4. **FCS-TLS-001 (VERIFIED):** Correct at Req 4 level. For precision cite **4.2.1** (was 4.1 in v3.2.1), and note "sensitive data" is broader than PCI DSS's "CHD over open, public networks."

## Primary sources consulted
- PCI SSC FAQ 1222 (PAN render unreadable, Req 3.5.1): <https://www.pcisecuritystandards.org/faqs/1222>
- PCI SSC FAQ — SAD storage before/after authorization (Req 3.3.1): <https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/for-pci-dss-can-sensitive-account-data-be-stored-before-authorization/>
- PCI SSC FAQ — max retention period (SAD categories, Req 3.3): <https://pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/what-is-the-maximum-period-of-time-that-cardholder-data-can-be-stored>
- PCI SSC FAQ — PAN masking/truncation & 8-digit BIN (Req 3.5.1 four methods, data at rest): <https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/how-can-an-entity-meet-pci-dss-requirements-for-pan-masking-and-truncation-if-it-has-migrated-to-8-digit-bins/>
- PCI SSC — PCI DSS v4.0 highlights (Req 4 title): <https://www.pcisecuritystandards.org/1-3-pci-dss-v4-0-highlights_approved_5-26/>
- PCI SSC — PCI DSS v3.2.1 to v4.0 Summary of Changes (renumbering 3.4→3.5.1, 4.1→4.2.1): <https://www.pcisecuritystandards.org/documents/PCI-DSS-v3-2-1-to-v4-0-Summary-of-Changes-r1.pdf>
- PCI SSC blog — PCI DSS v4.0.1 (confirms v4.0.1 is a limited revision, keyed-hash clarification for 3.5.1): <https://blog.pcisecuritystandards.org/just-published-pci-dss-v4-0-1>
