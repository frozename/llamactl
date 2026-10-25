// A simulated host for `llamactl update` tests: a linear git history, systemd
// --user units (or launchd jobs), a controller log, model-host and agent HTTP
// endpoints, and a fake clock — all behind the command's injected deps. No
// real git, systemctl, launchctl, network or filesystem is touched.
import {
  type ExecOptions,
  type ExecResult,
  EXIT_ABORTED,
  type HttpOptions,
  type HttpResponse,
  type LockHandle,
  type ManagedHost,
  type UpdateDeps,
} from "../src/commands/update/deps.js";

export const REPO = "/srv/llamactl";
export const BUN = "/opt/bun/bin/bun";
export const ENTRY = `${REPO}/packages/cli/src/bin.ts`;
export const STATE = "/srv/state";
export const CONTROLLER_LOG = `${STATE}/logs/llamactl-controller.log`;
export const ENV_FILE = "/srv/llamactl.env";
export const AGENT_DIR = `${STATE}/agent`;
export const CONTROLLER_UNIT = "llamactl-controller.service";
export const AGENT_UNIT = "llamactl-agent.service";
export const UNIT_CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice";

export const sha = (n: number): string => n.toString(16).repeat(40).slice(0, 40);

export interface FakeUnit {
  loaded: boolean;
  active: boolean;
  pid: number;
  argv: string[];
  killMode: string;
  cgroup: string;
  standardOutput: string | null;
  environmentFile: string | null;
  plistPath?: string | null;
  /** launchd: `launchctl print` calls showing `state = xpcproxy` after each bootstrap/kickstart. */
  spawnPrints?: number;
  /** launchd: xpcproxy prints left; set to Infinity for a job that never finishes spawning. */
  spawnRemaining?: number;
}

export interface FakeHost extends ManagedHost {
  ready: boolean;
  idle: "busy" | "idle";
}

export interface World {
  /** Linear history, oldest first. */
  commits: string[];
  head: string;
  branch: string | null;
  branches: Map<string, string>;
  originMain: string;
  dirty: string[];
  /** Files changed between two commits, keyed `${older}..${newer}`. */
  diffs: Map<string, string[]>;
  ciJson: string | null;
  haveGh: boolean;
  missingBins: Set<string>;
  platform: NodeJS.Platform;
  units: Map<string, FakeUnit>;
  hosts: FakeHost[];
  manifests: Set<string>;
  files: Map<string, string>;
  controllerLog: string;
  agentHealthy: boolean;
  clock: number;
  /** Every argv exec'd, in order. */
  calls: string[][];
  /** Mutating actions only, in order. */
  events: string[];
  installExit: number;
  installRuns?: number;
  /** ExecOptions each install ran with. */
  installOpts: ExecOptions[];
  /** Called on every controller start; default reports every manifest host unchanged. */
  onControllerStart: (w: World) => void;
  /** Called on every agent restart; default leaves the agent healthy. */
  onAgentRestart: (w: World) => void;
  /** Called when bun install starts (e.g. to deliver a signal mid-install). */
  onInstall: (w: World) => void;
  /** Exit code of the install the n-th time it runs (default `installExit`). */
  installExits: number[];
  /** `git switch` to any of these targets fails as if .git/index.lock were stale. */
  switchFailures: Set<string>;
  /** The heavy-job lock is free (else acquireLock times out). */
  lockFree: boolean;
  /** Lock acquisitions in a rollback succeed only while this is true. */
  lockFreeAfterFirst: boolean;
  lockAcquisitions: number;
  /** The handler the command registered for SIGINT/SIGTERM, while registered. */
  signalHandler: ((sig: NodeJS.Signals) => void) | null;
  launchd: boolean;
}

export function defaultControllerStart(w: World): void {
  const lines = [`controller started pid=4242 workloads=${STATE}/workloads cfg=${STATE}/config`];
  lines.push(`controller: source-staleness reload ARMED at ${w.head}`);
  for (const h of w.hosts) {
    if (w.manifests.has(h.name))
      lines.push(`[2026-10-21T21:00:00.000Z] modelhost/${h.name} on local: unchanged`);
  }
  if (w.hosts.length === 0)
    lines.push(`[2026-10-21T21:00:00.000Z] idle (no manifests in ${STATE}/workloads)`);
  w.controllerLog += `${lines.join("\n")}\n`;
}

