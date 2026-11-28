import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectOmlxOwnerSocket } from "../../src/residency/omlx-owner-socket.js";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import {
  loadInitiallyOwnedOmlx,
  prepareOmlxNativeAuth,
} from "../../src/server/omlx-cache-launch.js";

test("native oMLX launch rotates the signing secret and never persists the inference key", () => {
  const base = mkdtempSync(join(tmpdir(), "llamactl-omlx-native-auth-"));
  const path = join(base, "settings.json");
  const oldSigningKey = "fake-legacy-key";
  try {
    writeFileSync(
      path,
      JSON.stringify({ cache: { enabled: true }, auth: { secret_key: oldSigningKey } }),
      { mode: 0o600 },
    );
    const native = prepareOmlxNativeAuth(base, { PATH: "/usr/bin" });
    expect(native.env["PATH"]).toBe("/usr/bin");
    expect(native.env["OMLX_API_KEY"]).toBe(native.apiKey);
    expect(native.apiKey.length).toBeGreaterThanOrEqual(32);
    expect(native.env["OMLX_SECRET_KEY"]).not.toBe(oldSigningKey);
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain(native.apiKey);
    expect(JSON.parse(saved)).toMatchObject({
      cache: { enabled: true },
      auth: {
        api_key: null,
        secret_key: native.env["OMLX_SECRET_KEY"],
        allow_unauthenticated_inference: false,
        skip_api_key_verification: false,
        sub_keys: [],
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(native.verify()).toBe(true);
    const changed = saved.replace(
      '"allow_unauthenticated_inference":false',
      '"allow_unauthenticated_inference":true',
    );
    expect(changed).not.toBe(saved);
    writeFileSync(path, changed, { mode: 0o600 });
    expect(native.verify()).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("native oMLX launch refuses alternate authentication and keeps the settings intact", () => {
  const base = mkdtempSync(join(tmpdir(), "llamactl-omlx-native-auth-"));
  const path = join(base, "settings.json");
  try {
    for (const auth of [
      { sub_keys: [{ api_key: "fake-other-access" }] },
      { allow_unauthenticated_inference: true },
      { skip_api_key_verification: true },
      { api_key: "fake-external-access" },
    ]) {
      const old = JSON.stringify({ auth });
      writeFileSync(path, old, { mode: 0o600 });
      expect(() => prepareOmlxNativeAuth(base, {})).toThrow(
        "oMLX native launch requires exclusive authentication",
      );
      expect(readFileSync(path, "utf8")).toBe(old);
    }
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(() => prepareOmlxNativeAuth(base, { OMLX_API_KEY: "fake-overridden" })).toThrow(
      "oMLX native launch owns its authentication environment",
    );
    expect(readFileSync(path, "utf8")).toBe("{}");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("native oMLX launch keeps malformed private settings out of errors", () => {
  const base = mkdtempSync(join(tmpdir(), "llamactl-omlx-native-auth-"));
  try {
    const path = join(base, "settings.json");
    const malformed = '{"auth": "fake-private-text", invalid}';
    writeFileSync(path, malformed, { mode: 0o600 });
    expect(() => prepareOmlxNativeAuth(base, {})).toThrow(
      "oMLX native launch could not read private settings",
    );
    expect(readFileSync(path, "utf8")).toBe(malformed);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("native oMLX launch refuses a settings symlink before reading or replacing its target", () => {
  const base = mkdtempSync(join(tmpdir(), "llamactl-omlx-native-auth-"));
  try {
    const target = join(base, "old.json");
    const link = join(base, "settings.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => prepareOmlxNativeAuth(base, {})).toThrow(
      "oMLX native launch requires private settings",
    );
    expect(readFileSync(target, "utf8")).toBe("{}");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("initial native load requires the exact reservation and fresh capacity at dispatch", async () => {
  const key = "fixture-private-engine";
  const modelId = "fixture";
  const modelPath = "/tmp/qualification/fixture";
  let resident = false;
  let reserved = true;
  let revokeOnStatus = true;
  let headroom = true;
  let revokeHeadroomAfterStatus = false;
  let statusObserved = false;
  const actions: string[] = [];
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        return new Response(null, { status: 401 });
      }
      if (path === "/api/status") {
        return Response.json({ version: "0.8.4", active_requests: 0, waiting_requests: 0 });
      }
      if (path === "/v1/models") return Response.json({ data: [{ id: modelId }] });
      if (path === "/v1/models/status") {
        statusObserved = true;
        if (revokeOnStatus) reserved = false;
        return Response.json({
          models: [
            {
              id: modelId,
              model_path: modelPath,
              engine_type: "batched",
              loaded: resident,
              is_loading: false,
            },
          ],
        });
      }
      actions.push(path);
      if (path === "/v1/models/fixture/load" && request.method === "POST") {
        resident = true;
        return Response.json({ status: "ok", model_id: modelId });
      }
      if (path === "/health" && resident) return Response.json({ status: "ready" });
      return new Response(null, { status: 503 });
    },
  });
  const endpoint = { host: server.url.hostname, port: Number(server.url.port) };
  const openSocket = connectOmlxOwnerSocket(endpoint, process.pid, () => true);
  const bootstrap = (): Promise<boolean> =>
    loadInitiallyOwnedOmlx({
      binding: {
        endpoint,
        modelId,
        modelPath,
        artifactRevision: "fixture-artifact",
        runtimeGeneration: "fixture-generation",
        stillCurrent: (): boolean => true,
      },
      apiKey: key,
      readiness: { path: "/health", expectStatus: 200, expectJson: { status: "ready" } },
      verifyReservation: () => reserved,
      admitLoad: () => headroom,
      async connect(signal) {
        const socket = await openSocket(signal);
        if (revokeHeadroomAfterStatus && statusObserved) headroom = false;
        return socket;
      },
      signal: AbortSignal.timeout(1500),
    });

  expect(await bootstrap()).toBe(false);
  expect(actions).toEqual([]);
  reserved = true;
  revokeOnStatus = false;
  statusObserved = false;
  revokeHeadroomAfterStatus = true;
  expect(await bootstrap()).toBe(false);
  expect(actions).toEqual([]);
  revokeHeadroomAfterStatus = false;
  headroom = true;
  expect(await bootstrap()).toBe(true);
  expect(actions).toEqual(["/v1/models/fixture/load", "/health"]);
  expect(resident).toBe(true);
});
