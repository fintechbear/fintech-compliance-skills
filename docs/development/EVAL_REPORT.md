# Agent evaluation status

**Current release: CLI/agent sessions NOT RUN by explicit owner decision.** No 40×3 evaluation, model comparison or native agent isolation sentinel is claimed.

Historical smoke at candidate `d2bff5c` used codex-cli 0.165.0 over 3 tasks × 3 conditions. Reported T016 refusals, T026 timeouts and T036 review-needed outcomes belong to that historical run. The grader and permission configuration have since changed; those outputs are not validation of the present release. Raw outputs were not committed, so the old smoke cannot support an independently reproducible effectiveness claim.

Current checks exercise deterministic grading in QuickJS WASM and config parsing only; they invoke no agent CLI. Refusal outputs containing code can require independent review. Filesystem profiles are declared in generated config, but runtime enforcement has not been tested. See [RELEASE_CLOSURE.md](RELEASE_CLOSURE.md).