export function makeWorld(over: Partial<World> = {}): World {
  const commits = [sha(1), sha(2), sha(3), sha(4)];
  const w: World = {
    commits,
    head: sha(1),
    branch: "feat/strata-engine",
    branches: new Map([
      ["feat/strata-engine", sha(1)],
      ["main", sha(1)],
    ]),
    originMain: sha(4),
    dirty: [],
    diffs: new Map([
      [
        `${sha(1)}..${sha(4)}`,
        ["bun.lock", "packages/cli/package.json", "packages/cli/src/bin.ts"],
      ],
    ]),
    ciJson: JSON.stringify([{ status: "completed", conclusion: "success" }]),
    haveGh: true,
    missingBins: new Set(),
    platform: "linux",
    units: new Map([
      [
        CONTROLLER_UNIT,
        {
          loaded: true,
          active: true,
          pid: 1001,
          argv: [BUN, ENTRY, "controller", "serve", "--interval=10"],
          killMode: "process",
          cgroup: `${UNIT_CGROUP}/${CONTROLLER_UNIT}`,
          standardOutput: `append:${CONTROLLER_LOG}`,
          environmentFile: ENV_FILE,
        },
      ],
      [
        AGENT_UNIT,
        {
          loaded: true,
          active: true,
          pid: 1002,
          argv: [BUN, ENTRY, "agent", "serve", `--dir=${AGENT_DIR}`],
          killMode: "process",
          cgroup: `${UNIT_CGROUP}/${AGENT_UNIT}`,
          standardOutput: null,
          environmentFile: ENV_FILE,
        },
      ],
    ]),
    hosts: [
      {
        name: "seat",
        kind: "ModelHost",
        pid: 2039339,
        host: "127.0.0.1",
        port: 18080,
        ready: true,
        idle: "idle",
      },
    ],
    manifests: new Set(["seat"]),
    files: new Map([
      [
        ENV_FILE,
        `# pinned state\nDEV_STORAGE=${STATE}\nLOCAL_AI_RUNTIME_DIR=${STATE}/runtime\nLLAMACTL_WORKLOADS_DIR=${STATE}/workloads\n`,
      ],
      [
        `${AGENT_DIR}/agent.yaml`,
        "apiVersion: llamactl/v1\nkind: AgentConfig\nbindHost: 127.0.0.1\nport: 17843\n",
      ],
      ["/proc/self/cgroup", "0::/user.slice/user-1000.slice/session-2.scope\n"],
      ["/proc/2039339/cgroup", `0::${UNIT_CGROUP}/${CONTROLLER_UNIT}\n`],
      // The seat was spawned by the controller, so it lives in the controller's cgroup.
      [`/sys/fs/cgroup${UNIT_CGROUP}/${CONTROLLER_UNIT}/cgroup.procs`, "1001\n2039339\n"],
      [`/sys/fs/cgroup${UNIT_CGROUP}/${AGENT_UNIT}/cgroup.procs`, "1002\n"],
    ]),
    controllerLog: "[2026-10-21T20:00:00.000Z] modelhost/seat on local: unchanged\n",
    agentHealthy: true,
    clock: Date.parse("2026-10-21T21:00:00.000Z"),
    calls: [],
    events: [],
    installExit: 0,
    installOpts: [],
    onControllerStart: defaultControllerStart,
    onAgentRestart: () => undefined,
    onInstall: () => undefined,
    installExits: [],
    switchFailures: new Set(),
    lockFree: true,
    lockFreeAfterFirst: true,
    lockAcquisitions: 0,
    signalHandler: null,
    launchd: false,
    ...over,
  };
  return w;
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr = "fail", code = 1): ExecResult => ({ code, stdout: "", stderr });

function idx(w: World, rev: string): number {
  return w.commits.findIndex((c) => c === rev || (rev.length >= 7 && c.startsWith(rev)));
}

function resolveRev(w: World, rev: string): string | null {
  const r = rev.replace(/\^\{commit\}$/, "");
  if (r === "HEAD") return w.head;
  if (r === "origin/main") return w.originMain;
  if (r.startsWith("refs/heads/")) return w.branches.get(r.slice("refs/heads/".length)) ?? null;
  if (w.branches.has(r)) return w.branches.get(r) ?? null;
  const i = idx(w, r);
  return i >= 0 ? (w.commits[i] ?? null) : null;
}

const INDEX_LOCK = `fatal: Unable to create '${REPO}/.git/index.lock': File exists.`;

