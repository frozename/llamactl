import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type {
  CentralHostView,
  HandoverDeps,
  HandoverEngineRecord,
  HandoverLocalHost,
  HandoverOptions,
} from "../src/commands/controller-handover.js";

import { runController } from "../src/commands/controller.js";

type RunControllerHandover = (opts: HandoverOptions, deps: HandoverDeps) => Promise<number>;
type ParseHandoverFlags = (args: string[]) => HandoverOptions | { error: string };
type AdoptionProblem = (
  host: HandoverLocalHost,
  engine: HandoverEngineRecord | null,
  view: CentralHostView,
  opts: Pick<HandoverOptions, "to" | "node">,
) => string | null;

type CentralResponse = CentralHostView | Error;
type CentralScript =
  | CentralHostView
  | CentralResponse[]
  | ((name: string, call: number) => CentralResponse | Promise<CentralResponse>);

interface FakeDepsInput {
  hosts?: HandoverLocalHost[];
  modelRuns?: string[];
  engines?: Record<string, HandoverEngineRecord | null>;
  central?: Record<string, CentralScript> | ((name: string, call: number) => CentralResponse);
  labelFailures?: Record<string, Error>;
  stopResult?: { ok: boolean; detail: string };
}

interface FakeDeps {
  deps: HandoverDeps;
  calls: string[];
  sleeps: number[];
  stdout: string[];
  stderr: string[];
  time: () => number;
}

const BASE_OPTIONS: HandoverOptions = {
  to: "central",
  node: "m4pro",
  timeoutMs: 1000,
  pollMs: 100,
  dryRun: false,
  controllerUnit: null,
};

async function loadHandover(): Promise<Record<string, unknown>> {
  const mod = await import("../src/commands/controller-handover.js").catch(() => ({}));
  expect(typeof (mod as Record<string, unknown>)["runControllerHandover"]).toBe("function");
  return mod;
}

function handoverRunner(mod: Record<string, unknown>): RunControllerHandover {
  const fn = mod["runControllerHandover"];
  expect(typeof fn).toBe("function");
  return fn as RunControllerHandover;
}

function handoverParser(mod: Record<string, unknown>): ParseHandoverFlags {
  const fn = mod["parseHandoverFlags"];
  expect(typeof fn).toBe("function");
  return fn as ParseHandoverFlags;
}

function adoptionProblemOf(mod: Record<string, unknown>): AdoptionProblem {
  const fn = mod["adoptionProblem"];
  expect(typeof fn).toBe("function");
  return fn as AdoptionProblem;
}

function localHost(name: string, overrides: Partial<HandoverLocalHost> = {}): HandoverLocalHost {
  return { name, specHash: "H1", enabled: true, managedBy: null, ...overrides };
}

function centralView(overrides: Partial<CentralHostView> = {}): CentralHostView {
  return {
    found: true,
    node: "m4pro",
    managedBy: null,
    specHash: "H1",
    live: { state: "Running", pid: 4242, specHash: "H1" },
    controllerPid: 777,
    ...overrides,
  };
}

function centralViewWithLive(pid: number): CentralHostView {
  return centralView({ live: { state: "Running", pid, specHash: "H1" } });
}

function makeFakeDeps(input: FakeDepsInput = {}): FakeDeps {
  let t = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const callCounts = new Map<string, number>();
  const queues = new Map<string, CentralResponse[]>();

  const scriptFor = (name: string): CentralScript => {
    if (input.central === undefined) return centralView();
    if (typeof input.central === "function") return input.central;
    return input.central[name] ?? centralView();
  };

  const deps: HandoverDeps = {
    listLocalHosts: () => input.hosts ?? [localHost("a")],
    listLocalModelRuns: () => input.modelRuns ?? [],
    readLocalEngine: (name) => {
      const engines = input.engines ?? { a: { pid: 4242, specHash: "H1" } };
      return engines[name] ?? null;
    },
    queryCentral: async (name) => {
      calls.push(`query:${name}`);
      const call = callCounts.get(name) ?? 0;
      callCounts.set(name, call + 1);
      const script = scriptFor(name);
      let response: CentralResponse;
      if (Array.isArray(script)) {
        let queue = queues.get(name);
        if (queue === undefined) {
          queue = [...script];
          queues.set(name, queue);
        }
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === undefined) throw new Error("empty central script");
        response = next;
      } else if (typeof script === "function") {
        response = await script(name, call);
      } else {
        response = script;
      }
      if (response instanceof Error) throw response;
      return response;
    },
    labelHost: (name, manager) => {
      calls.push(`label:${name}=${manager}`);
      const failure = input.labelFailures?.[name];
      if (failure !== undefined) throw failure;
    },
    unlabelHost: (name) => {
      calls.push(`unlabel:${name}`);
    },
    stopLocalController: () => {
      calls.push("stop");
      return Promise.resolve(input.stopResult ?? { ok: true, detail: "stopped" });
    },
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    stdout: (s) => {
      stdout.push(s);
    },
    stderr: (s) => {
      stderr.push(s);
    },
  };

  return { deps, calls, sleeps, stdout, stderr, time: () => t };
}

