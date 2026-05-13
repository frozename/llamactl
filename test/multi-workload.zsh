#!/usr/bin/env zsh
set -euo pipefail

if [[ "${LLAMACTL_SKIP_LIVE:-}" == "1" ]]; then
  echo "multi-workload: skipped (LLAMACTL_SKIP_LIVE=1)"
  exit 0
fi

LLAMACTL_CMD=(${=LLAMACTL:-"bun /Volumes/WorkSSD/repos/personal/llamactl/packages/cli/src/bin.ts"})

SMALL_A=${LLAMACTL_TEST_GGUF_A:-"granite-4.1-3b-Q4_K_M.gguf"}
SMALL_B=${LLAMACTL_TEST_GGUF_B:-"$SMALL_A"}

manifest_a() {
  cat <<EOF
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-a }
spec:
  node: local
  enabled: true
  target: { kind: rel, value: $SMALL_A }
  endpoint: { port: 8181 }
  resources: { expectedMemoryGiB: 2 }
EOF
}

manifest_b() {
  cat <<EOF
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-b }
spec:
  node: local
  enabled: true
  target: { kind: rel, value: $SMALL_B }
  endpoint: { port: 8090 }
  resources: { expectedMemoryGiB: 2 }
EOF
}

cleanup() {
  "${LLAMACTL_CMD[@]}" delete workload test-a 2>/dev/null || true
  "${LLAMACTL_CMD[@]}" delete workload test-b 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/5] applying A on :8181"
manifest_a | "${LLAMACTL_CMD[@]}" apply -f -

echo "[2/5] applying B on :8090 - A must keep serving"
manifest_b | "${LLAMACTL_CMD[@]}" apply -f -

echo "[3/5] probing both endpoints"
curl -fsS http://127.0.0.1:8181/health >/dev/null || { echo "FAIL: A not reachable"; exit 1; }
curl -fsS http://127.0.0.1:8090/health >/dev/null || { echo "FAIL: B not reachable"; exit 1; }
echo "OK: both workloads alive concurrently"

echo "[4/5] disabling A, B must keep serving"
"${LLAMACTL_CMD[@]}" disable test-a
sleep 1
if curl -fsS http://127.0.0.1:8181/health >/dev/null 2>&1; then
  echo "FAIL: A still alive after disable"
  exit 1
fi
curl -fsS http://127.0.0.1:8090/health >/dev/null || { echo "FAIL: B died after A disable"; exit 1; }
echo "OK: disable stopped A, B still alive"

echo "[5/5] applying A with --evict test-b - B must stop, A must serve"
manifest_a | "${LLAMACTL_CMD[@]}" apply --evict test-b -f -
sleep 1
if curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1; then
  echo "FAIL: B still alive after evict"
  exit 1
fi
curl -fsS http://127.0.0.1:8181/health >/dev/null || { echo "FAIL: A not reachable after evict apply"; exit 1; }
echo "OK: --evict stopped B, A serving"

echo "multi-workload smoke: PASS"