function gitSwitch(w: World, args: string[]): ExecResult {
  const rest = args.filter((a) => a !== "--quiet");
  const target = rest.at(-1) ?? "";
  if (w.switchFailures.has(target) || w.switchFailures.has(w.branches.get(target) ?? "")) {
    w.events.push(`switch FAILED ${target}`);
    return no(INDEX_LOCK, 128);
  }
  if (rest[0] === "-C") {
    const [, name, target] = rest;
    if (name === undefined || target === undefined) return no();
    w.branches.set(name, target);
    w.head = target;
    w.branch = name;
    w.events.push(`switch -C ${name} ${target}`);
    return ok();
  }
  if (rest[0] === "--detach") {
    w.head = rest[1] ?? "";
    w.branch = null;
    w.events.push(`switch --detach ${w.head}`);
    return ok();
  }
  const name = rest[0] ?? "";
  const tip = w.branches.get(name);
  if (tip === undefined) return no(`invalid reference: ${name}`);
  w.head = tip;
  w.branch = name;
  w.events.push(`switch ${name}`);
  return ok();
}

function git(w: World, args: string[]): ExecResult {
  const [cmd = "", ...rest] = args;
  switch (cmd) {
    case "fetch":
      return ok();
    case "rev-parse": {
      const rev = rest.filter((a) => !a.startsWith("--")).at(-1) ?? "";
      const out = resolveRev(w, rev);
      return out === null ? no("unknown revision") : ok(`${out}\n`);
    }
    case "symbolic-ref":
      return w.branch === null ? no("not a symbolic ref") : ok(`${w.branch}\n`);
    case "status":
      return ok(w.dirty.map((d) => `${d}\n`).join(""));
    case "merge-base": {
      const [, a = "", b = ""] = rest;
      return idx(w, a) <= idx(w, b) ? ok() : no("", 1);
    }
    case "rev-list": {
      const [from = "", to = ""] = (rest.at(-1) ?? "").split("..");
      return ok(`${String(Math.max(0, idx(w, to) - idx(w, from)))}\n`);
    }
    case "log": {
      const [from = "", to = ""] = (rest.at(-1) ?? "").split("..");
      const between = w.commits.slice(idx(w, from) + 1, idx(w, to) + 1).reverse();
      return ok(between.map((c) => `${c}\tcommit ${c.slice(0, 7)}`).join("\n"));
    }
    case "diff": {
      const [, a = "", b = ""] = rest;
      const files = w.diffs.get(`${a}..${b}`) ?? w.diffs.get(`${b}..${a}`) ?? [];
      return ok(files.join("\n"));
    }
    case "remote":
      return ok("https://github.com/frozename/llamactl.git\n");
    case "switch":
      return gitSwitch(w, rest);
    case "branch":
      return ok();
    default:
      return no(`unexpected git ${args.join(" ")}`);
  }
}

function showUnit(w: World, name: string): ExecResult {
  const u = w.units.get(name);
  if (!u?.loaded) return ok(`Id=${name}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\n`);
  const exec = `{ path=${u.argv[0] ?? ""} ; argv[]=${u.argv.join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=${String(u.pid)} ; code=(null) ; status=0/0 }`;
  return ok(
    [
      `MainPID=${u.active ? String(u.pid) : "0"}`,
      `ExecStart=${exec}`,
      `ControlGroup=${u.cgroup}`,
      `KillMode=${u.killMode}`,
      "Environment=",
      ...(u.environmentFile === null
        ? []
        : [`EnvironmentFiles=${u.environmentFile} (ignore_errors=no)`]),
      `Id=${name}`,
      "LoadState=loaded",
      `ActiveState=${u.active ? "active" : "inactive"}`,
    ].join("\n"),
  );
}

function catUnit(w: World, name: string): ExecResult {
  const u = w.units.get(name);
  if (u === undefined) return no("No files found");
  const lines = [
    `# /home/u/.config/systemd/user/${name}`,
    "[Unit]",
    "Description=test",
    "",
    "[Service]",
    "Type=simple",
  ];
  if (u.environmentFile !== null) lines.push(`EnvironmentFile=${u.environmentFile}`);
  lines.push(`ExecStart=${u.argv.join(" ")}`, `KillMode=${u.killMode}`);
  if (u.standardOutput !== null) lines.push(`StandardOutput=${u.standardOutput}`);
  return ok(lines.join("\n"));
}

function unitAction(w: World, action: string, name: string): ExecResult {
  const u = w.units.get(name);
  if (!u?.loaded) return no(`Unit ${name} not found.`, 5);
  w.events.push(`${action} ${name}`);
  if (action === "stop") u.active = false;
  else {
    u.active = true;
    if (name === CONTROLLER_UNIT) w.onControllerStart(w);
    if (name === AGENT_UNIT && action === "restart") w.onAgentRestart(w);
  }
  return ok();
}