function joined(lines: string[]): string {
  return lines.join("\n");
}

function expectNoMutation(calls: string[]): void {
  expect(calls.some((call) => call.startsWith("label:"))).toBe(false);
  expect(calls.some((call) => call.startsWith("unlabel:"))).toBe(false);
  expect(calls).not.toContain("stop");
}

const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("runControllerHandover", () => {
  test("labels every adopted host before stopping the local controller", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      hosts: [localHost("a"), localHost("b")],
      engines: {
        a: { pid: 4242, specHash: "H1" },
        b: { pid: 5252, specHash: "H1" },
      },
      central: {
        a: centralViewWithLive(4242),
        b: centralViewWithLive(5252),
      },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).toBe(0);
    expect(fake.calls).toEqual([
      "query:a",
      "query:b",
      "label:a=central",
      "label:b=central",
      "stop",
    ]);
  });

  test("refuses when central reports a different live pid", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      central: {
        a: centralView({ live: { state: "Running", pid: 9999, specHash: "H1" } }),
      },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("modelhost/a");
    expect(joined(fake.stderr)).toContain("pid");
  });

  test("refuses when central holds a different spec hash", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ central: { a: centralView({ specHash: "H2" }) } });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("spec");
  });

  test("refuses when central does not hold the host", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      central: {
        a: centralView({
          found: false,
          node: null,
          specHash: null,
          live: { error: "not found" },
          controllerPid: 777,
        }),
      },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("a");
    expect(joined(fake.stderr)).toContain("central");
  });

  test("refuses when central has no live controller", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ central: { a: centralView({ controllerPid: null }) } });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("no live controller");
  });

  test("refuses when central's copy is managed by another controller", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ central: { a: centralView({ managedBy: "other" }) } });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("other");
  });

  test("refuses when central's manifest targets a different node", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ central: { a: centralView({ node: "z13" }) } });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("z13");
  });

  test("refuses when central cannot reach this node", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      central: { a: centralView({ live: { error: "ECONNREFUSED" } }) },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expectNoMutation(fake.calls);
    expect(joined(fake.stderr)).toContain("ECONNREFUSED");
  });

  test("treats a central query failure as not yet adopted and retries", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      central: { a: [new Error("central unavailable"), centralView()] },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).toBe(0);
    expect(fake.calls).toEqual(["query:a", "query:a", "label:a=central", "stop"]);
    expect(fake.sleeps).toContain(BASE_OPTIONS.pollMs);
  });

  test("polls until central adoption matches", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      central: {
        a: [centralView({ live: { state: "Running", pid: 9999, specHash: "H1" } }), centralView()],
      },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).toBe(0);
    expect(fake.time()).toBe(BASE_OPTIONS.pollMs);
    expect(fake.calls).toEqual(["query:a", "query:a", "label:a=central", "stop"]);
  });

  test("refuses before central queries while an enabled local ModelRun exists", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ modelRuns: ["run-x"] });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expect(fake.calls).toEqual([]);
    expect(joined(fake.stderr)).toContain("run-x");
  });

  test("rolls back earlier labels when a later label write fails", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      hosts: [localHost("a"), localHost("b")],
      engines: {
        a: { pid: 4242, specHash: "H1" },
        b: { pid: 4242, specHash: "H1" },
      },
      labelFailures: { b: new Error("read-only store") },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expect(fake.calls).toEqual([
      "query:a",
      "query:b",
      "label:a=central",
      "label:b=central",
      "unlabel:a",
    ]);
    expect(fake.calls).not.toContain("stop");
    expect(joined(fake.stderr)).toContain("read-only store");
  });

  test("keeps labels and reports the split brain when stopping the controller fails", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({ stopResult: { ok: false, detail: "bootout failed" } });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).not.toBe(0);
    expect(fake.calls).toEqual(["query:a", "label:a=central", "stop"]);
    expect(fake.calls).not.toContain("unlabel:a");
    expect(joined(fake.stderr)).toContain("handed over");
    expect(joined(fake.stderr)).toContain("still running");
    expect(joined(fake.stderr)).toContain("skip");
  });

  test("dry-run verifies adoption without labeling or stopping", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps();

    const code = await run({ ...BASE_OPTIONS, dryRun: true }, fake.deps);

    expect(code).toBe(0);
    expect(fake.calls).toEqual(["query:a"]);
  });

  test("adopts a down local engine when central holds the same spec stopped", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      engines: { a: null },
      central: {
        a: centralView({ live: { state: "Stopped", pid: null, specHash: null } }),
      },
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).toBe(0);
    expect(fake.calls).toEqual(["query:a", "label:a=central", "stop"]);
  });

  test("verifies but does not relabel central hosts and skips foreign-managed hosts", async () => {
    const mod = await loadHandover();
    const run = handoverRunner(mod);
    const fake = makeFakeDeps({
      hosts: [localHost("a", { managedBy: "central" }), localHost("b", { managedBy: "other" })],
    });

    const code = await run(BASE_OPTIONS, fake.deps);

    expect(code).toBe(0);
    expect(fake.calls).toEqual(["query:a", "stop"]);
    expect(joined(fake.stdout)).toContain("b");
    expect(joined(fake.stdout)).toContain("skipped");
  });
});

