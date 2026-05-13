#!/usr/bin/env python3
# Final tuning pass — 4 additional dimensions on Q4_K_M + f16 + cache-reuse.
# Each variant runs on the rebuilt fork with the SWA fix.
#
# Variants:
#   - baseline:   current best (Q4_K_M + f16 + ub 1024 + b 2048 + --no-warmup + --reasoning off)
#   - b-4096:     macro batch 4096 (was 2048)
#   - b-1024:     macro batch 1024 (was 2048) — sanity check below default
#   - warmup-on:  remove --no-warmup (let llama-server's startup warmup run)
#   - system-v2:  compacted MAESTRO_SYSTEM (--system-variant v2 on the bench)
#
# Pre: gemma4-26b-a4b-mtp-local is running on Q4_K_M + f16. Granite running.
# Post: same baseline restored.
import argparse
import os
import subprocess
import time
import yaml
from pathlib import Path

REPO = Path("/Volumes/WorkSSD/repos/personal/llamactl")
BASELINE = REPO / "templates/workloads/gemma4-26b-a4b-mtp-local.yaml"
BENCH = REPO / "tools/maestro-bench/bench-maestro.py"
WARMUP = REPO / "tools/maestro-bench/warmup.py"
OUT_DIR = Path(os.environ["DEV_STORAGE"]) / "bench/maestro-pilot/final-tune-2026-05-13"
URL = "http://127.0.0.1:8181"
MODEL = "gemma4-26b-a4b-mtp"
PENUMBRA_WORKER = Path.home() / "Library/LaunchAgents/dev.penumbra.worker.plist"

VARIANTS = {
    "baseline": {},
    "b-4096": {"args": [("-b", "4096")]},
    "b-1024": {"args": [("-b", "1024")]},
    "warmup-on": {"remove": ["--no-warmup"]},
    "system-v2": {"system_variant": "v2"},
}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=False, **kw)


def stop_penumbra_worker():
    if "dev.penumbra.worker" in subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout:
        print("==> unload penumbra worker")
        sh(["launchctl", "unload", str(PENUMBRA_WORKER)])
        time.sleep(1)


def restore_penumbra_worker():
    if "dev.penumbra.worker" in subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout:
        return
    print("==> reload penumbra worker")
    sh(["launchctl", "load", str(PENUMBRA_WORKER)])


def wait_healthy(timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sh(["curl", "-sf", URL + "/health"], capture_output=True).returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError("health timeout")


def warmup():
    print(f"==> warmup ({URL})")
    sh(["python3", str(WARMUP), "--url", URL, "--model", MODEL])


def apply_variant(name, edits):
    """Mutate the baseline template, save, and apply."""
    with open(BASELINE) as f:
        spec = yaml.safe_load(f)
    new_name = f"gemma4-26b-a4b-mtp-{name}-local"
    spec["metadata"]["name"] = new_name

    args = spec["spec"]["extraArgs"]
    # Walk pairs for arg replacement (some flags are valueless)
    pairs = []
    i = 0
    while i < len(args):
        flag = args[i]
        if i + 1 < len(args) and not str(args[i+1]).startswith("-"):
            pairs.append((flag, args[i+1]))
            i += 2
        else:
            pairs.append((flag, None))
            i += 1

    for arg, val in edits.get("args", []):
        for j, (k, _) in enumerate(pairs):
            if k == arg:
                pairs[j] = (arg, val)
                break
        else:
            pairs.append((arg, val))

    for arg in edits.get("remove", []):
        pairs = [(k, v) for k, v in pairs if k != arg]

    new_args = []
    for k, v in pairs:
        new_args.append(k)
        if v is not None:
            new_args.append(str(v))
    spec["spec"]["extraArgs"] = new_args

    tmp = Path("/tmp") / f"{new_name}.yaml"
    with open(tmp, "w") as f:
        yaml.dump(spec, f, sort_keys=False, default_flow_style=False)

    print(f"==> apply {new_name}")
    if sh(["llamactl", "apply", "-f", str(tmp)]).returncode != 0:
        raise RuntimeError(f"apply failed for {new_name}")
    return new_name


def disable(name):
    print(f"==> disable {name}")
    sh(["llamactl", "disable", name])
    time.sleep(3)


def run_bench(tag, system_variant):
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_path = OUT_DIR / f"{stamp}-{tag}.json"
    print(f"==> bench {tag} (system_variant={system_variant})")
    sh([
        "python3", str(BENCH),
        "--url", URL,
        "--model", MODEL,
        "--system-variant", system_variant,
        "--out", str(out_path),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", help="comma-separated subset of variant names")
    args = ap.parse_args()
    selected = args.variants.split(",") if args.variants else list(VARIANTS.keys())

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stop_penumbra_worker()
    try:
        current = "gemma4-26b-a4b-mtp-local"
        for vname in selected:
            edits = VARIANTS[vname]
            sysvar = edits.get("system_variant", "v1")
            if vname == "baseline":
                disable(current)
                print(f"==> apply baseline (unmodified template)")
                sh(["llamactl", "apply", "-f", str(BASELINE)])
                current = "gemma4-26b-a4b-mtp-local"
            elif "args" in edits or "remove" in edits:
                disable(current)
                current = apply_variant(vname, edits)
            else:
                # bench-only variant (e.g. system-v2) — keep current workload
                pass
            wait_healthy()
            time.sleep(5)
            warmup()
            run_bench(vname, sysvar)

        # Restore
        disable(current)
        print("==> apply baseline (restore)")
        sh(["llamactl", "apply", "-f", str(BASELINE)])
        wait_healthy()
    finally:
        restore_penumbra_worker()

    print(f"\n### Done. Results in {OUT_DIR}")
    sh(f"/bin/ls -lh {OUT_DIR}", shell=True)


if __name__ == "__main__":
    main()
