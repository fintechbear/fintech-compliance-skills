---
name: "us-sox-glba-ccpa"
description: "Load for code serving US users or US-listed/regulated entities."
triggers: "us, sox, glba, ccpa, regulation, jurisdiction, country"
---

# Skill: US (SOX · GLBA · CCPA/CPRA)

**Load for code serving US users or US-listed/regulated entities.**

## When to use

Financial reporting systems (SOX), consumer financial data (GLBA), or personal
data of California residents (CCPA/CPRA).

## Do

- **SOX — integrity of financial records:** append-only, auditable; enforce
  separation of duties (the person who initiates isn't the one who approves).
- **GLBA — safeguard customer data:** access controls, encryption, documented
  security program; provide privacy notices.
- **CCPA/CPRA — consumer rights:** support know / delete / opt-out of sale;
  honor "Do Not Sell/Share."
- **Breach readiness:** detection and a notification path.

## Never (red lines)

- **Never allow edits to finalized financial records** without an auditable,
  approved trail (SOX).
- **Never let one identity both initiate and approve** a material financial action.
- **Never sell/share personal data after a consumer opts out.**
- **Never ship customer financial data without access controls and encryption.**

## Good example

```python
# Separation of duties on a journal entry
def post_entry(entry, initiator, approver):
    assert initiator != approver                  # SOX: segregation of duties
    assert approver.can("approve_journal")
    ledger.append(entry, immutable=True)          # append-only
    audit.record("journal_posted", by=initiator, approved_by=approver)
```

## Bad example

```python
# ❌ same user posts & approves, record is mutable, no audit
def post_entry(entry, user):
    ledger.update(entry.id, entry)   # overwrites a finalized record
```


<!-- fcs-managed-hash:e3a6e19254abc931 -->
