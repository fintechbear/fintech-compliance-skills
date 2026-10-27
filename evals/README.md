# Evaluation harness (evals/)

Measures agent behaviour on fintech compliance tasks. Deterministic graders only; no LLM
scores a result. See docs/development/P02.md for the design and the frozen baseline.

- `task.schema.json`, `tasks.jsonl` — 40 tasks (15 valid / 10 dangerous / 10 scope / 5 off-topic),
  split development vs hidden_regression, critical flagged.
- `grader.js` — deterministic grader (`node evals/grader.js` runs its self-test).
- `adapters/codex.js` — real codex CLI adapter (`node evals/adapters/codex.selftest.js`).
- `smoke.js` — 3-task real-agent smoke (needs a usable agent CLI; bounded).
- `CURRENT_BASELINE.json` — frozen SHA-256 of skills/ at the baseline commit.
- `results/` — cleaned summaries. Raw agent outputs are NOT committed (.gitignore).

A missing/limited agent runtime makes the real eval BLOCKED — never mocked.