/**
 * Beacon P0 — foundations verification flow. Drives the Electron app
 * through electron-mcp-server, confirms:
 *
 *   1. Default first-launch theme is Sirius.
 *      - <html data-theme="sirius">
 *      - body background = rgb(12, 12, 15)  (= #0c0c0f = Sirius surface-0)
 *      - body font-family contains "Inter"
 *   2. Google Fonts stylesheet <link> is present in <head>.
 *   3. Every Beacon theme family paints its expected surface-0 / brand.
 *      Covers Sirius, Ember, Clinical, Scrubs by seeding
 *      localStorage.beacon-theme and reloading.
 *   4. Legacy migration: seeding localStorage.llamactl-theme with each
 *      legacy id ("glass", "neon", "ops") routes to the correct Beacon
 *      family, clears the legacy key, and sets beacon-theme.scanlines
 *      only for the "neon" case.
 *
 * This is a pure-DOM flow — it never clicks a theme picker; all theme
 * switches happen via localStorage + reload, which exercises the
 * theme-store migration path AND the ThemeProvider reactive render on
 * each load.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup. Requires a
 * built llamactl Electron bundle (out/main/index.cjs) and a
 * electron-mcp-server checkout reachable through ELECTRON_MCP_DIR (or
 * sibling of the llamactl repo root).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpClient {
  private seq = 1;
  private pending = new Map<number, (res: JsonRpcResponse) => void>();
  private readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  constructor(proc: ChildProcessByStdio<Writable, Readable, null>) {
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const frame = JSON.parse(line) as JsonRpcResponse;
        const cb = this.pending.get(frame.id as number);
        if (cb) {
          this.pending.delete(frame.id as number);
          cb(frame);
        }
      } catch {
        /* skip */
      }
    });
  }
  async call(tool: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.seq++;
    const res = await new Promise<JsonRpcResponse>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout ${tool}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolveP(r);
      });
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }) + '\n',
      );
    });
    if (res.error) throw new Error(`${tool} → ${res.error.message}`);
    const envelope = res.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const text = envelope?.content?.[0]?.text ?? '';
    if (envelope?.isError) throw new Error(`${tool} → ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  initialize(): Promise<JsonRpcResponse> {
    const id = this.seq++;
    return new Promise((resolveP) => {
      this.pending.set(id, (r) => resolveP(r));
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'beacon-p0-verify', version: '0.0.1' },
          },
        }) + '\n',
      );
    });
  }
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

interface DriverArgs {
  executable: string;
  execArgs: string[];
  env: Record<string, string>;
  userDataDir?: string;
}

function parseArgs(argv: string[]): DriverArgs {
  let executable: string | undefined;
  let execArgs: string[] = [];
  const env: Record<string, string> = {};
  let userDataDir: string | undefined;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--executable=')) executable = a.slice('--executable='.length);
    else if (a.startsWith('--args=')) execArgs = a.slice('--args='.length).split(' ').filter(Boolean);
    else if (a.startsWith('--env=')) {
      const kv = a.slice('--env='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--userDataDir=')) {
      userDataDir = a.slice('--userDataDir='.length);
    }
  }
  if (!executable) throw new Error('--executable required');
  const out: DriverArgs = { executable, execArgs, env };
  if (userDataDir !== undefined) out.userDataDir = userDataDir;
  return out;
}

function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

function resolveServerScript(here: string): string {
  const explicit = process.env.ELECTRON_MCP_DIR;
  if (explicit && explicit.length > 0) {
    return resolve(explicit, 'dist', 'server', 'index.js');
  }
  return resolve(here, '..', '..', '..', 'electron-mcp-server', 'dist', 'server', 'index.js');
}

/** Expected computed background-color per theme (as `rgb(r, g, b)`). */
const EXPECTED_BG: Record<string, string> = {
  sirius: 'rgb(12, 12, 15)',
  ember: 'rgb(10, 10, 8)',
  clinical: 'rgb(250, 249, 247)',
  scrubs: 'rgb(7, 19, 15)',
};

/** Expected computed brand color per theme (reading --color-brand). */
const EXPECTED_BRAND: Record<string, string> = {
  sirius: 'rgb(99, 102, 241)',
  ember: 'rgb(245, 158, 11)',
  clinical: 'rgb(37, 99, 235)',
  scrubs: 'rgb(20, 184, 166)',
};

/** Expected raw --color-surface-0 value per theme (as declared in tokens.css). */
const EXPECTED_TOKEN: Record<string, string> = {
  sirius: '#0c0c0f',
  ember: '#0a0a08',
  clinical: '#faf9f7',
  scrubs: '#07130f',
};

interface ThemeProbe {
  dataTheme: string;
  bodyBg: string;
  htmlBg: string;
  surfaceVar: string;
  brand: string;
  fontFamily: string;
  bodyClass: string;
}

async function probeTheme(client: McpClient, sessionId: string): Promise<ThemeProbe> {
  const res = (await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `JSON.stringify({
      dataTheme: document.documentElement.dataset.theme || '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      surfaceVar: getComputedStyle(document.documentElement).getPropertyValue('--color-surface-0').trim(),
      brand: getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim(),
      fontFamily: getComputedStyle(document.body).fontFamily,
      bodyClass: document.body.className,
    })`,
  })) as { result: string };
  return JSON.parse(res.result) as ThemeProbe;
}

/** Convert a CSS hex like "#6366f1" to "rgb(99, 102, 241)". */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

async function waitReady(client: McpClient, sessionId: string): Promise<void> {
  await client.call('electron_wait_for_window', { sessionId, index: 0, timeoutMs: 30_000 });
  await client.call('electron_wait_for_selector', {
    sessionId,
    selector: 'html[data-theme]',
    state: 'attached',
    timeout: 10_000,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const serverScript = resolveServerScript(here);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ELECTRON_MCP_LOG_LEVEL = env.ELECTRON_MCP_LOG_LEVEL ?? 'warn';
  const nodeBin = process.env.MCP_NODE ?? 'node';
  const proc = spawn(nodeBin, [serverScript], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const client = new McpClient(proc);

  try {
    await client.initialize();
    const launchArgs: Record<string, unknown> = {
      executablePath: args.executable,
      args: args.execArgs,
    };
    if (Object.keys(args.env).length > 0) launchArgs.env = args.env;
    if (args.userDataDir !== undefined) launchArgs.userDataDir = args.userDataDir;
    const launch = (await client.call('electron_launch', launchArgs, 60_000)) as {
      sessionId?: string;
    };
    const sessionId = launch.sessionId;
    if (!sessionId) throw new Error('launch failed');
    await waitReady(client, sessionId);

    // --- Fresh-launch Sirius defaults -------------------------------------
    const fresh = await probeTheme(client, sessionId);
    check(
      'first-launch data-theme=sirius',
      fresh.dataTheme === 'sirius',
      `got=${fresh.dataTheme}`,
    );
    check(
      'first-launch body background = Sirius surface-0',
      fresh.bodyBg === EXPECTED_BG.sirius,
      `got=${fresh.bodyBg}`,
    );
    check(
      'first-launch --color-brand = Sirius indigo',
      fresh.brand === EXPECTED_BRAND.sirius || fresh.brand === '#6366f1',
      `got=${fresh.brand}`,
    );
    check(
      'first-launch font-family includes Inter',
      /Inter/.test(fresh.fontFamily),
      `got=${fresh.fontFamily}`,
    );

    // Google Fonts link tag presence.
    const fontsLink = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `JSON.stringify(Array.from(document.querySelectorAll("link[rel='stylesheet']")).map(l => l.getAttribute('href')).filter(h => h && h.includes('fonts.googleapis.com')))`,
    })) as { result: string };
    const fontLinks = JSON.parse(fontsLink.result) as string[];
    check(
      'Google Fonts <link> present',
      fontLinks.length === 1 && fontLinks[0]!.includes('Inter') && fontLinks[0]!.includes('JetBrains+Mono'),
      `hrefs=${JSON.stringify(fontLinks)}`,
    );

    // --- Cycle through all four theme families ----------------------------
    for (const themeId of ['ember', 'clinical', 'scrubs', 'sirius'] as const) {
      await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `(() => {
          localStorage.setItem('beacon-theme', JSON.stringify({ state: { themeId: '${themeId}', scanlines: false }, version: 1 }));
          location.reload();
          return 'reloaded';
        })()`,
      });
      // Reload invalidates the session's render frame; wait for re-ready.
      await waitReady(client, sessionId);
      const probe = await probeTheme(client, sessionId);
      check(
        `[${themeId}] data-theme`,
        probe.dataTheme === themeId,
        `got=${probe.dataTheme}`,
      );
      check(
        `[${themeId}] --color-surface-0 token`,
        probe.surfaceVar === EXPECTED_TOKEN[themeId],
        `got=${probe.surfaceVar} expected=${EXPECTED_TOKEN[themeId]}`,
      );
      check(
        `[${themeId}] body background`,
        probe.bodyBg === EXPECTED_BG[themeId],
        `got=${probe.bodyBg} expected=${EXPECTED_BG[themeId]} htmlBg=${probe.htmlBg} bodyClass="${probe.bodyClass}"`,
      );
      const brandHex = probe.brand.startsWith('#') ? hexToRgb(probe.brand) : probe.brand;
      check(
        `[${themeId}] --color-brand`,
        brandHex === EXPECTED_BRAND[themeId],
        `got=${probe.brand} expected=${EXPECTED_BRAND[themeId]}`,
      );
    }

    // --- Legacy migration cases -------------------------------------------
    // Each case: seed llamactl-theme, clear beacon-theme, reload, assert.
    interface MigCase {
      legacyId: string;
      expectTheme: string;
      expectScanlines: boolean;
    }
    const MIG_CASES: MigCase[] = [
      { legacyId: 'glass', expectTheme: 'sirius', expectScanlines: false },
      { legacyId: 'neon', expectTheme: 'sirius', expectScanlines: true },
      { legacyId: 'ops', expectTheme: 'scrubs', expectScanlines: false },
    ];
    for (const c of MIG_CASES) {
      await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `(() => {
          localStorage.removeItem('beacon-theme');
          localStorage.setItem('llamactl-theme', JSON.stringify({ state: { themeId: '${c.legacyId}' }, version: 0 }));
          location.reload();
          return 'seeded';
        })()`,
      });
      await waitReady(client, sessionId);
      const snap = (await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `JSON.stringify({
          legacyGone: localStorage.getItem('llamactl-theme') === null,
          beaconRaw: localStorage.getItem('beacon-theme'),
          dataTheme: document.documentElement.dataset.theme || '',
        })`,
      })) as { result: string };
      const s = JSON.parse(snap.result) as {
        legacyGone: boolean;
        beaconRaw: string | null;
        dataTheme: string;
      };
      check(
        `legacy ${c.legacyId} → llamactl-theme removed`,
        s.legacyGone,
        `present=${!s.legacyGone}`,
      );
      const beacon = s.beaconRaw
        ? (JSON.parse(s.beaconRaw) as { state?: { themeId?: string; scanlines?: boolean } })
        : null;
      check(
        `legacy ${c.legacyId} → beacon-theme.state.themeId = ${c.expectTheme}`,
        beacon?.state?.themeId === c.expectTheme,
        `got=${beacon?.state?.themeId}`,
      );
      check(
        `legacy ${c.legacyId} → beacon-theme.state.scanlines = ${c.expectScanlines}`,
        (beacon?.state?.scanlines ?? false) === c.expectScanlines,
        `got=${beacon?.state?.scanlines}`,
      );
      check(
        `legacy ${c.legacyId} → html data-theme = ${c.expectTheme}`,
        s.dataTheme === c.expectTheme,
        `got=${s.dataTheme}`,
      );
    }

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1 ? 'FAIL — see above' : 'PASS — Beacon P0 verification green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
