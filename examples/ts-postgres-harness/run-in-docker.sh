#!/usr/bin/env bash
# Run the TS harness on a host that has Docker but NO system Node (e.g. the Debian
# test box). Starts a loopback-only postgres:16, then runs the harness inside a
# node:20 container on the host network. Faithful exit code; cleans up its own pg.
# For a host that already has Node, use ./run.sh instead.
set -uo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PG="fcs-ts-pg-$$-$RANDOM"
PORT="${FCS_PG_PORT:-55443}"
cleanup(){ docker rm -f "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "### host $(hostname) | docker $(docker --version)"
echo "### starting postgres:16 (loopback 127.0.0.1:${PORT}, ${PG})"
docker run -d --name "$PG" -e POSTGRES_USER=fcs -e POSTGRES_PASSWORD=fcs -e POSTGRES_DB=fcs \
  -p "127.0.0.1:${PORT}:5432" "${FCS_PG_IMAGE:-postgres:16}" >/dev/null || { echo "FATAL docker run pg"; exit 20; }
ok=0
for i in $(seq 1 "${FCS_READY_TIMEOUT:-60}"); do
  if docker exec "$PG" pg_isready -U fcs -d fcs >/dev/null 2>&1; then echo "pg ready ${i}s"; ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || { echo "FATAL pg readiness timeout"; exit 21; }
docker exec "$PG" postgres --version

echo "### running harness in ${FCS_NODE_IMAGE:-node:20} (--network host)"
timeout "${FCS_HARNESS_TIMEOUT:-300}" docker run --rm --network host -v "$SCRIPT_DIR":/h -w /h \
  -e PGCONN="postgresql://fcs:fcs@127.0.0.1:${PORT}/fcs" \
  "${FCS_NODE_IMAGE:-node:20}" bash -lc 'node --version; if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi && npm run start --silent; rc=$?; exit $rc'
RC=$?
echo "### harness exit=$RC"
exit $RC
