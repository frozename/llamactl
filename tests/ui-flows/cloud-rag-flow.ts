#!/usr/bin/env node
/**
 * Cloud + RAG end-to-end flow through the Electron app. Surfaces
 * validated at the HTTP / CLI layer during Phase 3; this drives
 * the app UI to confirm the same integration surfaces correctly
 * for end users:
 *
 *   1. Nodes module lists the cloud nodes + the rag nodes.
 *   2. Knowledge module renders the embedder panel when a RAG node
 *      is selected.
 *   3. Chat module: new conversation, pick `sirius-gw` + a model
 *      exposed by the gateway, send a prompt, assert a response
 *      lands.
 *
 * Prereqs (matches the rest of the session's live validation):
 *   - `bun run --cwd packages/app build` has run.
 *   - Agent is up at :7843, composite is Ready.
 *   - Keys are in Keychain (openai / anthropic / google) or file refs.
 *   - Native Qwen (:8080) + nomic-embed (:8081) running.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const EMCP = process.env.ELECTRON_MCP_DIR ?? resolve('..', '..', 'electron-mcp-server');
const script = resolve(EMCP, 'dist/server/index.js');
const exe = resolve('packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const appDir = resolve('packages/app');

const proc = spawn(process.env.MCP_NODE ?? 'node', [script], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    ELECTRON_MCP_LOG_LEVEL: 'warn',
    LLAMACTL_TEST_PROFILE: '1',
  },
}) as ChildProcessByStdio<Writable, Readable, null>;

let seq = 1;
const pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
createInterface({ input: proc.stdout }).on('line', (l) => {
  if (!l.trim()) return;
  try {
    const f = JSON.parse(l) as { id: number };
    const cb = pending.get(f.id);
    if (cb) { pending.delete(f.id); cb(f as { result?: unknown; error?: { message: string } }); }
  } catch {}
});

function rpc(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
  const id = seq++;
  return new Promise((res) => {
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function tool(name: string, args: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
  return rpc('tools/call', { name, arguments: args });
}
function unwrap(r: { result?: unknown }): { ok: boolean; result?: unknown; sessionId?: string } {
  const content = (r.result as { content?: Array<{ text?: string }> })?.content;
  if (!content?.[0]?.text) return { ok: false };
  try { return JSON.parse(content[0].text); } catch { return { ok: false }; }
}
async function evalDOM<T = unknown>(sessionId: string, expression: string): Promise<T> {
  const res = unwrap(await tool('electron_evaluate_renderer', { sessionId, expression }));
  return (res as { result?: T }).result as T;
}
async function click(sessionId: string, selector: string): Promise<void> {
  await tool('electron_click', { sessionId, selector });
}
async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const findings: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) console.log(`[PASS] ${msg}`);
  else { console.log(`[FAIL] ${msg}`); findings.push(msg); }
}

async function main(): Promise<void> {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cloud-rag-flow', version: '1' } });
  const launch = unwrap(await tool('electron_launch', { executablePath: exe, args: [appDir] }));
  const sessionId = launch.sessionId;
  if (!sessionId) { console.error('launch failed', launch); process.exit(1); }

  await sleep(1500);

  // === Nodes module ====================================================
  console.log('\n== Nodes module ==');
  await click(sessionId, 'button[aria-label="Nodes"]');
  await sleep(500);
  const nodesState = await evalDOM<{ root: boolean; nodeNames: string[] }>(
    sessionId,
    `(() => {
      var root = document.querySelector('[data-testid="nodes-root"]');
      var prefix = 'node-health-';
      var els = document.querySelectorAll('[data-testid^="node-health-"]');
      var names = [];
      for (var i = 0; i < els.length; i++) {
        var tid = els[i].getAttribute('data-testid') || '';
        names.push(tid.substring(prefix.length));
      }
      return { root: !!root, nodeNames: names };
    })()`,
  );
  check(nodesState?.root, 'Nodes module root renders');
  const expected = ['local', 'sirius-gw', 'openai-direct', 'anthropic-direct', 'gemini-direct', 'kb-chroma', 'kb-pg'];
  for (const name of expected) {
    check(nodesState?.nodeNames?.includes(name), `  Nodes list includes ${name}`);
  }

  // === Knowledge module ================================================
  console.log('\n== Knowledge module ==');
  await click(sessionId, 'button[aria-label="Knowledge"]');
  await sleep(700);
  const knowledge = await evalDOM<{ root: boolean; hasRag: boolean; embedderPanelRendered: boolean }>(
    sessionId,
    `(() => {
      const root = document.querySelector('[data-testid="knowledge-root"]');
      const empty = document.querySelector('[data-testid="knowledge-empty-state"]');
      const panel = document.querySelector('[data-testid="knowledge-embedder-panel"]');
      return { root: !!root, hasRag: !empty, embedderPanelRendered: !!panel };
    })()`,
  );
  check(knowledge?.root, 'Knowledge root renders');
  check(knowledge?.hasRag, '  RAG nodes present (not empty state)');
  check(knowledge?.embedderPanelRendered, '  EmbedderPanel rendered for selected RAG node');

  // === Chat module ====================================================
  console.log('\n== Chat module ==');
  await click(sessionId, 'button[aria-label="Chat"]');
  await sleep(700);
  const chatEmpty = await evalDOM<{ root: boolean; newBtn: boolean }>(
    sessionId,
    `(() => ({
      root: !!document.querySelector('[data-testid="chat-root"]'),
      newBtn: !!document.querySelector('[data-testid="chat-new"]'),
    }))()`,
  );
  check(chatEmpty?.root, 'Chat root renders');
  check(chatEmpty?.newBtn, '  New-chat button present');

  await click(sessionId, '[data-testid="chat-new"]');
  await sleep(800);
  const chatPane = await evalDOM<{ hasPaneA: boolean; nodeOptions: string[]; modelOptions: string[] }>(
    sessionId,
    `(() => {
      const pane = document.querySelector('[data-testid="chat-pane-a"]');
      if (!pane) return { hasPaneA: false, nodeOptions: [], modelOptions: [] };
      const selects = pane.querySelectorAll('header select');
      const nodeOpts = Array.from(selects[0]?.options ?? []).map(o => o.value);
      const modelOpts = Array.from(selects[1]?.options ?? []).map(o => o.value);
      return { hasPaneA: true, nodeOptions: nodeOpts, modelOptions: modelOpts };
    })()`,
  );
  check(chatPane?.hasPaneA, '  Chat pane A appears after New chat');
  check(chatPane?.nodeOptions.includes('sirius-gw'), '  Node picker includes sirius-gw');
  check(chatPane?.nodeOptions.includes('openai-direct'), '  Node picker includes openai-direct');

  // Switch pane A to LOCAL first to isolate whether the chat
  // subscription works for the on-host agent (which we've proved
  // at the CLI layer). A follow-up block swaps to sirius-gw.
  async function pickNode(name: string, waitMs: number): Promise<void> {
    await evalDOM(sessionId as string, `(() => {
      var pane = document.querySelector('[data-testid="chat-pane-a"]');
      var nodeSel = pane.querySelectorAll('header select')[0];
      var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(nodeSel, '${name}');
      nodeSel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(waitMs);
  }
  await pickNode('sirius-gw', 5000);

  const postSwitch = await evalDOM<{ modelOptions: string[] }>(
    sessionId,
    `(() => {
      const pane = document.querySelector('[data-testid="chat-pane-a"]');
      const modelSel = pane.querySelectorAll('header select')[1];
      return { modelOptions: modelSel ? Array.from(modelSel.options).map(o => o.value) : [] };
    })()`,
  );
  check(
    postSwitch?.modelOptions?.some((m) => m === 'gpt-4o-mini' || m === 'claude-haiku-4-5' || m === 'gemini-2.5-flash'),
    `  After switching to sirius-gw, model picker exposes cloud models (got ${postSwitch?.modelOptions?.length ?? 0} options)`,
  );

  // Pick gpt-4o-mini via React-safe setter.
  await evalDOM(sessionId, `(() => {
    var pane = document.querySelector('[data-testid="chat-pane-a"]');
    var modelSel = pane.querySelectorAll('header select')[1];
    var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(modelSel, 'gpt-4o-mini');
    modelSel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  // Fill the textarea via MCP's fill tool (handles React controlled inputs).
  await tool('electron_fill', {
    sessionId,
    selector: 'textarea[placeholder*="Message"]',
    value: 'Reply with just one word: working',
  });
  await sleep(200);
  // Click the form submit button.
  await click(sessionId, 'form button[type="submit"]');

  // Poll the assistant bubble specifically. MessageBubble emits
  // `data-role={role}` on the outer div — filter on that. Require
  // non-placeholder content (more than the bare role header + an
  // ellipsis char, which MessageBubble renders while streaming).
  let assistantText = '';
  let attempts = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    attempts = i + 1;
    const snap = await evalDOM<{ text: string; count: number }>(
      sessionId,
      `(() => {
        var pane = document.querySelector('[data-testid="chat-pane-a"]');
        if (!pane) return { text: '', count: 0 };
        var bubbles = pane.querySelectorAll('[data-role="assistant"]');
        var last = bubbles[bubbles.length - 1];
        if (!last) return { text: '', count: 0 };
        // Drop the role-label span by taking the inner content div.
        var contentDiv = last.querySelectorAll('div')[0];
        return { text: (contentDiv && contentDiv.textContent) || '', count: bubbles.length };
      })()`,
    );
    assistantText = (snap?.text ?? '').trim();
    if (assistantText && assistantText.length >= 3 && assistantText !== '…') break;
  }
  check(
    assistantText.length >= 3 && !/invalid input|expected object|received undefined/i.test(assistantText),
    `  Chat pane got a real assistant response in ${attempts}s (got: "${assistantText.slice(0, 180)}")`,
  );

  await tool('electron_close', { sessionId });
  proc.kill();

  console.log(`\n===== ${findings.length === 0 ? 'PASS' : findings.length + ' FINDING(S)'} =====`);
  for (const f of findings) console.log('  -', f);
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
