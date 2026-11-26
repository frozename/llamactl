import { z } from "zod";

import { constants, open } from "../safe-fs.js";

const Inventory = z
  .array(
    z
      .object({
        port: z.number().int().min(1).max(65535),
        model: z.string().min(1).max(512),
      })
      .strict(),
  )
  .max(16);
const Models = z.object({ data: z.array(z.object({ id: z.string() })) });
const MAX_INVENTORY_BYTES = 32 * 1024;
const MAX_MODELS_BYTES = 256 * 1024;

export interface ObservedModel {
  port: number;
  model: string;
  state: "advertised" | "missing" | "unreachable";
}

export type ObservedModels =
  | { state: "unconfigured" }
  | { state: "invalid-config" }
  | { state: "ready"; models: ObservedModel[] };

async function readInventory(file: string): Promise<z.infer<typeof Inventory>> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > MAX_INVENTORY_BYTES) throw new Error("invalid inventory");
    const buffer = Buffer.alloc(MAX_INVENTORY_BYTES + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_INVENTORY_BYTES) throw new Error("inventory exceeded limit");
    return Inventory.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
  } finally {
    await fd.close();
  }
}

async function advertisedModels(port: number): Promise<Set<string> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    });
    if (response.body === null) return null;
    const reader = response.body.getReader();
    try {
      if (!response.ok) return null;
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_MODELS_BYTES) return null;
        text += decoder.decode(value, { stream: true });
      }
      const data = Models.parse(JSON.parse(text + decoder.decode()));
      return new Set(data.data.map((model) => model.id));
    } finally {
      await reader.cancel();
    }
  } catch {
    return null;
  }
}

export async function readObservedModels(
  override: string | undefined,
  defaultFile?: string,
): Promise<ObservedModels> {
  const file = override ?? defaultFile;
  if (!file) return { state: "unconfigured" };
  try {
    const inventory = await readInventory(file);
    const unique = new Map(inventory.map((row) => [`${String(row.port)}/${row.model}`, row]));
    const byPort = new Map(
      [...new Set(inventory.map((row) => row.port))].map(
        (port) => [port, advertisedModels(port)] as const,
      ),
    );
    const models = await Promise.all(
      [...unique.values()].map(async (row): Promise<ObservedModel> => {
        const advertised = await byPort.get(row.port);
        return {
          ...row,
          state: advertised
            ? advertised.has(row.model)
              ? "advertised"
              : "missing"
            : "unreachable",
        };
      }),
    );
    return { state: "ready", models };
  } catch (error) {
    if (
      override === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { state: "unconfigured" };
    }
    return { state: "invalid-config" };
  }
}
