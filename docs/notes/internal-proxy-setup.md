# Internal Proxy Setup

Slice X adds per-workload proxy opt-in (`spec.useProxy: true`) so internal callers can route through the local OpenAI-compatible proxy instead of direct workload ports. This is part of the convergence strategy to centralize KV cache, Anthropic translation, and observability in one endpoint. The internal proxy on 7944 only exposes `/v1/*` without auth; all control-plane routes require bearer even on the no-auth port.

## Install launchd agent

```sh
cp scripts/launchd/com.llamactl.internal-proxy.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.llamactl.internal-proxy.plist
```

## Uninstall launchd agent

```sh
launchctl bootout gui/$(id -u)/com.llamactl.internal-proxy || true && rm ~/Library/LaunchAgents/com.llamactl.internal-proxy.plist
```

## Smoke check

```sh
curl http://127.0.0.1:7944/v1/models | head
```

Expected: JSON response over plain HTTP without auth headers.

## Per-workload opt-in

Set `useProxy: true` under the workload spec in your manifest YAML, then re-apply:

```yaml
spec:
  node: local
  target:
    kind: rel
    value: llama-7b.gguf
  useProxy: true
```

```sh
llamactl apply -f <your-workload>.yaml
```
