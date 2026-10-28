# Acceptance matrix

The current finding-to-fix-to-test matrix is in [RELEASE_CLOSURE.md](RELEASE_CLOSURE.md).

- CLI/installer/doctor/live-agent tests: **NOT RUN**, explicitly excluded by owner.
- Module regressions/schema/typecheck/real PostgreSQL suites: required in current Verify workflow.
- Runtime agent read-isolation and effectiveness: unverified; configuration tests are not runtime proof.
- Check the exact PR head and attached `release-evidence`; older green runs are not current acceptance.
