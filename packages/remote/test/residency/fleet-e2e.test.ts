import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../../src/workload/store.js";

function ownerEnvironment(dir: string, node: string): NodeJS.ProcessEnv {
  mkdirSync(dir, { recursive: true });
  const workloadsDir = join(dir, "workloads");
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${node} }
spec: { node: ${node}, budget: { memoryGiB: 24 } }
`),
    workloadsDir,
  );
  return {
    ...process.env,
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
  };
}

function boot(
  env: NodeJS.ProcessEnv,
  node: string,
  target: string,
  workload: string,
  statusPath: string,
): Bun.Subprocess {
  return bootFixture("./fleet-fixture-owner.ts", env, [node, target, workload, statusPath]);
}

function bootFixture(name: string, env: NodeJS.ProcessEnv, args: string[]): Bun.Subprocess {
  const script = fileURLToPath(new URL(name, import.meta.url));
  return Bun.spawn([process.execPath, script, ...args], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

function holdFixtureEngine(): {
  target: string;
  entered: Promise<undefined>;
  complete: () => void;
  hits: () => number;
  close: () => Promise<void>;
} {
  const entered = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<undefined>();
  let hits = 0;
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits++;
      entered.resolve(undefined);
      let canceled = false;
      const utf8 = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel(): void {
            canceled = true;
          },
          async start(controller): Promise<void> {
            controller.enqueue(utf8.encode("prefix"));
            await complete.promise;
            if (!canceled) {
              controller.enqueue(utf8.encode(" terminal"));
              controller.close();
            }
          },
        }),
      );
    },
  });
  return {
    target: new URL("/v1/completions", engine.url).href,
    entered: entered.promise,
    complete: (): void => {
      complete.resolve(undefined);
    },
    hits: () => hits,
    close: () => engine.stop(true),
  };
}

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "two serving owners isolate an active peer while a crashed owner preserves its inference hold",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "llamactl-fleet-e2e-"));
    const book = holdFixtureEngine();
    const executor = holdFixtureEngine();
    const processes: Bun.Subprocess[] = [];
    const summon = (
      env: NodeJS.ProcessEnv,
      node: string,
      target: string,
      model: string,
      file: string,
    ): Bun.Subprocess => {
      const child = boot(env, node, target, model, join(root, file));
      processes.push(child);
      return child;
    };
    const status = (file: string): Promise<unknown> => Bun.file(join(root, file)).json();
    try {
      const bookEnv = ownerEnvironment(join(root, "book"), "book");
      const executorEnv = ownerEnvironment(join(root, "executor"), "executor");
      const oldOwner = summon(bookEnv, "book", book.target, "interactive", "killed.json");
      const peer = summon(executorEnv, "executor", executor.target, "protected", "peer.json");
      await Promise.all([
        Promise.race([
          book.entered,
          oldOwner.exited.then(() => {
            throw new Error("book exited before dial");
          }),
        ]),
        Promise.race([
          executor.entered,
          peer.exited.then(() => {
            throw new Error("executor exited before dial");
          }),
        ]),
      ]);

      const competing = summon(bookEnv, "book", book.target, "interactive", "competing.json");
      expect(await competing.exited).toBe(0);
      expect(await status("competing.json")).toEqual({ error: "AuthorityUnavailable" });
      expect(book.hits()).toBe(1);

      oldOwner.kill("SIGKILL");
      expect(await oldOwner.exited).toBeGreaterThan(0);
      book.complete();
      const recovered = summon(bookEnv, "book", book.target, "interactive", "recovered.json");
      expect(await recovered.exited).toBe(0);
      const answer = await status("recovered.json");
      expect(answer).toMatchObject({ status: 503 });
      expect(JSON.stringify(answer)).toContain("residency_hold_unavailable");
      expect(book.hits()).toBe(1);

      expect(executor.hits()).toBe(1);
      expect(peer.exitCode).toBeNull();
      executor.complete();
      expect(await peer.exited).toBe(0);
      expect(await status("peer.json")).toEqual({ status: 200, body: "prefix terminal" });
    } finally {
      book.complete();
      executor.complete();
      for (const child of processes) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.all([
        book.close(),
        executor.close(),
        ...processes.map((child) => child.exited),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

async function publicationEngine(
  dir: string,
): Promise<{ endpoint: string; binary: string; port: number }> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const { port } = reservation;
  await reservation.stop(true);
  if (port === undefined) throw new Error("missing fixture port");
  const binary = join(dir, "fixture-llama-server");
  const source = `
    Bun.serve({hostname:"127.0.0.1", port:${String(port)}, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/__stop_fixture") {
        setTimeout(() => process.exit(0), 5);
        return new Response(null, { status: 204 });
      }
      if (path === "/health") return new Response("publication fixture healthy");
      return Response.json({fixture:"unpublished engine received a request"});
    }});
    setTimeout(() => process.exit(0), 15000);
  `;
  writeFileSync(
    binary,
    `#!/bin/bash\nexec -a llama-server ${JSON.stringify(process.execPath)} -e ${JSON.stringify(source.replaceAll("\n", " "))} -- "$@"\n`,
    { mode: 0o755 },
  );
  return { endpoint: `http://127.0.0.1:${String(port)}`, binary, port };
}

