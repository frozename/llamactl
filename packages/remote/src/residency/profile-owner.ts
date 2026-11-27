import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { ResidencyOperationRecord } from "./store.js";

import { readlinkSync } from "../safe-fs.js";

export const RESIDENCY_APPLY_PROFILE_FENCE_OWNER = "llamactl-residency-apply-profile";

const OWNER_PREFIX = "profile-owner-v1:";
const OWNER_INCARNATION = /^profile-owner-v1:([\w-]+):([1-9]\d*):[\da-f-]{36}$/;

function localProcessScope(): string | null {
  try {
    const namespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : "darwin";
    return createHash("sha256").update(`${hostname()}\0${namespace}`).digest("base64url");
  } catch {
    return null;
  }
}

export function profileOwnerIncarnation(pid = process.pid): string {
  const scope = localProcessScope();
  const id = randomUUID();
  return scope === null ? id : `${OWNER_PREFIX}${scope}:${String(pid)}:${id}`;
}

export function profileOwnerLiveness(
  record: ResidencyOperationRecord,
): "gone" | "possibly-live" | "unrecorded" {
  if (
    record.ownerId !== RESIDENCY_APPLY_PROFILE_FENCE_OWNER ||
    !record.incarnation.startsWith(OWNER_PREFIX)
  ) {
    return "unrecorded";
  }
  const owner = OWNER_INCARNATION.exec(record.incarnation);
  const pid = Number(owner?.[2]);
  // ESRCH only proves absence when both callers share the PID namespace.
  if (owner?.[1] !== localProcessScope() || pid > 0x7fff_ffff) {
    return "possibly-live";
  }
  try {
    process.kill(pid, 0);
    return "possibly-live";
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "possibly-live";
  }
}
