/**
 * Claim-race worker for admission-store.test.ts. Each worker opens its own
 * admission-store connection to the shared DB file, reports "armed", waits
 * for "go", then issues one synchronous claim so the two transactions
 * genuinely contend on the file lock. It reports "claiming" immediately
 * before entering claim() so the parent can hold a write lock until both
 * workers are inside — the contention window is deterministic.
 */
import {
  type AdmissionStore,
  type ClaimInput,
  openAdmissionStore,
} from "../../src/residency/admission-store.js";

export interface ClaimJob {
  path: string;
  busyTimeoutMs: number;
  input: ClaimInput;
}

export type WorkerReply =
  | { tag: "armed" }
  | { tag: "claiming" }
  | {
      tag: "done";
      result: { kind: string; claimId?: string; reason?: string; committedGiB?: number };
    }
  | { tag: "failed"; message: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let store: AdmissionStore | null = null;
let job: ClaimJob | null = null;

const runClaim = (): void => {
  if (store === null || job === null) {
    postMessage({ tag: "failed", message: "claim requested before open" } satisfies WorkerReply);
    return;
  }
  try {
    const r = store.claim(job.input);
    postMessage({
      tag: "done",
      result: {
        kind: r.kind,
        claimId: "claimId" in r ? r.claimId : undefined,
        reason: r.kind === "refuse" ? r.reason : undefined,
        committedGiB: r.kind === "admitted" ? r.committedGiB : undefined,
      },
    } satisfies WorkerReply);
  } catch (e) {
    postMessage({ tag: "failed", message: `claim: ${errText(e)}` } satisfies WorkerReply);
  } finally {
    store.close();
  }
};

addEventListener("message", (event) => {
  const data = event.data as ClaimJob | "go";
  if (data === "go") {
    if (store === null) {
      return;
    }
    postMessage({ tag: "claiming" } satisfies WorkerReply);
    setTimeout(runClaim, 30);
    return;
  }
  job = data;
  try {
    store = openAdmissionStore({ path: job.path, busyTimeoutMs: job.busyTimeoutMs });
  } catch (e) {
    postMessage({ tag: "failed", message: `open: ${errText(e)}` } satisfies WorkerReply);
    return;
  }
  postMessage({ tag: "armed" } satisfies WorkerReply);
});
