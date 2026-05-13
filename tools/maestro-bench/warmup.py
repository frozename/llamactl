#!/usr/bin/env python3
# Cold-prefill warmup that matches the bench's exact prefix (system + tools).
# Avoids the 10-min stall when bench-maestro.py hits a freshly-booted
# llama-server at ctx 65536. Run once after `wait_healthy`, before bench.

import argparse
import json
import sys
import time
from urllib import request as urlreq, error as urlerr

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from importlib import import_module

bm = import_module("bench-maestro")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8181")
    ap.add_argument("--model", default="gemma4-26b-a4b-mtp")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    payload = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": bm.MAESTRO_SYSTEM},
            {"role": "user", "content": "ping"},
        ],
        "tools": list(bm.TOOLS.values()),
        "tool_choice": "auto",
        "max_tokens": 8,
        "temperature": 0,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    body = json.dumps(payload).encode()
    req = urlreq.Request(
        args.url + "/v1/chat/completions",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urlreq.urlopen(req, timeout=args.timeout) as r:
            r.read()
        print(f"warmup ok in {time.time()-t0:.1f}s")
    except urlerr.HTTPError as e:
        print(f"warmup http {e.code} in {time.time()-t0:.1f}s (continuing)")
    except Exception as e:
        print(f"warmup failed in {time.time()-t0:.1f}s: {e} (continuing)")


if __name__ == "__main__":
    main()
