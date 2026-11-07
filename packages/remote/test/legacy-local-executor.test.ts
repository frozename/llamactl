import type { ResolvedEnv } from "@llamactl/core/types";

import { inferenceContracts } from "@llamactl/core";
import { describe, expect, test } from "bun:test";

import type { BackendExecutionContext } from "../src/proxy/create-proxy.js";

import { createLegacyLocalExecutor } from "../src/inference/legacy-local-executor.js";

const ENV = { LLAMA_CPP_HOST: "sentinel" } as unknown as ResolvedEnv;

const envelopeBase = {
  requestId: "req-1",
  attemptId: "att-1",
  deadline: 1_900_000_000_000,
  tenantId: "tenant-a",
  projectId: "proj-1",
  credentialScopeId: "cred-scope-1",
  operation: "generate",
  ingressProtocol: "openai-chat",
  publicModelId: "shared.gguf",
  features: {
    operation: "generate",
    protocol: "openai-chat",
    stream: false,
    modalities: ["text"],
    tools: false,
    structuredOutput: false,
    session: false,
    cancellation: true,
  },
  stream: false,
  nativeBody: { model: "shared.gguf", messages: [{ role: "user", content: "hi" }] },
  headerFingerprint: { allowlist: ["content-type"], fingerprint: "fp-abc" },
};

function makeEnvelope(
  attemptId: string,
): ReturnType<typeof inferenceContracts.parseInferenceEnvelope> {
  return inferenceContracts.parseInferenceEnvelope({ ...envelopeBase, attemptId });
}

function makeCtx(opts: { attemptId?: string; signal?: AbortSignal } = {}): BackendExecutionContext {
  const attemptId = opts.attemptId ?? "att-1";
  const base: BackendExecutionContext = {
    req: new Request("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
      headers: { "content-type": "application/json" },
    }),
    resolved: ENV,
    attemptId,
    deadline: 1_900_000_000_000,
  };
  if (opts.signal) return { ...base, signal: opts.signal };
  return base;
}

describe("Legacy local executor", () => {
  test("describe returns the expected identity block", () => {
    const executor = createLegacyLocalExecutor();
    expect(executor.describe()).toEqual({
      id: "legacy-local-executor",
      backendKinds: ["local-model"],
      transports: ["local-http", "worker-rpc"],
    });
  });
});

describe("resolveEnv passthrough", () => {
  test("a resolved value is passed by identity to the proxy", async () => {
    let capturedResolved: ResolvedEnv | undefined;
    const executor = createLegacyLocalExecutor({
      resolved: ENV,
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        capturedResolved = resolved;
        return Promise.resolve(new Response("ok"));
      },
    });
    const env = makeEnvelope("att-2");
    const ctx = makeCtx({ attemptId: "att-2" });
    const result = await executor.execute(env, ctx);
    expect(capturedResolved).toBe(ENV);
    expect(result).toBeInstanceOf(Response);
  });
});

describe("resolveEnv function passthrough", () => {
  test("a resolved function is called once per execute", async () => {
    let callCount = 0;
    const executor = createLegacyLocalExecutor({
      resolved: (): ResolvedEnv => {
        callCount++;
        return ENV;
      },
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        return Promise.resolve(new Response("ok"));
      },
    });
    expect(callCount).toBe(0);
    const env = makeEnvelope("att-3a");
    const ctx = makeCtx({ attemptId: "att-3a" });
    await executor.execute(env, ctx);
    expect(callCount).toBe(1);
    const env2 = makeEnvelope("att-3b");
    const ctx2 = makeCtx({ attemptId: "att-3b" });
    await executor.execute(env2, ctx2);
    expect(callCount).toBe(2);
  });
});

describe("cancel lifecycle", () => {
  test("cancel returns false for unknown attemptIds", () => {
    const executor = createLegacyLocalExecutor();
    expect(executor.cancel("nope")).toBe(false);
  });

  test("cancel aborts the forwarded request's signal", async () => {
    let released!: (r: Response) => void;
    const releasePromise = new Promise<Response>((resolve) => {
      released = resolve;
    });
    let forwardedReq: Request | undefined;
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReq = req;
        return releasePromise;
      },
    });
    const env = makeEnvelope("a1");
    const ctx = makeCtx({ attemptId: "a1" });
    const executePromise = executor.execute(env, ctx);
    expect(executor.cancel("nope")).toBe(false);
    expect(executor.cancel("a1")).toBe(true);
    expect(forwardedReq!.signal.aborted).toBe(true);
    released(new Response("released"));
    await executePromise;
    expect(executor.cancel("a1")).toBe(false);
  });
});

