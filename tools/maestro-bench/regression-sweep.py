#!/usr/bin/env python3
# Periodic-regression sweep for the local penumbra maestro candidate.
#
# Pipeline:
#   1. /health pre-check — if the server isn't up, write a marker and
#      exit 2 (server-unreachable). Don't try to bench a dead endpoint.
#   2. Run tools/maestro-bench/bench-maestro.py against the configured
#      url/model. Bench writes its full result JSON under
#      $OUT_DIR (default $DEV_STORAGE/bench/maestro-pilot/regression/).
#   3. Load prior result JSONs in the same dir, compute rolling median
#      of pass_rate and aggregate_decode_tps over the last N runs
#      (excluding the just-completed one).
#   4. Compare current to baseline. If either drops more than the
#      configured threshold, write a regression marker JSON and exit 1.
#   5. Otherwise: exit 0 (cron stays silent).
#
# Designed to be triggered by cron or launchd. Output paths default to
# $DEV_STORAGE/bench/maestro-pilot/regression/. Marker files are
# overwritten each run; the per-run JSON is timestamped.
#
# Usage:
#   regression-sweep.py [--url URL] [--model NAME] [--out-dir DIR]
#                       [--baseline-window N] [--pass-drop-threshold F]
#                       [--tps-drop-threshold F] [--bench BENCH_PY]
#
# Spec: docs/superpowers/specs/2026-05-11-maestro-pilot-wiring.md
# Ask source: penumbra-team handoff 2026-05-11 (Ask 5).

import argparse
import glob
import json
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib import request as urlreq

DEFAULT_URL = "http://127.0.0.1:8181"
DEFAULT_MODEL = "gemma4-26b-a4b-mtp"


def notify_user(title, message):
    # Best-effort macOS notification. Silent failure — the marker file is
    # still the source of truth; the notification is a courtesy nudge so
    # daily regressions don't go unread for days.
    if os.environ.get("LLAMACTL_SWEEP_NO_NOTIFY") == "1":
        return
    osascript = shutil.which("osascript")
    if not osascript:
        return
    safe_msg = message.replace('"', "'").replace("\\", " ")[:240]
    safe_title = title.replace('"', "'")[:80]
    script = f'display notification "{safe_msg}" with title "{safe_title}"'
    try:
        subprocess.run([osascript, "-e", script], check=False, timeout=3)
    except Exception:  # noqa: BLE001
        pass


def out_dir_default():
    base = os.environ.get("DEV_STORAGE") or "/Volumes/WorkSSD"
    return os.path.join(base, "bench", "maestro-pilot", "regression")


