# Fintech Compliance Control — Primary-Source Citation Review

Scope: verify LAW/jurisdiction controls and Stripe provider-doc controls against primary sources. For jurisdiction-specific legal claims, the target verdict is **VERIFIED-AS-JURISDICTION-SPECIFIC** — each is a correct per-jurisdiction framing, not a single universal statute. Any control overclaiming a universal legal rule is flagged.

Review date: 2026-10-28. Independent research; claims not assumed correct.

---

## FCS-AML-001 — AML/CFT screening must not be skipped; distinguish candidate matches, PEP risk and confirmed sanctions matches

**Cited basis:** AML/CFT obligations (jurisdiction-specific; e.g. MASAK/OFAC/EU lists).

**Verdict: VERIFIED-AS-JURISDICTION-SPECIFIC**

The framing is correct. There is no single universal AML statute. The common framework is **FATF**, whose 40 Recommendations are "recognised as the global anti-money laundering (AML) and counter-terrorist financing (CTF) standard" — a *standard*, not law, that each country transposes into its own statutes and that FATF assesses via Mutual Evaluations (e.g. the Türkiye MER).

Jurisdiction mapping in the citation is accurate:
- **US** — sanctions screening = **OFAC** (31 CFR; administered by Treasury/OFAC); customer due diligence / reporting = **BSA** (Bank Secrecy Act, 31 USC 5311 et seq.).
- **EU** — Anti-Money Laundering Directives (AMLD; latest 5AMLD/6AMLD) plus the new **AML Regulation + AMLA** institutional reform.
- **Turkey** — **Law No. 5549** (Law on Prevention of Laundering Proceeds of Crime, 11 Oct 2006) with **MASAK** as supervisor, imposing CDD, record-keeping and reporting duties on obliged parties.

Correction (2026-10-28): never bypass required screening, but do not equate a PEP classification, candidate name match and confirmed sanctions match. FATF PEP guidance requires additional risk-based measures and does not create a universal automatic freeze. A hold/freeze must follow the applicable regime or a declared institution policy. Source: https://www.fatf-gafi.org/en/publications/Fatfrecommendations/Peps-r12-r22.html . Because screening requirements and list sources differ by jurisdiction, the control is correctly scoped as jurisdiction-specific and does **not** overclaim a universal statute.

