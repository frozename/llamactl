import {
  hasManagedRuntimeMarker,
  managedRuntimeMarker,
} from "@llamactl/core/residency/managed-runtime";
import { z } from "zod";

import { readFileSync, statSync, writeFileSync } from "../safe-fs.js";
import { managedAdmissionStorePath } from "./target-admission-policy.js";

const MarkerSchema = z.strictObject({
  version: z.literal(1),
  node: z.string().min(1),
  admission: z.string().min(1),
  operations: z.string().min(1),
});
type Marker = z.infer<typeof MarkerSchema>;

function fileIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() ? `${String(stat.dev)}/${String(stat.ino)}` : undefined;
  } catch {
    return undefined;
  }
}

function readMarker(path: string, node: string): Marker {
  const marker = MarkerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (marker.node !== node) throw new Error("ManagedNodeIdentityMismatch");
  return marker;
}

export function manageJournalPair(
  runtimeDir: string,
  operationsPath: string,
  node: string,
): {
  prior: boolean;
  verify: () => string | undefined;
  install(): void;
} {
  const path = managedRuntimeMarker(runtimeDir);
  const admissionPath = managedAdmissionStorePath(runtimeDir);
  let marker = hasManagedRuntimeMarker(runtimeDir) ? readMarker(path, node) : undefined;
  let markerIdentity = marker === undefined ? undefined : fileIdentity(path);
  const verify = (): string | undefined => {
    if (marker === undefined) return undefined;
    if (markerIdentity === undefined || fileIdentity(path) !== markerIdentity)
      return "ManagedOwnershipMarkerMismatch";
    if (fileIdentity(admissionPath) !== marker.admission) return "ManagedAdmissionJournalMismatch";
    if (fileIdentity(operationsPath) !== marker.operations)
      return "ManagedTransitionJournalMismatch";
    return undefined;
  };
  return {
    prior: marker !== undefined,
    verify,
    install(): void {
      if (marker === undefined) {
        const admission = fileIdentity(admissionPath);
        const operations = fileIdentity(operationsPath);
        if (admission === undefined || operations === undefined)
          throw new Error("ManagedJournalUnverified");
        const next: Marker = { version: 1, node, admission, operations };
        try {
          writeFileSync(path, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
          marker = next;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          marker = readMarker(path, node);
        }
        markerIdentity = fileIdentity(path);
      }
      const refusal = verify();
      if (refusal !== undefined) throw new Error(refusal);
    },
  };
}
