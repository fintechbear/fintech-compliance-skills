#!/usr/bin/env bash
# Location-independent runner for the .NET + PostgreSQL rule harness.
# Works from any current directory and from a checkout path containing spaces.
# Propagates the harness exit code faithfully (a failed harness or a failed
# container start makes this script exit non-zero). Cleans up only its own container.
set -uo pipefail

# A: resolve our own directory, do not assume ~/fcs-test-run
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
H="$SCRIPT_DIR"
LOGS="${FCS_LOG_DIR:-$SCRIPT_DIR/.run-logs}"
mkdir -p "$LOGS"

# dynamic, task-scoped names to avoid fixed-port / fixed-name collisions
CID_NAME="fcs-pg16-$$-$RANDOM"
# pick a free loopback port (fallback to a $$-derived port if python is absent)
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
LOG="$LOGS/dotnet-pg.log"

cleanup() { docker rm -f "$CID_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# B: run the body, capture the HARNESS exit code explicitly, and exit with it.
run_body() {
  echo "### dotnet $(dotnet --version)"
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
  docker exec "$CID_NAME" postgres --version 2>/dev/null || true

  echo "### building + running harness (net10.0, Npgsql)"
  export PGCONN="Host=127.0.0.1;Port=${PORT};Username=fcs;Password=fcs;Database=fcs"
  export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
  ( cd -- "$H" && dotnet run -c Release )
  local rc=$?
  echo "### harness exit=$rc"
  return $rc
}

run_body >"$LOG" 2>&1
RC=$?
echo "=== dotnet-pg.log tail ==="
tail -n 45 "$LOG"
echo "=== runner exit: $RC ==="
exit $RC