Sources:
- FATF Recommendations / Mutual Evaluation of Turkey 2019 — [fatf-gafi.org](https://www.fatf-gafi.org/en/publications/Mutualevaluations/Mutualevaluationofturkey.html), [Türkiye country page](https://www.fatf-gafi.org/en/countries/detail/Turkey.html)
- Turkey AML Law No. 5549 (primary text) — [hmb.gov.tr PDF](https://ms.hmb.gov.tr/uploads/sites/2/2022/08/Law_No_5549_AML_Law.pdf)
- EU AML/CFT framework (AMLD / AML Regulation / AMLA) — [EC AML FAQ PDF](https://finance.ec.europa.eu/document/download/553ff649-fce8-4e31-b54c-01f562ca0bb3_en?filename=240424-anti-money-laundering-faqs_en.pdf)

---

## FCS-EVASION-001 — Never build tools whose purpose is evasion (hiding txns from auditors, defeating sanctions, laundering)

**Cited basis:** AML/CFT + anti-fraud statutes.

**Verdict: VERIFIED-AS-JURISDICTION-SPECIFIC**

Correctly framed. The prohibition rests on the same jurisdiction-specific bodies as FCS-AML-001 plus national fraud/criminal statutes; there is no single global "anti-evasion" law:
- Sanctions evasion is an offence under **US OFAC/IEEPA** regimes and under **EU sanctions regulations**; structuring/concealment is a money-laundering predicate under FATF-aligned national law (e.g. Turkey Law No. 5549 and TCK money-laundering offences; US BSA anti-structuring at 31 USC 5324).
- Facilitating these via tooling implicates money-laundering and anti-fraud statutes that vary by country.

The control's substance (do not build tooling whose *purpose* is to conceal transactions from auditors, defeat sanctions screening, or launder proceeds) is consistent with these regimes and is appropriately expressed as a jurisdiction-spanning principle rather than a single universal statute. No overclaim.

Sources:
- FATF (global AML/CTF standard) — as above.
- Turkey Law No. 5549 — [hmb.gov.tr PDF](https://ms.hmb.gov.tr/uploads/sites/2/2022/08/Law_No_5549_AML_Law.pdf)
- EU AML/CFT framework — [EC AML FAQ PDF](https://finance.ec.europa.eu/document/download/553ff649-fce8-4e31-b54c-01f562ca0bb3_en?filename=240424-anti-money-laundering-faqs_en.pdf)

---

## FCS-RETAIN-001 — Retention decided per data category by legal basis: mandatory financial records retained vs erasable profile data

**Cited basis:** Record-keeping minimums vs erasure rights (jurisdiction-specific; AML retention vs GDPR/KVKK erasure).

**Verdict: VERIFIED-AS-JURISDICTION-SPECIFIC**

The tension is real, documented, and resolved exactly as the control states.

- **Erasure is not absolute.** GDPR **Article 17(3)(b)** disapplies the right to erasure where processing is "necessary for compliance with a legal obligation which requires processing by Union or Member State law." AML/KYC record-keeping is the textbook example of such a legal obligation. EDPB Article-60 right-to-erasure decisions explicitly uphold refusals to erase where AML national legislation requires retention.
- **AML retention minimum.** EU AMLD (and national transpositions) require retention of CDD records and transaction records for **at least five years** after the end of the business relationship. EDPB case summaries cite the five-year AML retention requirement as the basis for lawfully refusing erasure. Turkey's Law No. 5549 / MASAK regime imposes an analogous record-keeping duty (commonly 8 years under Turkish practice for certain records; AML CDD records retained for the statutory period), sitting alongside **KVKK** (Law No. 6698) erasure rights.
- **Per-category resolution is correct.** Mandatory financial/transaction records fall under the legal-obligation exemption and are retained for the statutory minimum; discretionary profile data not covered by a retention obligation remains subject to erasure/storage-limitation (GDPR Art 5(1)(e)). This category-by-category, legal-basis-driven approach is precisely the documented reconciliation.

Because retention periods and the specific laws (GDPR vs KVKK; EU AMLD vs Turkey Law 5549) differ by jurisdiction, the control is correctly scoped as jurisdiction-specific and does not overclaim a universal rule.

Sources:
- GDPR Art 17(3)(b) legal-obligation exemption vs AML/KYC retention — [hodder.law analysis](https://hodder.law/gdpr-erasure-aml-retention-crypto-compliance/)
- EDPB Article-60 right-to-erasure decisions (AML 5-year retention upholds refusal) — [edpb.europa.eu CY decision](https://www.edpb.europa.eu/sites/default/files/article-60-final-decisions/publishable_cy_2019-06_righttoerasure_decisionpublic.pdf), [UK summary](https://edpb.europa.eu/sites/edpb/files/article-60-final-decisions/summary/publishable_uk_2019-12_right_to_erasure_summarypublic.pdf)
- ICO storage limitation (principle e) — [ico.org.uk](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
- GDPR/AML interaction overview — [ComplyAdvantage](https://complyadvantage.com/insights/anti-money-laundering/gdpr-aml/)

*Minor note (non-blocking):* if the control text states a single numeric retention figure as universal, it should be qualified — "at least 5 years" is the EU AMLD baseline, but some jurisdictions (and Turkey for certain record types) require longer. The jurisdiction-specific framing already handles this.

---

## FCS-WEBHOOK-001 — Verify webhook signature on the raw body

**Cited basis:** Stripe webhooks docs.

**Verdict: VERIFIED**

Matches Stripe's documented guidance. Stripe signs each webhook with a `Stripe-Signature` header; verification is performed by passing the **raw (unparsed) request body**, the `Stripe-Signature` header, and the endpoint's `whsec_` signing secret to the SDK's `constructEvent` (Node) / `Webhook.construct_event` (Python) etc. The SDK recomputes the HMAC over the raw bytes and compares; if the body was parsed and re-serialized (JSON→string), the secret is wrong, or the timestamp is stale, verification fails. Stripe documentation and widely-cited guidance stress that the common failure cause is a framework parsing the body before verification, and that signature verification must never be skipped. The engineering claim (verify signature on the raw body) is accurate.

Sources:
- Stripe — Handle payment events / webhook verification — [docs.stripe.com/webhooks/handling-payment-events](https://docs.stripe.com/webhooks/handling-payment-events)
- Raw-body + `Stripe-Signature` + `whsec_` via `constructEvent` (secondary, consistent) — [hooklistener implementation guide](https://www.hooklistener.com/learn/stripe-webhooks-implementation), [rapidevelopers](https://rapidevelopers.com/stripe-guide/how-to-handle-webhooks-in-stripe-api)

---

## FCS-OUTCOME-001 — Model unknown outcome; no blind re-charge with a new idempotency key

**Cited basis:** Stripe error docs.

**Verdict: VERIFIED**

Directly supported by Stripe's error-handling documentation. Stripe's "Choose your next action based on what you know about the request's outcome" table states, verbatim:

- "A connection fails or a request is still executing → **Retry safely with the same idempotency key and parameters.**"
- "A server error or another failure leaves the outcome unknown → **Reconcile the request before starting another operation.**"

Additionally, the idempotency reference states that using an idempotency key lets you "safely repeat the request without risk of creating a second object," and Stripe caches the result (including errors) after the method begins executing — so a **new** idempotency key on retry would defeat that protection and risk a duplicate charge. This confirms both engineering claims: (a) treat an unknown outcome as unknown and reconcile rather than assume failure, and (b) do not blindly re-charge, and specifically do not retry with a *new* idempotency key. Accurate.

Sources:
- Stripe — Error handling (outcome/next-action table) — [docs.stripe.com/error-handling](https://docs.stripe.com/error-handling)
- Stripe — Advanced error handling (idempotency caches result incl. errors) — [docs.stripe.com/error-low-level](https://docs.stripe.com/error-low-level)
- Stripe API — Idempotent requests (safe repeat, no duplicate) — [docs.stripe.com/api/idempotent_requests](https://docs.stripe.com/api/idempotent_requests)

---

## Summary

| Control | Verdict |
|---|---|
| FCS-AML-001 | VERIFIED-AS-JURISDICTION-SPECIFIC |
| FCS-EVASION-001 | VERIFIED-AS-JURISDICTION-SPECIFIC |
| FCS-RETAIN-001 | VERIFIED-AS-JURISDICTION-SPECIFIC |
| FCS-WEBHOOK-001 | VERIFIED |
| FCS-OUTCOME-001 | VERIFIED |

No control overclaims a universal legal rule — each legal control is correctly scoped to the FATF-standard / national-statute framework (OFAC/BSA, EU AMLD/AMLA, Turkey Law 5549, GDPR Art 17(3)(b) vs KVKK). The two Stripe provider-doc controls match Stripe's published guidance. One non-blocking suggestion: ensure any numeric AML retention figure in FCS-RETAIN-001 is stated as a jurisdiction-dependent minimum ("at least 5 years" under EU AMLD) rather than a fixed universal value.