async function waitForFixtureEngine(endpoint: string): Promise<void> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(100) });
      if (response.ok && (await response.text()) === "publication fixture healthy") return;
    } catch {
      // The detached fixture process may still be binding its port.
    }
    await Bun.sleep(20);
  }
  throw new Error("the detached fixture engine did not become reachable");
}

function savePublicationWorkload(
  workloadsDir: string,
  engine: { binary: string; port: number },
  name: string,
  rel: string,
  allocationGiB: number,
): void {
  saveWorkload(
    parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: ${name} }
spec:
  node: local
  target: { kind: rel, value: ${rel} }
  endpoint: { host: 127.0.0.1, port: ${String(engine.port)} }
  binary: ${JSON.stringify(engine.binary)}
  resources: { expectedMemoryGiB: ${String(allocationGiB)} }
`),
    workloadsDir,
  );
}

for (const stage of ["launch", "ready"] as const) {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    `restarting after managed ${stage === "launch" ? "spawn before PID recording" : "readiness commit"} retains the charge and hides the unpublished route`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-fleet-publication-crash-"));
      const node = "publication-owner";
      const workload = "unpublished";
      const rel = "fixture-private.gguf";
      const processes: Bun.Subprocess[] = [];
      let endpoint: string | undefined;
      try {
        const engine = await publicationEngine(dir);
        endpoint = engine.endpoint;
        const workloadsDir = join(dir, "workloads");
        const models = join(dir, "models");
        mkdirSync(models);
        writeFileSync(join(models, rel), "fixture");
        writeFileSync(join(models, "replacement.gguf"), "fixture");
        const env = {
          ...ownerEnvironment(dir, node),
          LLAMA_CPP_MODELS: models,
          LLAMA_CPP_HOST: "127.0.0.1",
          LLAMA_CPP_PORT: String(engine.port),
          LLAMA_CPP_SERVER_ALIAS: rel,
          LLAMA_CPP_CACHE: join(dir, "cache"),
          LLAMA_CPP_LOGS: join(dir, "logs"),
          LLAMA_CPP_USE_TUNED_ARGS: "false",
          LLAMACTL_CONFIG: join(dir, "missing-fixture-config"),
        };
        savePublicationWorkload(workloadsDir, engine, workload, rel, 4);
        savePublicationWorkload(
          workloadsDir,
          engine,
          `${workload}-replacement`,
          "replacement.gguf",
          24,
        );
        const run = async (
          mode: typeof stage | "recover",
        ): Promise<{ signal: string | null; report: unknown }> => {
          const path = join(dir, `${mode}.json`);
          const child = bootFixture("./fleet-fixture-publication.ts", env, [
            mode,
            node,
            workload,
            path,
          ]);
          processes.push(child);
          await child.exited;
          return { signal: child.signalCode, report: await Bun.file(path).json() };
        };

        const crashed = await run(stage);
        const { pid, claims } = crashed.report as {
          pid?: number;
          claims?: { generations?: { birthId?: string }[] }[];
        };
        expect(typeof pid).toBe("number");
        expect(crashed.report).toMatchObject({
          recordedPid: stage === "launch" ? null : pid,
          state: stage === "launch" ? null : { pid, publicationPending: true },
          claims: [
            {
              runtimeKey: workload,
              state: stage === "launch" ? "pending" : "resident",
              allocationGiB: 4,
              generations: stage === "launch" ? [] : [{ pid }],
            },
          ],
        });
        expect(pid).toBeGreaterThan(0);
        if (stage === "ready") expect(typeof claims?.[0]?.generations?.[0]?.birthId).toBe("string");
        expect(crashed.signal).toBe("SIGKILL");
        await waitForFixtureEngine(engine.endpoint);

        const recovered = await run("recover");
        expect(recovered.report).toMatchObject({
          routes: { status: 204, body: "" },
          status: {
            status: 200,
            body: {
              result: {
                data: {
                  managed: {
                    ledger: "available",
                    claims: [
                      {
                        workload,
                        state: stage === "launch" ? "uncertain" : "resident",
                        allocationGiB: 4,
                      },
                    ],
                  },
                },
              },
            },
          },
          completion: { status: 503 },
          replacement: {
            status: 200,
            body: { result: { data: { ok: false, reason: "BudgetExceeded" } } },
          },
        });
        expect(JSON.stringify(recovered.report)).not.toContain(
          "unpublished engine received a request",
        );
        expect(recovered.signal).toBeNull();
      } finally {
        if (endpoint !== undefined) {
          await fetch(`${endpoint}/__stop_fixture`, { signal: AbortSignal.timeout(250) }).catch(
            () => undefined,
          );
        }
        for (const child of processes) {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }
        await Promise.all(processes.map((child) => child.exited));
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
}