function systemctl(w: World, args: string[]): ExecResult {
  const [cmd = "", ...rest] = args;
  const name = rest.find((a) => a.endsWith(".service")) ?? "";
  switch (cmd) {
    case "show":
      return showUnit(w, name);
    case "cat":
      return catUnit(w, name);
    case "is-active":
      return w.units.get(name)?.active === true ? ok() : no("inactive", 3);
    case "stop":
    case "start":
    case "restart":
      return unitAction(w, cmd, name);
    default:
      return no(`unexpected systemctl ${args.join(" ")}`);
  }
}

function launchdName(w: World, args: readonly string[], prefix: string): string {
  const [cmd, a1 = "", a2 = ""] = args;
  if (cmd === "bootstrap")
    return [...w.units.entries()].find(([, u]) => u.plistPath === a2)?.[0] ?? "";
  return (cmd === "kickstart" ? a2 : a1).slice(prefix.length);
}

function launchdState(u: FakeUnit): string {
  if (u.spawnRemaining !== undefined && u.spawnRemaining > 0) {
    u.spawnRemaining -= 1;
    return "xpcproxy";
  }
  return u.active ? "running" : "not running";
}

function launchdPrint(name: string, u: FakeUnit, prefix: string): ExecResult {
  const args = u.argv.map((a) => `\t\t${a}`).join("\n");
  return ok(
    [
      `${prefix}${name} = {`,
      "\tactive count = 1",
      `\tpath = ${u.plistPath ?? ""}`,
      "\ttype = LaunchAgent",
      `\tstate = ${launchdState(u)}`,
      "",
      `\tprogram = ${u.argv[0] ?? ""}`,
      "\targuments = {",
      args,
      "\t}",
      "",
      `\tstdout path = ${u.standardOutput ?? ""}`,
      "\tenvironment = {",
      `\t\tDEV_STORAGE => ${STATE}`,
      "\t}",
      "",
      `\tpid = ${String(u.pid)}`,
      "}",
    ].join("\n"),
  );
}

function launchdAction(w: World, cmd: string, name: string, u: FakeUnit): ExecResult {
  w.events.push(`${cmd} ${name}`);
  u.loaded = cmd !== "bootout";
  u.active = cmd !== "bootout";
  u.spawnRemaining = cmd === "bootout" ? 0 : (u.spawnPrints ?? 0);
  if (cmd === "bootstrap" && name === "com.llamactl.controller") w.onControllerStart(w);
  if (cmd === "kickstart" && name === "com.llamactl.agent") w.onAgentRestart(w);
  return ok();
}

function launchctl(w: World, args: string[], uid: number): ExecResult {
  const prefix = `gui/${String(uid)}/`;
  const cmd = args[0] ?? "";
  const name = launchdName(w, args, prefix);
  const u = w.units.get(name);
  if (cmd === "print")
    return u?.loaded === true ? launchdPrint(name, u, prefix) : no("Could not find service", 113);
  if (!["bootout", "bootstrap", "kickstart"].includes(cmd))
    return no(`unexpected launchctl ${args.join(" ")}`);
  return u === undefined ? no("Could not find service", 113) : launchdAction(w, cmd, name, u);
}

function isInstall(argv: readonly string[]): boolean {
  return argv.includes("install") && argv.includes("--frozen-lockfile");
}

function route(w: World, a: string[], uid: number): ExecResult | null {
  const [bin, ...rest] = a;
  if (bin === "git" && rest[0] === "-C" && rest[1] === REPO) return git(w, rest.slice(2));
  if (bin === "systemctl" && rest[0] === "--user") return systemctl(w, rest.slice(1));
  if (bin === "launchctl") return launchctl(w, rest, uid);
  if (bin === "journalctl") return no("no journal in tests");
  if (bin === "gh") return w.ciJson === null ? no("gh: not logged in") : ok(w.ciJson);
  if (bin === "ps") return ok("1\n");
  return null;
}

function install(w: World, a: string[], opts: ExecOptions | undefined): ExecResult {
  w.events.push(`install ${a.join(" ")}`);
  w.installRuns = (w.installRuns ?? 0) + 1;
  w.onInstall(w);
  if (opts?.signal?.aborted === true) return no("bun install aborted; killed", EXIT_ABORTED);
  const exit = w.installExits[w.installRuns - 1] ?? w.installExit;
  return exit === 0 ? ok() : no("error: lockfile had changes", exit);
}

