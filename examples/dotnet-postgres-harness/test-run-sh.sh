#!/usr/bin/env bash
# Control-flow test for run.sh exit-code propagation (finding B).
# Uses FAKE docker/dotnet shims on PATH — this is NOT a real database run; it only
# proves the runner returns non-zero when a stage fails and zero when all stages "pass".
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
RUN="$HERE/run.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { # name expected_rc
  local name="$1" exp="$2" got="$3"
  if [ "$got" = "$exp" ]; then echo "ok   - $name (rc=$got)"; pass=$((pass+1));
  else echo "FAIL - $name (expected rc=$exp, got rc=$got)"; fail=$((fail+1)); fi
}

make_shims() { # scenario
  local sc="$1"; local bin="$TMP/$sc/bin"; mkdir -p "$bin"
  # dotnet shim
  cat > "$bin/dotnet" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then echo "fake-dotnet"; exit 0; fi
if [ "\$1" = "run" ]; then
  if [ "$sc" = "dotnet_fail" ]; then echo "fake harness failed"; exit 17; fi
  echo "fake harness ok"; exit 0
fi
exit 0
EOF
  # docker shim
  cat > "$bin/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  run)
    if [ "$sc" = "docker_fail" ]; then echo "fake docker run fail" >&2; exit 125; fi
    echo "fakecontainer"; exit 0;;
  exec)
    # pg_isready path: succeed except in readiness_timeout
    if [ "$sc" = "readiness_timeout" ]; then exit 1; fi
    # 'postgres --version' and pg_isready both ok
    exit 0;;
  rm) exit 0;;
  *) exit 0;;
esac
EOF
  chmod +x "$bin/dotnet" "$bin/docker"
  echo "$bin"
}

for sc in all_ok dotnet_fail docker_fail readiness_timeout; do
  BIN="$(make_shims "$sc")"
  # short readiness timeout so the timeout scenario is fast
  FCS_READY_TIMEOUT=2 FCS_LOG_DIR="$TMP/$sc/logs" PATH="$BIN:$PATH" bash "$RUN" >/dev/null 2>&1
  rc=$?
  case "$sc" in
    all_ok)            check "all stages ok -> rc 0"        0 "$rc" ;;
    dotnet_fail)       check "dotnet run fail -> non-zero"   17 "$rc" ;;
    docker_fail)       check "docker run fail -> non-zero"   20 "$rc" ;;
    readiness_timeout) check "readiness timeout -> non-zero" 21 "$rc" ;;
  esac
done

echo "=== SHELL FAULT SUMMARY: pass=$pass fail=$fail ==="
[ "$fail" -eq 0 ] || exit 1
