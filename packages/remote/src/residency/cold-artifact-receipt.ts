import type { FileHandle } from "node:fs/promises";

import { server } from "@llamactl/core";
import { createHash } from "node:crypto";

import { constants, open, statSync } from "../safe-fs.js";

export interface ColdModelArtifactReceipt {
  readonly rel: string;
  readonly generationDigest: string;
  readonly sha256: string;
}

interface ReceiptInput extends ColdModelArtifactReceipt {
  modelPath: string;
  eligible: boolean;
  maxBytes: number;
  signal?: AbortSignal;
}

const SHA256 = /^[0-9a-f]{64}$/;
const CHUNK_BYTES = 32 * 1024;

async function contentDigest(file: FileHandle, opts: ReceiptInput): Promise<string | undefined> {
  const start = await file.stat({ bigint: true });
  if (
    !start.isFile() ||
    start.size === 0n ||
    start.size > BigInt(opts.maxBytes) ||
    server.modelRunArtifactGenerationDigest(start) !== opts.generationDigest
  ) {
    return undefined;
  }
  const content = createHash("sha256");
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let total = 0;
  while (total < Number(start.size)) {
    opts.signal?.throwIfAborted();
    const remaining = Number(start.size) - total;
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, remaining), null);
    if (bytesRead === 0) return undefined;
    content.update(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  opts.signal?.throwIfAborted();
  const end = await file.stat({ bigint: true });
  return server.modelRunArtifactGenerationDigest(end) === opts.generationDigest
    ? content.digest("hex")
    : undefined;
}

/** Verify an explicitly eligible artifact before publishing its receipt to an owner. */
export async function verifyColdModelArtifactReceipt(
  opts: ReceiptInput,
): Promise<ColdModelArtifactReceipt | undefined> {
  if (
    !opts.eligible ||
    opts.signal?.aborted === true ||
    !SHA256.test(opts.sha256) ||
    !SHA256.test(opts.generationDigest) ||
    !Number.isSafeInteger(opts.maxBytes) ||
    opts.maxBytes <= 0
  ) {
    return undefined;
  }
  let file: FileHandle | undefined;
  try {
    file = await open(
      opts.modelPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if ((await contentDigest(file, opts)) !== opts.sha256) return undefined;
    const current = statSync(opts.modelPath, { bigint: true });
    opts.signal?.throwIfAborted();
    if (server.modelRunArtifactGenerationDigest(current) !== opts.generationDigest) {
      return undefined;
    }
    return Object.freeze({
      rel: opts.rel,
      generationDigest: opts.generationDigest,
      sha256: opts.sha256,
    });
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
