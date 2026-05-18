# ACP `tool_name: null` parser-bug — static analysis 2026-05-15 pm

Off-LAN session: mac-mini unreachable, so live trace is blocked. This doc captures what the source code says before we have wire output.

## What the continuation note claims

> claude-agent-acp's tool-call parser fails on penumbra-native tools but not federated ha tools. `tool_call_update {status: failed, title: undefined, kind: undefined}` → penumbra logs `agent.tool_call.failed {tool_name: null, output: null}`. Hypothesis: `mcp__penumbra__chain_start_simple` vs `mcp__ha__ha_pulse` shape trips claude-agent-acp's `toolUseCache[chunk.id]` lookup.

## What the code actually says

### claude-agent-acp emits `status: "failed"` from exactly ONE site

`acp-agent.js:2007` — the `tool_result` branch of `toAcpNotifications`:

```js
update = {
  _meta: { claudeCode: { toolName: toolUse.name }, ... },
  toolCallId: chunk.tool_use_id,
  sessionUpdate: "tool_call_update",
  status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
  rawOutput: chunk.content,
  ...toolUpdate,
};
```

`toolUpdate` comes from `toolUpdateFromToolResult` (tools.js:278). For MCP tools (which hit `case default` in `toolUseCache[id].name` switch), `toolUpdate` is `{}` or `{content: [...]}`. **It NEVER includes `title` or `kind` for MCP tools.**

So `title` and `kind` are intentionally absent on every `tool_call_update` with `status: "failed"` for any MCP tool. **This is not a name-dependent bug — it's the wire shape.**

### penumbra reads tool_name from the FAILED update only

`packages/agentchat/src/adapters/stdio-acp.ts:706-727` (the `case 'tool_call_update'` handler):

```ts
if (update.status === 'failed') {
  emitLifecycle(input, 'agent.tool_call.failed', {
    adapter: this.kind,
    tool_call_id: update.toolCallId,
    tool_name:
      (typeof update.title === 'string' && update.title) ||
      (typeof update.kind === 'string' && update.kind) ||
      null,
    output: update.output ?? null,
  });
}
```

The `case 'tool_call'` handler (line 674) captures `toolCallId`, `status`, `input` to `capturePort` but **does not persist `title` or any tool-name → id mapping anywhere**. There is no fallback lookup table.

### Consequence

ANY tool failure (penumbra OR ha OR claude-code-builtin) that flows through the tool_result path emits `agent.tool_call.failed {tool_name: null, ...}`. The continuation note's reading that "this is a penumbra-vs-ha shape mismatch in claude-agent-acp" is **incorrect** at the ACP/stdio-acp layer.

## So why does ha_pulse "work" and chain_start_simple "fail"?

The signal that differs between the two paths must be upstream of `status: failed`. Two possibilities (cannot disambiguate without wire trace):

**Hypothesis 1 — chain_start_simple's tool invocation fails inside penumbra-mcp's handler.**
- claude SDK calls the penumbra MCP server's `tools/call` for `chain_start_simple`
- penumbra-mcp's handler does `daemon.startChain(body)` (chain-start.ts:100)
- The daemon may reject the call (4xx/5xx, network, auth, schema validation, registry lookup miss)
- The MCP server returns a tool_result with `is_error: true`
- claude-agent-acp emits `status: "failed"`
- penumbra's stdio-acp captures `tool_name: null` per the structural reason above

**Hypothesis 2 — the model is not actually emitting a chain_start_simple tool_use, and claude SDK synthesizes a tool_use+is_error pair from malformed model output.**
- Qwen3-8B with `--jinja` may emit text that *looks* like a tool call but fails the SDK's name-validation
- Claude SDK might inject a synthetic tool_use chunk to surface the parse failure
- This would also produce `status: "failed"` via the same code path

The two are distinguishable by:
- Whether the penumbra MCP server logs any `tools/call` invocation for chain_start_simple
- Whether the proxy at `mcp-allowlist-proxy.ts` ever sees the call (its stderr inherits to claude-agent-acp's stderr)
- Whether `daemon.startChain` is invoked (penumbra-mcp's stderr)

## Concrete trace plan for next on-LAN session

1. **Bring up Qwen3-8B :8090 with `--verbose`**. Edit `templates/workloads/qwen3-8b-mac-mini.yaml`'s extraArgs to add `--verbose`. `llamactl --node mac-mini apply -f ...` + `llamactl --node mac-mini server logs --name qwen3-8b-mac-mini --follow > /tmp/qwen-verbose.log`.

2. **Tee mcp-allowlist-proxy stderr**. The proxy inherits stderr from claude-agent-acp; capture claude-agent-acp's stderr separately by wrapping it in a shell launcher that tees to a file. (Or instrument mcp-allowlist-proxy.ts to log every tools/call passing through.)

3. **Two-tick differential**:
   - Tick A (chain_start_simple): home-mgmt is paused with the pending_goal already in working_memory. Resume + manual tick.
   - Tick B (ha_pulse): clear pending_goals via `long_lived_state_set`, manual tick → standard standing_brief path.

4. **Compare these specific signals**:
   - llama-server `/v1/messages` request body (does it include the chain_start_simple tool definition?)
   - llama-server response: tool_use chunk with name="mcp__penumbra__chain_start_simple" vs name="mcp__ha__ha_pulse"
   - mcp-allowlist-proxy stderr: any "tool not in allowlist" rejections? Any tools/call passing through?
   - penumbra-mcp stderr (if reachable): is `chain_start_simple` invoked? With what input?
   - claude-agent-acp stderr: `Got a tool result for tool use that wasn't tracked: <id>`?

5. **Diagnose**:
   - If penumbra-mcp NEVER sees chain_start_simple → it's an upstream rejection (likely Hypothesis 2 or proxy mismatch)
   - If penumbra-mcp sees it AND `daemon.startChain` returns 4xx → it's a daemon/registry issue
   - If `daemon.startChain` returns 200 but chain_start_simple's wrapper double-wraps `task_class` → contract bug
   - If model emits no tool_use at all → llama.cpp `--jinja` grammar issue for this tool name

## Independent bug-of-its-own: penumbra stdio-acp loses tool_name

Whatever the upstream cause, **penumbra's stdio-acp.ts should cache `toolCallId → title` at `tool_call` time** so that failed updates resolve to a useful tool_name in the lifecycle event. The current code at line 706 makes every tool failure look identical in dispatch_events. This is independent of the parser-bug investigation but would land cleanly.

Patch sketch:
```ts
// near the per-prompt locals where accumulatedText lives:
const toolNameById = new Map<string, string>();

case 'tool_call': {
  if (typeof update.title === 'string') toolNameById.set(update.toolCallId, update.title);
  // ... existing capturePort emit
}

case 'tool_call_update': {
  // ... existing emit ...
  if (update.status === 'failed') {
    emitLifecycle(input, 'agent.tool_call.failed', {
      tool_name:
        (typeof update.title === 'string' && update.title) ||
        (typeof update.kind === 'string' && update.kind) ||
        toolNameById.get(update.toolCallId) ||
        null,
      // ...
    });
  }
}
```

This converts every `tool_name: null` we've been seeing in 2026-05-13..15 dispatch_events into "mcp__penumbra__chain_start_simple" / "mcp__ha__ha_pulse" / etc., which dramatically tightens the next round of failure triage.