export function fakeExec(
  w: World,
  uid = 501,
): (argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult> {
  return (argv, opts) => {
    const a = [...argv];
    w.calls.push(a);
    if (isInstall(a)) {
      w.installOpts.push(opts ?? {});
      return Promise.resolve(install(w, a, opts));
    }
    const result = route(w, a, uid);
    return result === null
      ? Promise.reject(new Error(`unexpected exec in test: ${a.join(" ")}`))
      : Promise.resolve(result);
  };
}

function hostFor(w: World, url: URL): FakeHost | undefined {
  return w.hosts.find((h) => url.hostname === h.host && Number(url.port) === h.port);
}

export function fakeHttpGet(
  w: World,
): (url: string, opts: HttpOptions) => Promise<HttpResponse | null> {
  return (url) => {
    const u = new URL(url);
    if (u.protocol === "https:") {
      if (!w.agentHealthy) return Promise.resolve(null);
      if (u.pathname === "/healthz") return Promise.resolve({ status: 200, body: "ok" });
      if (u.pathname === "/trpc/inferenceRpc.negotiate") {
        return Promise.resolve({
          status: 200,
          body: '{"result":{"data":{"outcome":"not-advertised"}}}',
        });
      }
      return Promise.resolve({ status: 404, body: "" });
    }
    const host = hostFor(w, u);
    if (host === undefined) return Promise.resolve(null);
    if (u.pathname === "/v1/models") {
      return Promise.resolve(
        host.ready ? { status: 200, body: '{"data":[{"id":"m"}]}' } : { status: 503, body: "" },
      );
    }
    if (u.pathname === "/metrics") {
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ live: { state: host.idle, queued: 0 } }),
      });
    }
    return Promise.resolve({ status: 404, body: "" });
  };
}

export interface Captured {
  log: string[];
  stdout: string;
  stderr: string;
}

export function fakeDeps(
  w: World,
  over: Partial<UpdateDeps> = {},
): { deps: Partial<UpdateDeps>; out: Captured } {
  const out: Captured = { log: [], stdout: "", stderr: "" };
  const deps: Partial<UpdateDeps> = {
    exec: fakeExec(w),
    httpGet: fakeHttpGet(w),
    which: (bin) =>
      w.missingBins.has(bin) || (bin === "gh" && !w.haveGh) ? null : `/usr/bin/${bin}`,
    readFile: (path) => (path === CONTROLLER_LOG ? w.controllerLog : (w.files.get(path) ?? null)),
    readFileFrom: (path, offset) =>
      path === CONTROLLER_LOG ? w.controllerLog.slice(offset) : null,
    fileSize: (path) => {
      if (path === CONTROLLER_LOG) return w.controllerLog.length;
      if (path === `${REPO}/.git`) return 4096;
      const manifest = /\/workloads\/([^/]+)\.yaml$/.exec(path);
      if (manifest?.[1] !== undefined) return w.manifests.has(manifest[1]) ? 100 : null;
      return w.files.has(path) ? (w.files.get(path)?.length ?? 0) : null;
    },
    appendFile: (path, data) => {
      w.files.set(path, (w.files.get(path) ?? "") + data);
    },
    listManagedHosts: () =>
      w.hosts.map(({ name, kind, pid, host, port }) => ({ name, kind, pid, host, port })),
    pid: 777,
    platform: w.platform,
    uid: 501,
    env: { HOME: "/home/u", PATH: "/usr/bin" },
    execPath: "/usr/local/bin/bun-terminal",
    moduleDir: `${REPO}/packages/cli/src/commands/update`,
    now: () => w.clock,
    sleep: (ms) => {
      w.clock += ms;
      return Promise.resolve();
    },
    acquireLock: (path, waitSec): Promise<LockHandle | null> => {
      w.lockAcquisitions += 1;
      const free = w.lockAcquisitions === 1 ? w.lockFree : w.lockFreeAfterFirst;
      if (!free) {
        w.clock += waitSec * 1000;
        w.events.push(`lock TIMEOUT ${path}`);
        return Promise.resolve(null);
      }
      w.events.push(`lock ${path}`);
      let held = true;
      return Promise.resolve({
        release: () => {
          if (held) w.events.push(`unlock ${path}`);
          held = false;
        },
      });
    },
    listDir: (path) =>
      path.endsWith("/workloads") ? [...w.manifests].map((m) => `${m}.yaml`) : null,
    onSignal: (handler) => {
      w.signalHandler = handler;
      return () => {
        w.signalHandler = null;
      };
    },
    log: (line) => {
      out.log.push(line);
    },
    stdout: (chunk) => {
      out.stdout += chunk;
    },
    stderr: (chunk) => {
      out.stderr += chunk;
    },
    ...over,
  };
  return { deps, out };
}

/** The history file the command writes in the simulated host. */
export const HISTORY = `${STATE}/update-history.log`;
