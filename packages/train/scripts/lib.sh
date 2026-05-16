#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

kill_port() {
  local port=$1
  local pids

  pids="$(lsof -ti ":$port" || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      local comm
      comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ' || true)"
      if [[ "$comm" != *llama* && "$comm" != llama-server* ]]; then
        die "refusing to kill non-llama-server pid $pid on port $port (comm=$comm)"
      fi
      kill -TERM "$pid"
    done <<< "$pids"
    for _ in $(seq 1 20); do
      if ! lsof -ti ":$port" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    if lsof -ti ":$port" >/dev/null 2>&1; then
      pids="$(lsof -ti ":$port" || true)"
      if [[ -n "$pids" ]]; then
        printf '%s\n' "$pids" | xargs -r kill -9
      fi
    fi
  fi
}

wait_for_health() {
  local port=$1
  local timeout_sec=${2:-60}

  for _ in $(seq 1 "$timeout_sec"); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "llama-server did not become healthy on port $port"
}

wait_port_bindable() {
  local port=$1
  local timeout_sec=${2:-30}

  for _ in $(seq 1 "$timeout_sec"); do
    if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "port $port did not become bindable after ${timeout_sec}s"
}
