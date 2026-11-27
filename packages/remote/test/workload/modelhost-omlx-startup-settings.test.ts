import { expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";

const name = "omlx-settings-fixture";
const rel = "fixture-community/test-model";
const id = basename(rel);

async function startFixture(existing: string): Promise<{
  result: Awaited<ReturnType<typeof startModelHost>>;
  readLaunch: () => unknown;
  spawned: () => boolean;
  settings: () => string;
  basePath: string;
  cleanup: () => Promise<void>;
}> {
  const temp = makeTempRuntime();
  const { devStorage: tmp, runtimeDir, modelsDir } = temp;
  const workloadsDir = join(tmp, "desired");
  const binary = join(tmp, "omlx");
  const script = join(tmp, "fixture.ts");
  const witness = join(tmp, "launch.json");
  const basePath = join(runtimeDir, "workloads", name, ".omlx");
  const settingsPath = join(basePath, "model_settings.json");
  const env = {
    ...envForTemp(temp),
    LLAMACTL_MODELS_DIR: modelsDir,
    LLAMACTL_RUNTIME_DIR: runtimeDir,
  };
  const cleanup = async (): Promise<void> => {
    try {
      await stopModelHost({ key: { name }, runtimeDir, env, graceSeconds: 0 });
    } finally {
      temp.cleanup();
    }
  };

  try {
    mkdirSync(join(modelsDir, rel), { recursive: true });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, existing);
    writeFileSync(binary, `#!/bin/bash\nexec -a omlx "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      script,
      `
const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base-path");
const basePath = baseIndex < 0 ? null : args[baseIndex + 1];
const settings = basePath === null ? null : await Bun.file(basePath + "/model_settings.json").json();
await Bun.write(${JSON.stringify(witness)}, JSON.stringify({ basePath, settings }));
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args[args.indexOf("--port") + 1]),
  fetch: () => Response.json({ data: [{ id: ${JSON.stringify(id)} }] }),
});
`,
    );
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    await probe.stop();
    const result = await startModelHost({
      key: { name },
      runtimeDir,
      workloadsDir,
      env,
      manifest: {
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name },
        spec: {
          engine: "omlx",
          node: "local",
          binary,
          endpoint: { host: "127.0.0.1", port },
          hostedModels: [{ rel, omlx: { max_context_window: 8192, mtp_enabled: true } }],
          extraArgs: [],
          timeoutSeconds: 3,
        },
      },
    });
    return {
      result,
      readLaunch: (): unknown => JSON.parse(readFileSync(witness, "utf8")),
      spawned: () => existsSync(witness),
      settings: () => readFileSync(settingsPath, "utf8"),
      basePath,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("the spawned oMLX process reads reconciled options from its workload base path", async () => {
  const fixture = await startFixture(
    '{"version":1,"models":{"test-model":{"dflash_enabled":true,"dflash_draft_model":"old","max_tokens":100,"operator_extra":0.0},"sibling":{"keep":true},"__proto__":{"keep_literal_id":true}}}',
  );
  try {
    expect(fixture.result).toMatchObject({ ok: true });
    expect(fixture.readLaunch()).toEqual({
      basePath: fixture.basePath,
      settings: {
        version: 1,
        models: {
          [id]: {
            dflash_enabled: false,
            max_context_window: 8192,
            mtp_enabled: true,
            operator_extra: 0,
          },
          sibling: { keep: true },
          ["__proto__"]: { keep_literal_id: true },
        },
      },
    });
    expect(fixture.settings()).toContain('"operator_extra": 0.0');
    expect(fixture.settings()).toContain('"__proto__"');
    expect(fixture.settings()).toContain('"keep_literal_id": true');
  } finally {
    await fixture.cleanup();
  }
});

test.each([
  ["malformed", '{"version":1,"models":', "InvalidJson"],
  [
    "conflicting",
    '{"version":1,"models":{"test-model":{"vlm_mtp_enabled":true}}}',
    "SpeculativeConflict",
  ],
] as const)(
  "startup refuses %s managed oMLX settings before spawning",
  async (_label, existing, reason) => {
    const fixture = await startFixture(existing);
    try {
      expect(fixture.result).toMatchObject({ ok: false, pid: null });
      expect(fixture.result.error).toContain(reason);
      expect(fixture.spawned()).toBe(false);
      expect(fixture.settings()).toBe(existing);
    } finally {
      await fixture.cleanup();
    }
  },
);
