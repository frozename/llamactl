#!/usr/bin/env python3
# Tuning grid for Gemma 4 26B-A4B + MTP on `local`. Runs 8 1-D variants
# of each baseline (Q4_K_M, Q6_K_XL) against a fixed bench harness.
#
# Per-task decode median tps is the comparison signal — eff_tps is noisy
# due to SWA cache misses, which are an upstream llama.cpp limitation.
#
# Pre: the rebench-2026-05-13 workloads are present (so the templates
# can be read as baselines). Granite stays disabled for the Q6_K_XL leg.
# Post: XL baseline + Granite re-enabled.

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import yaml

REPO = Path("/Volumes/WorkSSD/repos/personal/llamactl")
TEMPLATES = REPO / "templates/workloads"
BENCH = REPO / "tools/maestro-bench/bench-maestro.py"
WARMUP = REPO / "tools/maestro-bench/warmup.py"
OUT_DIR = Path(os.environ["DEV_STORAGE"]) / "bench/maestro-pilot/tune-grid-2026-05-13"
URL = "http://127.0.0.1:8181"
MODEL = "gemma4-26b-a4b-mtp"
PENUMBRA_WORKER = Path.home() / "Library/LaunchAgents/dev.penumbra.worker.plist"


# The 8 variants applied to each baseline. Each variant is a list of
# (arg_name, new_value) edits applied in order. The arg_name is the
# long flag (e.g. "--ctx-size", "-ub", "-ctk"). Multi-arg edits
# (KV type sets ctk/ctv/ctkd/ctvd) are bundled.
VARIANTS = {
    "ub-2048": [("-ub", "2048")],
    "ub-512":  [("-ub", "512")],
    "ctx-16384": [("--ctx-size", "16384")],
    "ctx-8192":  [("--ctx-size", "8192")],
    "kv-q80": [("-ctk", "q8_0"), ("-ctv", "q8_0"), ("-ctkd", "q8_0"), ("-ctvd", "q8_0")],
    "kv-f16":  [("-ctk", "f16"),  ("-ctv", "f16"),  ("-ctkd", "f16"),  ("-ctvd", "f16")],
    "draft-aggro":  [("--draft-block-size", "5"), ("--draft-max", "12")],
    "draft-soft":   [("--draft-block-size", "2"), ("--draft-max", "4")],
}

BASELINES = [
    ("q4km",  "gemma4-26b-a4b-mtp-q4km-local",  False),
    ("q6kxl", "gemma4-26b-a4b-mtp-q6kxl-local", True),  # needs granite stopped
]


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=False, **kw)


def stop_penumbra_worker():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    if "dev.penumbra.worker" in out.stdout:
        print("==> unload penumbra worker")
        sh(["launchctl", "unload", str(PENUMBRA_WORKER)])
        time.sleep(1)


def restore_penumbra_worker():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    if "dev.penumbra.worker" in out.stdout:
        print("==> penumbra worker already loaded; skip reload")
        return
    print("==> reload penumbra worker")
    sh(["launchctl", "load", str(PENUMBRA_WORKER)])


def wait_healthy(timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = sh(["curl", "-sf", URL + "/health"], capture_output=True)
        if r.returncode == 0:
            return True
        time.sleep(2)
    raise RuntimeError("health timeout")


def warmup():
    print(f"==> warmup ({URL})")
    sh(["python3", str(WARMUP), "--url", URL, "--model", MODEL])


def apply_variant(template_path: Path, variant_edits, variant_name, base_workload_name):
    """Mutate extraArgs of a template YAML and apply via llamactl."""
    with open(template_path) as f:
        spec = yaml.safe_load(f)

    # New workload name to avoid colliding with the unmodified baseline
    new_name = f"{base_workload_name}-tune-{variant_name}"
    spec["metadata"]["name"] = new_name

    args = spec["spec"]["extraArgs"]
    # extraArgs is a flat list of strings — pairs of (flag, value) but
    # some flags are valueless (e.g. --swa-full). We rebuild as a map
    # by walking pairs, then re-flatten after edits.
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

    for arg, val in variant_edits:
        replaced = False
        for j, (k, _) in enumerate(pairs):
            if k == arg:
                pairs[j] = (arg, val)
                replaced = True
                break
        if not replaced:
            pairs.append((arg, val))

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
    r = sh(["llamactl", "apply", "-f", str(tmp)])
    if r.returncode != 0:
        raise RuntimeError(f"apply failed for {new_name}")
    return new_name


def disable(name):
    print(f"==> disable {name}")
    sh(["llamactl", "disable", name])
    time.sleep(3)


def run_bench(tag: str):
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_path = OUT_DIR / f"{stamp}-{tag}.json"
    print(f"==> bench {tag}")
    sh([
        "python3", str(BENCH),
        "--url", URL,
        "--model", MODEL,
        "--out", str(out_path),
    ])
    return out_path


def baseline_workload_name(tag):
    return f"gemma4-26b-a4b-mtp-{tag}-local"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", help="comma-separated subset of variant names")
    ap.add_argument("--quants", default="q4km,q6kxl", help="comma-separated quants")
    args = ap.parse_args()

    selected_variants = (
        args.variants.split(",") if args.variants
        else list(VARIANTS.keys())
    )
    selected_quants = args.quants.split(",")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"OUT_DIR={OUT_DIR}")
    print(f"variants: {selected_variants}")
    print(f"quants:   {selected_quants}")

    stop_penumbra_worker()
    try:
        for qtag, qworkload, needs_granite_stopped in BASELINES:
            if qtag not in selected_quants:
                continue
            print(f"\n##### QUANT: {qtag} #####")
            template = TEMPLATES / f"{qworkload}.yaml"
            if needs_granite_stopped:
                disable("granite41-8b-long-lived-local")

            # Disable any other gemma workload that might be on 8181
            for other in [
                "gemma4-26b-a4b-mtp-local",
                "gemma4-26b-a4b-mtp-q4km-local",
                "gemma4-26b-a4b-mtp-q5km-local",
                "gemma4-26b-a4b-mtp-q6kxl-local",
                "gemma4-26b-a4b-mtp-q8-local",
                "gemma4-26b-a4b-mtp-q8kxl-local",
                "gemma4-26b-a4b-mtp-mxfp4-local",
            ]:
                if other == qworkload:
                    continue
                sh(["llamactl", "disable", other])
            time.sleep(2)

            # Baseline (unmodified template) reference run, for fair compare
            disable(qworkload)
            print(f"==> apply {qworkload} (baseline)")
            sh(["llamactl", "apply", "-f", str(template)])
            wait_healthy(); time.sleep(5); warmup()
            run_bench(f"{qtag}-baseline")

            current = qworkload
            for v in selected_variants:
                disable(current)
                new_name = apply_variant(template, VARIANTS[v], v, qworkload)
                wait_healthy(); time.sleep(5); warmup()
                run_bench(f"{qtag}-{v}")
                current = new_name

            disable(current)

        # Restore
        print("\n### Restore: XL baseline + Granite")
        sh(["llamactl", "enable", "gemma4-26b-a4b-mtp-local"])
        wait_healthy()
        sh(["llamactl", "enable", "granite41-8b-long-lived-local"])
    finally:
        restore_penumbra_worker()

    print(f"\n### Done. Results in {OUT_DIR}")
    sh(f"/bin/ls -lh {OUT_DIR}", shell=True)


if __name__ == "__main__":
    main()