def health_check(url, timeout_s):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            with urlreq.urlopen(url + "/health", timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(2)
    return False


def run_bench(bench_py, url, model, out_path):
    proc = subprocess.run(
        [sys.executable, bench_py, "--url", url, "--model", model, "--out", out_path],
        capture_output=True,
        text=True,
        timeout=900,  # bench is ~90 s on the winner; cap generously
    )
    return proc


def load_aggregates(out_dir, exclude_path):
    """Walk prior result JSONs, return list of (mtime, agg) tuples sorted oldest→newest."""
    out = []
    for p in glob.glob(os.path.join(out_dir, "*.json")):
        if os.path.basename(p).startswith("regression-marker") or p == exclude_path:
            continue
        try:
            with open(p) as f:
                d = json.load(f)
            agg = d.get("aggregate") or {}
            if "pass_rate" not in agg:
                continue
            out.append((os.path.getmtime(p), agg))
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda x: x[0])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out-dir", default=out_dir_default())
    ap.add_argument("--baseline-window", type=int, default=7,
                    help="rolling-median window over prior runs")
    ap.add_argument("--pass-drop-threshold", type=float, default=0.10,
                    help="fail if pass_rate drops by more than this fraction below baseline median (default 0.10 = 10%%)")
    ap.add_argument("--tps-drop-threshold", type=float, default=0.20,
                    help="fail if aggregate_decode_tps drops by more than this fraction below baseline median (default 0.20 = 20%%)")
    ap.add_argument("--health-deadline", type=float, default=60.0,
                    help="seconds to wait for /health 200 before giving up")
    ap.add_argument("--bench", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "bench-maestro.py"))
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = os.path.join(args.out_dir, f"{ts}-{args.model}.json")
    marker_path = os.path.join(args.out_dir, "regression-marker.json")

    # 1. Health check
    print(f"[{ts}] checking {args.url}/health ...", flush=True)
    if not health_check(args.url, args.health_deadline):
        msg = f"server unreachable: {args.url}/health did not return 200 within {args.health_deadline}s"
        print(msg, file=sys.stderr)
        with open(marker_path, "w") as f:
            json.dump({
                "kind": "unreachable",
                "at": ts,
                "url": args.url,
                "model": args.model,
                "detail": msg,
            }, f, indent=2)
        notify_user("llamactl maestro sweep — unreachable",
                    f"{args.url} did not respond. See {marker_path}.")
        return 2

    # 2. Run the bench
    print(f"[{ts}] running {args.bench} ...", flush=True)
    proc = run_bench(args.bench, args.url, args.model, out_path)
    if proc.returncode != 0:
        msg = f"bench exited {proc.returncode}; stderr tail: {proc.stderr[-400:]!r}"
        print(msg, file=sys.stderr)
        with open(marker_path, "w") as f:
            json.dump({
                "kind": "bench_error",
                "at": ts,
                "url": args.url,
                "model": args.model,
                "detail": msg,
            }, f, indent=2)
        notify_user("llamactl maestro sweep — bench error",
                    f"bench exited {proc.returncode}. See {marker_path}.")
        return 3
    print(proc.stdout.rstrip())

    # 3. Load current result
    try:
        with open(out_path) as f:
            cur = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"could not read bench output {out_path}: {e}", file=sys.stderr)
        return 4
    cur_agg = cur.get("aggregate") or {}
    cur_pass = cur_agg.get("pass_rate")
    cur_tps = cur_agg.get("aggregate_decode_tps")
    if cur_pass is None or cur_tps is None:
        print(f"bench aggregate missing pass_rate/aggregate_decode_tps in {out_path}", file=sys.stderr)
        return 4

    # 4. Compare against rolling baseline
    history = load_aggregates(args.out_dir, exclude_path=out_path)
    baseline_runs = history[-args.baseline_window:]
    summary = {
        "kind": "ok",
        "at": ts,
        "url": args.url,
        "model": args.model,
        "current": {"pass_rate": cur_pass, "aggregate_decode_tps": cur_tps},
        "baseline": None,
        "regressions": [],
        "baseline_runs_used": len(baseline_runs),
        "out_path": out_path,
    }

    if baseline_runs:
        base_passes = [a.get("pass_rate") for _, a in baseline_runs if a.get("pass_rate") is not None]
        base_tps = [a.get("aggregate_decode_tps") for _, a in baseline_runs if a.get("aggregate_decode_tps") is not None]
        if base_passes and base_tps:
            m_pass = statistics.median(base_passes)
            m_tps = statistics.median(base_tps)
            summary["baseline"] = {
                "median_pass_rate": round(m_pass, 4),
                "median_decode_tps": round(m_tps, 2),
                "window": len(baseline_runs),
            }

            pass_drop = (m_pass - cur_pass) / m_pass if m_pass > 0 else 0.0
            tps_drop = (m_tps - cur_tps) / m_tps if m_tps > 0 else 0.0
            if pass_drop > args.pass_drop_threshold:
                summary["regressions"].append({
                    "axis": "pass_rate",
                    "median": round(m_pass, 4),
                    "current": round(cur_pass, 4),
                    "drop_pct": round(pass_drop * 100, 1),
                    "threshold_pct": round(args.pass_drop_threshold * 100, 1),
                })
            if tps_drop > args.tps_drop_threshold:
                summary["regressions"].append({
                    "axis": "aggregate_decode_tps",
                    "median": round(m_tps, 2),
                    "current": round(cur_tps, 2),
                    "drop_pct": round(tps_drop * 100, 1),
                    "threshold_pct": round(args.tps_drop_threshold * 100, 1),
                })

    if summary["regressions"]:
        summary["kind"] = "regression"
        with open(marker_path, "w") as f:
            json.dump(summary, f, indent=2)
        print("REGRESSION:", json.dumps(summary["regressions"]), file=sys.stderr)
        axes = ", ".join(r["axis"] for r in summary["regressions"])
        notify_user("llamactl maestro sweep — regression",
                    f"{args.model}: {axes} dropped beyond threshold. See {marker_path}.")
        return 1

    # Clear stale marker on a clean run.
    if os.path.exists(marker_path):
        try:
            os.remove(marker_path)
        except OSError:
            pass
    # Write a lightweight "latest" summary for quick eyeballing.
    with open(os.path.join(args.out_dir, "latest.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"OK pass={cur_pass:.3f} tps={cur_tps:.2f} (baseline runs={len(baseline_runs)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