describe("rejection cleanup", () => {
  test("a proxy rejection cleans up the inFlight entry", async () => {
    const specificError = new Error("proxy-failed");
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        return Promise.reject(specificError);
      },
    });
    const env = makeEnvelope("att-rej");
    const ctx = makeCtx({ attemptId: "att-rej" });
    const executePromise = executor.execute(env, ctx);
    await executePromise.then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        expect(err).toBe(specificError);
      },
    );
    expect(executor.cancel("att-rej")).toBe(false);
  });
});

describe("signal composition", () => {
  test("client abort propagates to the forwarded request", async () => {
    let released!: (r: Response) => void;
    const releasePromise = new Promise<Response>((resolve) => {
      released = resolve;
    });
    const clientController = new AbortController();
    let forwardedReq: Request | undefined;
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReq = req;
        return releasePromise;
      },
    });
    const env = makeEnvelope("att-cl");
    const ctx: BackendExecutionContext = {
      ...makeCtx({ attemptId: "att-cl" }),
      req: new Request("http://127.0.0.1:1/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m" }),
        headers: { "content-type": "application/json" },
        signal: clientController.signal,
      }),
    };
    const executePromise = executor.execute(env, ctx);
    clientController.abort();
    expect(forwardedReq!.signal.aborted).toBe(true);
    released(new Response("ok"));
    await executePromise;
  });

  test("ctx.signal abort propagates to the forwarded request", async () => {
    let released!: (r: Response) => void;
    const releasePromise = new Promise<Response>((resolve) => {
      released = resolve;
    });
    const callerController = new AbortController();
    let forwardedReq: Request | undefined;
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReq = req;
        return releasePromise;
      },
    });
    const env = makeEnvelope("att-ctx");
    const ctx: BackendExecutionContext = {
      ...makeCtx({ attemptId: "att-ctx" }),
      signal: callerController.signal,
    };
    const executePromise = executor.execute(env, ctx);
    callerController.abort();
    expect(forwardedReq!.signal.aborted).toBe(true);
    released(new Response("ok"));
    await executePromise;
  });

  test("a pre-aborted ctx.signal is ignored (forwarded signal stays un-aborted while pending)", async () => {
    let released!: (r: Response) => void;
    const releasePromise = new Promise<Response>((resolve) => {
      released = resolve;
    });
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    let forwardedReq: Request | undefined;
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReq = req;
        return releasePromise;
      },
    });
    const env = makeEnvelope("att-pre");
    const ctx: BackendExecutionContext = {
      ...makeCtx({ attemptId: "att-pre" }),
      signal: preAbortedController.signal,
    };
    const executePromise = executor.execute(env, ctx);
    expect(forwardedReq!.signal.aborted).toBe(false);
    released(new Response("ok"));
    await executePromise;
  });
});

describe("drain vs close", () => {
  test("drain aborts all pending signals but keeps them in the map", async () => {
    const releasePromises: Promise<Response>[] = [];
    const makeRelease = (): ((v: Response) => void) => {
      let r!: (v: Response) => void;
      const p = new Promise<Response>((resolve) => {
        r = resolve;
      });
      releasePromises.push(p);
      return r;
    };
    const releases: ((r: Response) => void)[] = [];
    releases.push(makeRelease(), makeRelease());
    const forwardedReqs: Request[] = [];
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReqs.push(req);
        return releasePromises[forwardedReqs.length - 1]!;
      },
    });
    const env1 = makeEnvelope("d1");
    const ctx1 = makeCtx({ attemptId: "d1" });
    const env2 = makeEnvelope("d2");
    const ctx2 = makeCtx({ attemptId: "d2" });
    const ex1 = executor.execute(env1, ctx1);
    const ex2 = executor.execute(env2, ctx2);
    await executor.drain();
    expect(forwardedReqs[0]!.signal.aborted).toBe(true);
    expect(forwardedReqs[1]!.signal.aborted).toBe(true);
    expect(executor.cancel("d1")).toBe(true);
    releases[0]!(new Response("r1"));
    releases[1]!(new Response("r2"));
    await ex1;
    await ex2;
  });

  test("clear aborts all pending signals and removes them from the map", async () => {
    let released!: (r: Response) => void;
    const releasePromise = new Promise<Response>((resolve) => {
      released = resolve;
    });
    let forwardedReq: Request | undefined;
    const executor = createLegacyLocalExecutor({
      proxy: (req: Request, resolved: ResolvedEnv): Promise<Response> => {
        forwardedReq = req;
        return releasePromise;
      },
    });
    const env = makeEnvelope("c1");
    const ctx = makeCtx({ attemptId: "c1" });
    const executePromise = executor.execute(env, ctx);
    await executor.close();
    expect(forwardedReq!.signal.aborted).toBe(true);
    expect(executor.cancel("c1")).toBe(false);
    released(new Response("ok"));
    await executePromise;
  });
});
