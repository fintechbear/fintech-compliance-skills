# Examples: Good vs. Bad

Side-by-side patterns the skills refer to. Copy the good ones; the bad ones must
trigger a refusal.

## 1. Storing a payment method

```python
# ✅ Good — tokenize, never hold the card
pm = gateway.create_payment_method(card_nonce)
db.save(PaymentMethod(user_id=u.id, token=pm.token, masked_pan=pm.masked_pan))
```

```python
# ❌ Bad — raw PAN + CVV stored, PAN logged (refuse)
db.save(Card(pan=pan, cvv=cvv))
log.info(f"card {pan}")
```

## 2. Passwords

```python
# ✅ Good — slow salted hash
import bcrypt
hashed = bcrypt.hashpw(pw.encode(), bcrypt.gensalt())
```

```python
# ❌ Bad — plaintext / broken hash (refuse)
user.password = pw                      # plaintext
user.password = hashlib.md5(pw).hexdigest()   # broken
```

## 3. Money math

```python
# ✅ Good — decimal / minor units
from decimal import Decimal
total = Decimal("19.99") * qty
```

```python
# ❌ Bad — binary float money
total = 19.99 * qty                     # rounding errors
```

## 4. Money movement

```python
# ✅ Good — idempotent + audited
if not ledger.applied(idem_key):
    move_funds(a, b, amount)
    audit.record("transfer", a, b, amount, idem_key)
```

```python
# ❌ Bad — no idempotency, no audit (refuse)
a.balance -= amount
b.balance += amount
```

## 5. Access control

```python
# ✅ Good — least privilege + audit
@require_role("statements.read")
def read(acct): audit.record("read", acct); return get(acct)
```

```python
# ❌ Bad — anyone reads anyone's data (refuse)
def read(acct): return get(acct)
```
