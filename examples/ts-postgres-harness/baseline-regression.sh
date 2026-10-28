#!/usr/bin/env bash
# FAILING-FIRST proof for the DB-bound TS findings, run against a REAL PostgreSQL.
# Given a base SHA (the reviewed main head), it materialises that commit's harness
# sources into _baseline/ and runs the per-finding probes in baseline-probes/ against
# them. Each probe ASSERTS the OLD buggy behaviour; if a probe does NOT observe the bug
# (i.e. the base already behaved correctly) it exits non-zero, which FAILS this step.
#
# This is what makes the acceptance "fixed" claim real: the same real DB, the same probe,
# old code reproduces the bug -> new code (run by the next CI step) passes. A step that
# never runs, or a bug that cannot be reproduced, is a FAILURE here, not a silent pass.
set -uo pipefail

BASE_SHA="${1:?usage: baseline-regression.sh <base-sha>}"
HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd -- "$HARNESS_DIR"

: "${PGCONN:?PGCONN must point at the real test database}"

BL="_baseline"
rm -rf "$BL"; mkdir -p "$BL"

# Repo-relative path of this harness, so we can read the base version of each source.
REPO_ROOT="$(git rev-parse --show-toplevel)"
REL="$(python3 - "$REPO_ROOT" "$HARNESS_DIR" <<'PY'
import os,sys
print(os.path.relpath(sys.argv[2], sys.argv[1]).replace(os.sep,'/'))
PY
)"
echo "### baseline SHA: $BASE_SHA"
echo "### harness rel:  $REL"

# Materialise the base sources we probe (UTF-8, no BOM/CRLF surprises).
for f in bank.ts ledger.ts refund.ts retention.ts webhook.ts money.ts; do
  if git cat-file -e "${BASE_SHA}:${REL}/${f}" 2>/dev/null; then
    git show "${BASE_SHA}:${REL}/${f}" > "$BL/$f"
    echo "  base $f  ($(wc -l < "$BL/$f") lines)"
  else
    echo "  base $f  (absent at base — probe will treat as 'finding introduced here')"
  fi
done
# the base harness imports from './money.ts' etc.; copy node_modules + tsconfig by reference
cp tsconfig.json "$BL/tsconfig.json" 2>/dev/null || true
ln -sf "$HARNESS_DIR/node_modules" "$BL/node_modules" 2>/dev/null || true

fail=0
run_probe() {
  local name="$1"; shift
  echo "### FAILING-FIRST probe: $name"
  if PGCONN="$PGCONN" BL="$HARNESS_DIR/$BL" node --import tsx "$HARNESS_DIR/baseline-probes/$name"; then
    echo "  ok   base reproduced the bug ($name)"
  else
    echo "  FAIL base did NOT reproduce the bug ($name) — failing-first proof is void"
    fail=1
  fi
}

# One probe per DB-bound finding. Each exits 0 ONLY if it observed the OLD bug.
for p in r01-self-transfer.ts r02-no-authz.ts r06-refund-number.ts r09-refund-conflict.ts r10-webhook-rangeerror.ts r12-retention-race.ts; do
  [ -f "baseline-probes/$p" ] && run_probe "$p"
done

rm -rf "$BL"
if [ "$fail" -ne 0 ]; then echo "=== FAILING-FIRST proof incomplete ==="; exit 1; fi
echo "=== all failing-first probes reproduced the base bugs ==="
exit 0
