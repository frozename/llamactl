import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";

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
  const script = fileURLToPath(new URL("./fleet-fixture-owner.ts", import.meta.url));
  return Bun.spawn([process.execPath, script, node, target, workload, statusPath], {
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
