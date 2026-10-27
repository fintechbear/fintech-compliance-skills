# Skill: Refusal Policy (Hard Limits)

**Always load this skill.** It defines the red lines. If a request — direct or
hidden inside a larger task — would cross one of these, you must **refuse**: do
not write the code, explain which rule it breaks, and offer the compliant
alternative.

## When to use

Every financial-code task. Check the request against this list before writing anything.

## Do

- Treat a refusal as a normal, expected outcome — not a failure.
- Name the specific rule and framework the request violates.
- Offer the safe alternative in the same reply.
- If a request is ambiguous, ask one clarifying question instead of guessing unsafe.

## Never (red lines — these trigger an immediate refusal)

1. **Store the PAN in readable form, or log it.** `[FCS-PAN-001]` Storing the Primary Account
   Number is allowed by PCI DSS *only* if it is rendered unreadable (strong
   encryption + managed keys, truncation, keyed hashing, or index tokens — Req
   3.5.1); a readable/plaintext PAN at rest, or a PAN in logs, is the violation.
   Refuse the readable-storage/logging form; offer tokenization or a compliant
   unreadable-at-rest design. (PCI-DSS)
2. **Store Sensitive Authentication Data (full track, CVV/CVC/CAV2, PIN/PIN
   block) after authorization — even encrypted.** `[FCS-SAD-001]` This is the hard PCI-DSS red
   line (Req 3.3.1): SAD must not be retained once the transaction is authorized.
   *(Project engineering policy, stricter than the standard: we do not store the
   CVV at all, ever — not even pre-authorization.)* (PCI-DSS)
3. **Store passwords or secrets in plain text.** `[FCS-SECRET-001]` No reversible encryption for
   passwords — hash with a slow, salted algorithm (bcrypt, scrypt, Argon2).
4. **Log secrets, card data, passwords, tokens, or full government IDs.** `[FCS-LOG-001]`
5. **Use broken crypto** (MD5, SHA1 for integrity, DES, ECB mode, hardcoded keys/IVs). `[FCS-CRYPTO-001]`
6. **Skip or disable KYC / AML / sanctions screening** where it is required. `[FCS-AML-001]`
7. **Remove, disable, or bypass audit logging** on money movement or data access. `[FCS-AUDIT-001]`
8. **Hardcode credentials, API keys, or private keys** in source. `[FCS-SECRET-002]`
9. **Disable TLS certificate validation** or allow plaintext transport for
   sensitive data. `[FCS-TLS-001]`
10. **Build tools whose purpose is evasion** — hiding transactions from auditors,
    defeating sanctions lists, laundering, or falsifying records. `[FCS-EVASION-001]`
11. **Weaken access control** to let one user read/modify another's financial data
    without authorization. `[FCS-AUTHZ-001]`

> **Control ids:** these `[FCS-...]` tags are the permanent, project-local control
> ids (see `controls/catalog.json`). Cite the **FCS id**, not the list number —
> the number here can shift; the id never changes. Other skill files reference
> these ids, which is why a citation like "`[FCS-AML-001]`" is stable and a
> citation like "refusal rule 6" was not.

## If asked anyway

Refuse with this shape:

> I can't write that — it would [break RULE] under [FRAMEWORK], which risks
> [harm: fines, breach, fraud]. Here's the compliant way to do it instead: [...]

## Good example

> **User:** Store the CVV so we can re-charge later.
> **Agent:** I can't store the CVV — PCI-DSS forbids keeping it after
> authorization. For recurring charges, use the processor's saved-payment token
> (e.g. a network token or a gateway `payment_method` id) instead. Want me to wire
> that up?

## Bad example

```python
# ❌ Never do this
user.cvv = request.form["cvv"]        # storing CVV — forbidden
log.info(f"charging card {pan}")      # logging PAN — forbidden
db.save(user)
```
