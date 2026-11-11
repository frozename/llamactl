/**
 * DF-10 (#283) guarded llama.cpp sleep with verified process-stop fallback;
 * inert unless the residency lease registry is published.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { LlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";

import { formatHostForUrl } from "@llamactl/core/engines";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";

// ── Public types ──────────────────────────────────────────────────────────

export type LlamacppVerifiedStopResult =
  | { ok: true }
  | { ok: false; reason: string; message?: string };

export type LlamacppSleepTrigger =
  | "SleepRefused"
  | "SleepUnsupported"
  | "SleepTimedOut"
  | "SleepUnreachable"
  | "ProcessFallback";

export type LlamacppSleepOutcome =
  | { kind: "slept"; reservation: "released" }
  | {
      kind: "stopped";
      trigger: LlamacppSleepTrigger;
      httpStatus?: number;
      reservation: "released";
    }
  | {
      kind: "stop-failed";
      trigger: LlamacppSleepTrigger;
      httpStatus?: number;
      stopReason: string;
      reservation: "uncertain";
    }
  | { kind: "refused"; reason: string; reservation: "held" }
  | { kind: "inert"; reason: "ResidencyPolicyDisabled" };

export type LlamacppSleepDriver = { sleep(): Promise<LlamacppSleepOutcome> };

export type LlamacppSleepDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: { host: string; port: number };
  sleepPath?: string;
  apiKey?: string;
  cacheIdentity?: string;
  sleepTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  verifiedStop: () => Promise<LlamacppVerifiedStopResult>;
};

// ── Internal helpers (duplicated from engine-client.ts) ──────────────────

function buildBaseUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${formatHostForUrl(normalizedHost)}:${String(port)}`;
}

function applyAuth(apiKey: string | undefined, init: RequestInit): RequestInit {
  if (apiKey === undefined) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return { ...init, headers };
}

function errorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = err.name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function classifyFetchError(signal: AbortSignal, err: unknown): "Timeout" | "Unreachable" {
  const name = errorName(err);
  if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
    return "Timeout";
  }
  return "Unreachable";
}

// ── Driver implementation ────────────────────────────────────────────────

function createLlamacppSleepDriver(opts: LlamacppSleepDriverOptions): LlamacppSleepDriver {
  const {
    controller,
    memberId,
    endpoint,
    sleepPath: rawSleepPath,
    apiKey,
    cacheIdentity,
    sleepTimeoutMs = 30_000,
    fetch: baseFetch,
    verifiedStop,
  } = opts;
  const baseUrl = buildBaseUrl(endpoint.host, endpoint.port);
  const sleepPath = rawSleepPath ?? "/sleep";
  const base = baseFetch ?? globalThis.fetch;

  async function sleep(): Promise<LlamacppSleepOutcome> {
    const v = controller.requestSleep(memberId);

    // Step 1: controller refusal — no IO
    if (v.kind === "refuse") {
      return { kind: "refused", reason: v.reason, reservation: "held" };
    }

    // Step 2: process-fallback — skip HTTP, go straight to verified stop
    if (v.kind === "process-stop") {
      return await runVerifiedStop(
        "ProcessFallback",
        undefined,
        verifiedStop,
        controller,
        memberId,
      );
    }

    // Step 3: guarded sleep — POST to the endpoint
    const signal = AbortSignal.timeout(sleepTimeoutMs);
    let httpStatus: number | undefined;

    try {
      const response = await base(
        `${baseUrl}${sleepPath}`,
        applyAuth(apiKey, { method: "POST", signal }),
      );
      httpStatus = response.status;

      // Drain or cancel the body to avoid resource leaks
      void (response.body ? response.body.cancel() : undefined);

      // Step 4: classify the response
      if (response.ok) {
        controller.sleepSettled(memberId, "slept", cacheIdentity);
        return { kind: "slept", reservation: "released" };
      }

      // Non-2xx: sleep failed, mark as failed first so member is unknown/uncertain
      controller.sleepSettled(memberId, "failed");

      const trigger: LlamacppSleepTrigger =
        httpStatus === 404 || httpStatus === 405 || httpStatus === 501
          ? "SleepUnsupported"
          : "SleepRefused";

      return await runVerifiedStop(trigger, httpStatus, verifiedStop, controller, memberId);
    } catch (err) {
      // Step 4 (cont): fetch error — mark as failed first
      controller.sleepSettled(memberId, "failed");
      const fetchError = classifyFetchError(signal, err);
      const trigger: LlamacppSleepTrigger =
        fetchError === "Timeout" ? "SleepTimedOut" : "SleepUnreachable";
      return await runVerifiedStop(trigger, undefined, verifiedStop, controller, memberId);
    }
  }

  return { sleep };
}

// ── Verified stop fallback (step 5) ──────────────────────────────────────

async function runVerifiedStop(
  trigger: LlamacppSleepTrigger,
  httpStatus: number | undefined,
  verifiedStop: () => Promise<LlamacppVerifiedStopResult>,
  controller: LlamacppSleepController,
  memberId: string,
): Promise<LlamacppSleepOutcome> {
  let r: LlamacppVerifiedStopResult;
  try {
    r = await verifiedStop();
  } catch (thrown) {
    const message =
      typeof thrown === "object" &&
      thrown !== null &&
      "reason" in thrown &&
      typeof (thrown as Record<string, unknown>)["reason"] === "string"
        ? ((thrown as Record<string, unknown>)["reason"] as string)
        : "StopFailed";
    return {
      kind: "stop-failed",
      trigger,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      stopReason: message,
      reservation: "uncertain",
    };
  }

  if (r.ok) {
    controller.observe(memberId, "stopped");
    return {
      kind: "stopped",
      trigger,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      reservation: "released",
    };
  }

  const stopReason = r.reason;
  controller.observe(memberId, "unknown");
  return {
    kind: "stop-failed",
    trigger,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    stopReason,
    reservation: "uncertain",
  };
}

// ── Agent-side driver (residency-lease-registry gated) ───────────────────

export type AgentLlamacppSleepDriverOptions = Omit<LlamacppSleepDriverOptions, "controller"> & {
  controller: LlamacppSleepController;
};

export function createAgentLlamacppSleepDriver(
  opts: AgentLlamacppSleepDriverOptions,
): LlamacppSleepDriver {
  const registry: ResidencyLeases | null = getResidencyLeaseRegistry();
  if (registry === null) {
    return {
      sleep(): Promise<LlamacppSleepOutcome> {
        return Promise.resolve({ kind: "inert", reason: "ResidencyPolicyDisabled" });
      },
    };
  }
  return createLlamacppSleepDriver(opts);
}
