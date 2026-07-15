import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runPlan, validatePlannerEndpoint } from "../src/commands/plan.js";

const MANAGED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "LLAMACTL_OPERATOR_PLAN_HOST_ALLOWLIST",
  "LLAMACTL_OPERATOR_PLAN_API_KEY_ENVS",
  "CUSTOM_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCallCount = 0;
const SENSITIVE_MARKER = "sensitive-secret-should-never-leak-42";

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  process.env["OPENAI_API_KEY"] = "sk-openai-test";
  process.env["AWS_SECRET_ACCESS_KEY"] = SENSITIVE_MARKER;
  Reflect.deleteProperty(process.env, "CUSTOM_API_KEY");
  Reflect.deleteProperty(process.env, "LLAMACTL_OPERATOR_PLAN_HOST_ALLOWLIST");
  Reflect.deleteProperty(process.env, "LLAMACTL_OPERATOR_PLAN_API_KEY_ENVS");

  fetchCallCount = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((..._args: unknown[]): Promise<Response> => {
    fetchCallCount += 1;
    throw new Error("fetch was called during a plan security rejection path");
  }) as unknown as typeof globalThis.fetch;
});

function captureWrites(target: NodeJS.WriteStream): { restore: () => void; output: () => string } {
  const chunks: string[] = [];
  const originalWrite = target.write.bind(target);
  target.write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  return {
    restore: (): void => {
      target.write = originalWrite;
    },
    output: (): string => chunks.join(""),
  };
}

describe("llamactl plan run — endpoint hardening", () => {
  test("validator rejects non-https baseUrl", () => {
    expect(validatePlannerEndpoint("http://api.openai.com/v1", "OPENAI_API_KEY")).toEqual({
      ok: false,
      message: "baseUrl must use https",
    });
  });

  test("validator rejects non-allowlisted host", () => {
    expect(validatePlannerEndpoint("https://attacker.example/v1", "OPENAI_API_KEY")).toEqual({
      ok: false,
      message: "baseUrl host 'attacker.example' is not allowlisted",
    });
  });

  test("validator rejects userinfo host-trick before allowlist", () => {
    expect(
      validatePlannerEndpoint("https://api.openai.com@attacker.example/v1", "OPENAI_API_KEY"),
    ).toEqual({
      ok: false,
      message: "baseUrl host 'attacker.example' is not allowlisted",
    });
  });

  test("validator rejects apiKeyEnv not allowlisted before baseUrl", () => {
    expect(validatePlannerEndpoint("http://attacker.example/v1", "AWS_SECRET_ACCESS_KEY")).toEqual({
      ok: false,
      message: "apiKeyEnv 'AWS_SECRET_ACCESS_KEY' is not allowlisted",
    });
  });

  test("validator allows default host and key", () => {
    expect(validatePlannerEndpoint("https://api.openai.com/v1", "OPENAI_API_KEY")).toEqual({
      ok: true,
    });
  });

  test("validator allows operator custom allowlists", () => {
    process.env["LLAMACTL_OPERATOR_PLAN_HOST_ALLOWLIST"] = "planner.internal,api.openai.com";
    process.env["LLAMACTL_OPERATOR_PLAN_API_KEY_ENVS"] = "CUSTOM_API_KEY,OPENAI_API_KEY";
    process.env["CUSTOM_API_KEY"] = "custom-secret";

    expect(validatePlannerEndpoint("https://planner.internal/v1", "CUSTOM_API_KEY")).toEqual({
      ok: true,
    });
  });

  test("runPlan rejects bad baseUrl without fetching or key leak", async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan([
        "run",
        "list catalog",
        "--model=gpt-4o-mini",
        "--base-url=http://attacker.example/v1",
        "--api-key-env=OPENAI_API_KEY",
      ]);
      expect(code).toBe(1);
      const output = stderr.output();
      expect(output).toContain("baseUrl must use https");
      expect(output).not.toContain(SENSITIVE_MARKER);
    } finally {
      stderr.restore();
    }
    expect(fetchCallCount).toBe(0);
  });

  test("runPlan rejects apiKeyEnv before URL parsing", async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan([
        "run",
        "list catalog",
        "--model=gpt-4o-mini",
        "--base-url=http://attacker.example/v1",
        "--api-key-env=AWS_SECRET_ACCESS_KEY",
      ]);
      expect(code).toBe(1);
      const output = stderr.output();
      expect(output).toContain("apiKeyEnv 'AWS_SECRET_ACCESS_KEY' is not allowlisted");
      expect(output).not.toContain(SENSITIVE_MARKER);
    } finally {
      stderr.restore();
    }
    expect(fetchCallCount).toBe(0);
  });

  test("runPlan rejects https host abuse without fetching", async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan([
        "run",
        "list catalog",
        "--model=gpt-4o-mini",
        "--base-url=https://api.openai.com@attacker.example/v1",
        "--api-key-env=OPENAI_API_KEY",
      ]);
      expect(code).toBe(1);
      const output = stderr.output();
      expect(output).toContain("baseUrl host 'attacker.example' is not allowlisted");
      expect(output).not.toContain("sk-openai-test");
    } finally {
      stderr.restore();
    }
    expect(fetchCallCount).toBe(0);
  });
});
