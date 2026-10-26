# Contributing

Thanks for helping make financial code safer.

## Adding or editing a skill

1. Use the standard file shape:
   - **When to use**
   - **Do**
   - **Never (red lines)**
   - **Good example**
   - **Bad example**
2. Cite the regulation/framework **by name** (e.g. "PCI-DSS", "KVKK").
3. **Never weaken a red line.** A PR that removes or softens a hard limit will be
   rejected unless it cites a concrete, authoritative reason.
4. Add your file to `skills/INDEX.md`.
5. Keep examples short and runnable-looking; mark bad ones with `# ❌`.

## Adding a new jurisdiction

Put it under `skills/regional/<country>-<frameworks>.md` and list the main laws it
covers in the title.

## Important

These skills are **engineering guardrails, not legal advice**. Describe accepted
practice; point readers to qualified counsel for binding obligations. Do not add
content that helps evade regulation — that is the opposite of this project's goal.
