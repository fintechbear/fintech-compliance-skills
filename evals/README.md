# Evaluation harness (evals/)

Measures agent behaviour on fintech compliance tasks. Deterministic graders only; no LLM
scores a result. See docs/development/P02.md for the design and the frozen baseline.

- `task.schema.json`, `tasks.jsonl` — 40 tasks (15 valid / 10 dangerous / 10 scope / 5 off-topic),
  split development vs hidden_regression, critical flagged.
- `grader.js` — deterministic grader (`node evals/grader.js` runs its self-test). Normalizes
  typographic apostrophes so a modern refusal ("I can’t … violates PCI") is recognized.
- `adapters/codex.js` — real codex CLI adapter (`node evals/adapters/codex.selftest.js`).
  `prepareCodexHome()` builds an isolated `CODEX_HOME` (credential + provider config only; no
  personal skills/rules/memories). `adapters/isolation.selftest.js` proves nothing global leaks.
- `run.js` — scored runner: tasks × conditions (WITHOUT_SKILLS / CURRENT_BASELINE / CANDIDATE)
  against the real codex CLI, isolated home, deterministic grader. Bounded (one worker,
  per-task timeout, no retries). `--ids T001,T016 --conditions …`, or `--all` for the full
  40×3 (a large paid run — opt-in). A non-OK adapter state is recorded NOT_RUN, never PASS.
- `smoke.js` — 3-task real-agent smoke (needs a usable agent CLI; bounded).
- `CURRENT_BASELINE.json` — frozen SHA-256 of skills/ at the baseline commit.
- `results/` — cleaned summaries. Raw agent outputs are NOT committed (.gitignore).

A missing/limited agent runtime makes the real eval BLOCKED — never mocked. The grader,
adapter and isolation self-tests run in CI (LLM-free); the scored agent run does not.