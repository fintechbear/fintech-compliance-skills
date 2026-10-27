#!/usr/bin/env bash
# Location-independent runner for the TypeScript + PostgreSQL rule harness.
# Same contract as the .NET runner: works from any CWD / a spaced path, dynamic
# loopback-only port, task-scoped container, faithful exit code, cleans up only
# its own container. Requires Node (>=20) + npm + Docker on PATH.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
H="$SCRIPT_DIR"
LOGS="${FCS_LOG_DIR:-$SCRIPT_DIR/.run-logs}"
mkdir -p "$LOGS"

CID_NAME="fcs-ts-pg16-$$-$RANDOM"
pick_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()
PY
  else
    echo $(( 49152 + ($$ % 16000) ))
  fi
}
PORT="${FCS_PG_PORT:-$(pick_port)}"
LOG="$LOGS/ts-pg.log"

cleanup() { docker rm -f "$CID_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run_body() {
  echo "### node $(node --version), npm $(npm --version)"
  echo "### harness dir: $H"
  echo "### starting PostgreSQL 16 (loopback-only 127.0.0.1:${PORT}, container ${CID_NAME})"
  if ! docker run -d --name "$CID_NAME" \
        -e POSTGRES_USER=fcs -e POSTGRES_PASSWORD=fcs -e POSTGRES_DB=fcs \
        -p "127.0.0.1:${PORT}:5432" \
        "${FCS_PG_IMAGE:-postgres:16}" >/dev/null; then
    echo "### FATAL: docker run failed"; return 20
  fi
  echo "### waiting for postgres readiness"
  local ready=0
  for i in $(seq 1 "${FCS_READY_TIMEOUT:-40}"); do
    if docker exec "$CID_NAME" pg_isready -U fcs -d fcs >/dev/null 2>&1; then echo "ready after ${i}s"; ready=1; break; fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then echo "### FATAL: postgres readiness timeout"; return 21; fi

  echo "### npm ci"
  ( cd -- "$H" && npm ci ) || { echo "### FATAL: npm ci failed"; return 18; }
  echo "### running harness (tsx main.ts)"
  export PGCONN="postgresql://fcs:fcs@127.0.0.1:${PORT}/fcs"
  ( cd -- "$H" && npm start --silent )
  local rc=$?
  echo "### harness exit=$rc"
  return $rc
}

run_body >"$LOG" 2>&1
RC=$?
echo "=== ts-pg.log tail ==="
tail -n 45 "$LOG"
echo "=== runner exit: $RC ==="
exit $RC
