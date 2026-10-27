# Skill: PCI-DSS (Card Data)

**Load whenever code touches payment card data.**

## When to use

Any time card data (PAN, cardholder name, expiry, service code, CVV, PIN) is
accepted, processed, transmitted, or stored.

## What the standard allows vs. what we prefer

Two different data classes, two different rules — do not conflate them:

- **PAN (Primary Account Number)** — storing it is **permitted** by PCI DSS, but
  only if the stored PAN is **rendered unreadable**. PCI DSS Req 3.5.1 names four
  acceptable methods: strong one-way **hashing** (keyed, per Req 3.5.1.1 for hashes
  generated after 31 Mar 2025), **truncation**, **index tokens**, or **strong
  encryption** with proper key management. There is **no blanket "never store the
  PAN"** rule — see PCI SSC FAQ 1492.
- **SAD (Sensitive Authentication Data)** — full track data, CVV/CVC/CAV2, and
  PIN/PIN block **MUST NOT be stored after authorization, even if encrypted**
  (PCI DSS Req 3.3.1). This is the hard red line. Before authorization, PCI DSS
  sets no retention limit but SAD must still be protected; individual payment
  brands may forbid storing it at all — see PCI SSC FAQ 1154.

## Do

- **Don't store what you don't need.** Prefer tokenization — let the processor
  hold the card; you keep a token. *(Project engineering policy: we aim to keep
  card data out of our systems entirely. This is stricter than the standard, which
  permits storing an unreadable PAN.)*
- **Mask the PAN** in any display (at most BIN + last 4, i.e. first 6 + last 4),
  unless a documented, management-approved business justification exists for
  showing more (PCI DSS Req 3.4.1).
- **If you must store the PAN, render it unreadable** — strong encryption with
  managed keys (KMS/HSM), truncation, keyed hashing, or index tokens (Req 3.5.1).
- **Scope reduction.** Keep card data out of your systems where possible
  (hosted fields, iframe, redirect).
- **TLS 1.2+** for any transmission of card data.
- **Access logging** on every read of stored card data.

## Never (red lines)

- **Never store Sensitive Authentication Data (full track, CVV/CVC/CAV2, PIN/PIN
  block) after authorization** — even encrypted (PCI DSS Req 3.3.1). This is the
  standard's hard prohibition.
- **Never store the PAN in readable form** (plaintext / reversibly without key
  controls). Storing the PAN itself is allowed only when rendered unreadable
  (above); readable-at-rest PAN is the violation.
- **Never log the full PAN** or any sensitive authentication data.
- **Never transmit PAN over an unencrypted channel** (email, plain HTTP, SMS).

> **Project engineering policy (stricter than PCI DSS):** by default we **do not
> store the CVV at all, ever** (not even pre-authorization) and prefer tokenizing
> the PAN rather than storing it. The *standard* only bars SAD *after*
> authorization; this tighter rule is our own choice to minimise scope and risk.

## Good example

```python
# Tokenize via the processor; store only the token + masked PAN
resp = gateway.create_payment_method(card_nonce)   # card never hits our DB
db.save(PaymentMethod(user_id=u.id,
                      token=resp.token,
                      masked_pan=resp.masked_pan))  # e.g. "411111******1111"
```

## Bad example

```python
# ❌ storing raw card + CVV, logging PAN
db.save(Card(pan=pan, cvv=cvv, exp=exp))
log.info(f"saved card {pan}")
```
