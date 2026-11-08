import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { runAdmit } from "../src/commands/admit.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-admit-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeHostManifest(resources: Record<string, number>, name = "admit-host"): string {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(
    path,
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/usr/bin/true",
        endpoint: { host: "127.0.0.1", port: 18094 },
        hostedModels: [{ rel: `admit-test/${name}-ghost.gguf` }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
        resources,
      },
    }),
  );
  return path;
}

async function runQuiet(args: string[]): Promise<number> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = console.error;
  process.stdout.write = (): boolean => true;
  console.error = (): void => undefined;
  try {
    return await runAdmit(args);
  } finally {
    process.stdout.write = stdout;
    console.error = stderr;
  }
}

test("residentGiB alone is an accepted declaration and is admitted with zero headroom", async () => {
  const path = writeHostManifest({ residentGiB: 100, diskBackedGiB: 103 });
  expect(await runQuiet([path, "--headroom-mb=0", "--safety-factor=0"])).toBe(0);
});

test("residentGiB alone can still be denied when it exceeds free memory", async () => {
  const path = writeHostManifest({ residentGiB: 1_000_000 }, "admit-huge");
  expect(await runQuiet([path])).toBe(1);
});

test("expectedMemoryGiB alone keeps working", async () => {
  const path = writeHostManifest({ expectedMemoryGiB: 12 }, "admit-expected");
  expect(await runQuiet([path, "--headroom-mb=0", "--safety-factor=0"])).toBe(0);
});

test("the larger of residentGiB and expectedMemoryGiB is charged", async () => {
  const path = writeHostManifest({ expectedMemoryGiB: 1_000_000, residentGiB: 12 }, "admit-max");
  expect(await runQuiet([path, "--headroom-mb=0", "--safety-factor=1"])).toBe(1);
});

test("exit 2 only when neither expectedMemoryGiB nor residentGiB is declared", async () => {
  const path = writeHostManifest({}, "admit-undeclared");
  expect(await runQuiet([path, "--headroom-mb=0", "--safety-factor=0"])).toBe(2);
});
