---
name: "pci-dss"
description: "Load whenever code touches payment card data."
triggers: "pci, dss, compliance, audit, standard"
---

# Skill: PCI-DSS (Card Data)

**Load whenever code touches payment card data.**

## When to use

Any time card data (PAN, cardholder name, expiry, service code, CVV, PIN) is
accepted, processed, transmitted, or stored.

## Do

- **Don't store what you don't need.** Prefer tokenization — let the processor
  hold the card; you keep a token.
- **Mask the PAN** in any display (show at most first 6 + last 4).
- **Encrypt stored PAN** with strong crypto and managed keys (KMS/HSM).
- **Scope reduction.** Keep card data out of your systems where possible
  (hosted fields, iframe, redirect).
- **TLS 1.2+** for any transmission of card data.
- **Access logging** on every read of stored card data.

## Never (red lines)

- **Never store CVV/CVC/CAV2** after authorization — ever.
- **Never store full track data or PIN.**
- **Never log the full PAN** or any sensitive authentication data.
- **Never transmit PAN over an unencrypted channel** (email, plain HTTP, SMS).

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


<!-- fcs-managed-hash:090483b57a9cf414 -->