describe("adoptionProblem", () => {
  test("returns null for a matching adoption and strings for mismatches", async () => {
    const mod = await loadHandover();
    const adoptionProblem = adoptionProblemOf(mod);
    const host = localHost("a");
    const engine = { pid: 4242, specHash: "H1" };
    const opts = { to: BASE_OPTIONS.to, node: BASE_OPTIONS.node };

    expect(adoptionProblem(host, engine, centralView(), opts)).toBeNull();
    expect(
      adoptionProblem(
        host,
        null,
        centralView({ live: { state: "Stopped", pid: null, specHash: null } }),
        opts,
      ),
    ).toBeNull();

    const mismatches: CentralHostView[] = [
      centralView({ live: { state: "Running", pid: 9999, specHash: "H1" } }),
      centralView({ specHash: "H2" }),
      centralView({
        found: false,
        node: null,
        specHash: null,
        live: { error: "not found" },
      }),
      centralView({ controllerPid: null }),
      centralView({ managedBy: "other" }),
      centralView({ node: "z13" }),
      centralView({ live: { error: "ECONNREFUSED" } }),
    ];
    for (const view of mismatches) {
      expect(typeof adoptionProblem(host, engine, view, opts)).toBe("string");
    }
  });
});

describe("parseHandoverFlags", () => {
  test("requires --to and --node", async () => {
    const mod = await loadHandover();
    const parse = handoverParser(mod);

    for (const args of [[], ["--to=central"], ["--node=m4pro"]]) {
      expect("error" in parse(args)).toBe(true);
    }
  });

  test("uses a 120 second timeout by default", async () => {
    const mod = await loadHandover();
    const parse = handoverParser(mod);
    const parsed = parse(["--to=central", "--node=m4pro"]);

    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.to).toBe("central");
    expect(parsed.node).toBe("m4pro");
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.controllerUnit).toBeNull();
    expect(typeof parsed.pollMs).toBe("number");
  });

  test("converts --timeout seconds to milliseconds", async () => {
    const mod = await loadHandover();
    const parse = handoverParser(mod);
    const parsed = parse(["--to=central", "--node=m4pro", "--timeout=5"]);

    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.timeoutMs).toBe(5000);
  });

  test("accepts --dry-run and --controller-unit", async () => {
    const mod = await loadHandover();
    const parse = handoverParser(mod);
    const parsed = parse([
      "--to=central",
      "--node=m4pro",
      "--dry-run",
      "--controller-unit=llamactl-controller",
    ]);

    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.controllerUnit).toBe("llamactl-controller");
  });

  test("rejects an unknown flag", async () => {
    const mod = await loadHandover();
    const parse = handoverParser(mod);

    expect("error" in parse(["--to=central", "--node=m4pro", "--wat"])).toBe(true);
  });
});

describe("controller handover subcommand", () => {
  test("prints handover help through runController", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    spies.push(stdoutSpy, stderrSpy);

    const code = await runController(["handover", "--help"]);

    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("handover");
  });
});
