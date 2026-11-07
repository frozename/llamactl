import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  BEARER_TOKEN_NAME,
  type BootstrapBlob,
  decodeBootstrap,
  defaultAgentConfigPath,
  defaultAgentDir,
  encodeBootstrap,
} from "../../src/config/agent-config.js";

const BLOB: BootstrapBlob = {
  url: "https://10.0.0.7:7843",
  fingerprint: "sha256:" + "ab".repeat(32),
  token: "tok-\u00e9>?~",
  certificate: "-----BEGIN CERTIFICATE-----\nMIIB\xff\n-----END CERTIFICATE-----\n",
};

test("fixture base64 contains at least one of +, /, =", () => {
  expect(Buffer.from(JSON.stringify(BLOB), "utf8").toString("base64")).toMatch(/[+/=]/);
});

const raw = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("encodeBootstrap / decodeBootstrap", () => {
  test("encodes to the unpadded base64url alphabet", () => {
    expect(encodeBootstrap(BLOB)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("decode(encode(blob)) returns the same four fields, newlines and non-ASCII intact", () => {
    expect(decodeBootstrap(encodeBootstrap(BLOB))).toEqual(BLOB);
  });

  test("decodes a blob that has only the four string fields to exactly those four keys, dropping extras", () => {
    const result = decodeBootstrap(raw({ ...BLOB, extra: "x", port: 1 }));
    expect(Object.keys(result).sort()).toEqual(["certificate", "fingerprint", "token", "url"]);
    expect(result).toEqual(BLOB);
  });

  test("checks fields in the order url, fingerprint, token, certificate", () => {
    const e1 = expect(() => decodeBootstrap(raw({})));
    e1.toThrow("bootstrap: missing url");

    const e2 = expect(() => decodeBootstrap(raw({ url: BLOB.url })));
    e2.toThrow("bootstrap: missing fingerprint");

    const e3 = expect(() => decodeBootstrap(raw({ url: BLOB.url, fingerprint: BLOB.fingerprint })));
    e3.toThrow("bootstrap: missing token");

    const e4 = expect(() =>
      decodeBootstrap(
        raw({
          url: BLOB.url,
          fingerprint: BLOB.fingerprint,
          token: BLOB.token,
        }),
      ),
    );
    e4.toThrow("bootstrap: missing certificate");
  });

  test("a non-string field is reported as missing", () => {
    const e1 = expect(() => decodeBootstrap(raw({ ...BLOB, url: 1 })));
    e1.toThrow("bootstrap: missing url");

    const e2 = expect(() => decodeBootstrap(raw({ ...BLOB, token: null })));
    e2.toThrow("bootstrap: missing token");

    const e3 = expect(() => decodeBootstrap(raw({ ...BLOB, certificate: ["pem"] })));
    e3.toThrow("bootstrap: missing certificate");
  });

  test("a payload that is not JSON throws a SyntaxError", () => {
    expect(() => decodeBootstrap(Buffer.from("not json", "utf8").toString("base64url"))).toThrow(
      SyntaxError,
    );
  });
});

describe("defaultAgentDir / defaultAgentConfigPath", () => {
  test("LLAMACTL_AGENT_DIR wins over DEV_STORAGE", () => {
    expect(
      defaultAgentDir({
        LLAMACTL_AGENT_DIR: "/srv/llamactl-agent",
        DEV_STORAGE: "/data/dev",
      }),
    ).toBe("/srv/llamactl-agent");
  });

  test("LLAMACTL_AGENT_DIR is trimmed", () => {
    expect(
      defaultAgentDir({
        LLAMACTL_AGENT_DIR: "  /srv/llamactl-agent  ",
      }),
    ).toBe("/srv/llamactl-agent");
  });

  test("a blank LLAMACTL_AGENT_DIR falls through to DEV_STORAGE", () => {
    expect(defaultAgentDir({ LLAMACTL_AGENT_DIR: "", DEV_STORAGE: "/data/dev" })).toBe("/data/dev");
    expect(defaultAgentDir({ LLAMACTL_AGENT_DIR: "   ", DEV_STORAGE: "/data/dev" })).toBe(
      "/data/dev",
    );
  });

  test("defaultAgentConfigPath is agent.yaml under the override dir", () => {
    expect(
      defaultAgentConfigPath({
        LLAMACTL_AGENT_DIR: "/srv/llamactl-agent",
      }),
    ).toBe(join("/srv/llamactl-agent", "agent.yaml"));
  });
});

describe("BEARER_TOKEN_NAME", () => {
  test("accepts lowercase names up to 63 characters", () => {
    const names = ["a", "0", "ci-runner.v2_1", "a" + "b".repeat(62)];
    for (const name of names) {
      if (name === names[names.length - 1]) expect(name.length).toBe(63);
      expect(BEARER_TOKEN_NAME.test(name)).toBe(true);
    }
  });

  test("rejects a 64-character name", () => {
    expect(BEARER_TOKEN_NAME.test("a" + "b".repeat(63))).toBe(false);
  });

  test("rejects an empty name, a leading ., - or _, uppercase, spaces and slashes", () => {
    const names = ["", ".hidden", "-dash", "_under", "Ops", "has space", "a/b"];
    for (const name of names) {
      expect(BEARER_TOKEN_NAME.test(name)).toBe(false);
    }
  });
});
