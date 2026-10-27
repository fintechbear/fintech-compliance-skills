#!/usr/bin/env bash
set -uo pipefail
WS=~/fcs-test-run
H="$WS/harness"
LOGS="$WS/logs"
mkdir -p "$LOGS"
CID_NAME="fcs-pg16-$$"
PORT=55432
LOG="$LOGS/dotnet-pg.log"

cleanup() {
  echo "### cleanup: removing $CID_NAME"
  docker rm -f "$CID_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

{
  echo "### dotnet $(dotnet --version)"
  echo "### starting PostgreSQL 16 (loopback-only 127.0.0.1:${PORT}, task-scoped)"
  docker run -d --name "$CID_NAME" \
    -e POSTGRES_USER=fcs -e POSTGRES_PASSWORD=fcs -e POSTGRES_DB=fcs \
    -p 127.0.0.1:${PORT}:5432 \
    postgres:16 >/dev/null
  echo "### waiting for postgres readiness"
  for i in $(seq 1 40); do
    if docker exec "$CID_NAME" pg_isready -U fcs -d fcs >/dev/null 2>&1; then echo "ready after ${i}s"; break; fi
    sleep 1
  done
  docker exec "$CID_NAME" postgres --version 2>/dev/null || true

  echo "### building + running harness (net10.0, Npgsql)"
  cd "$H"
  export PGCONN="Host=127.0.0.1;Port=${PORT};Username=fcs;Password=fcs;Database=fcs"
  export DOTNET_CLI_TELEMETRY_OPTOUT=1
  export DOTNET_NOLOGO=1
  # restore+run; keep artifacts under the harness dir (task-scoped)
  dotnet run -c Release 2>&1
  echo "### harness exit=$?"
} > "$LOG" 2>&1

echo "=== dotnet-pg.log tail ==="
tail -n 40 "$LOG"
