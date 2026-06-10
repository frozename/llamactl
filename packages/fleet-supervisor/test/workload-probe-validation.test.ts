/* eslint-disable @typescript-eslint/require-await -- Test fetch stub implements the async fetch contract without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import {
  InvalidEndpointError,
  probeWorkload,
  redactEndpoint,
  validateProbeEndpoint,
} from "../src/workload-probe.js";

describe("validateProbeEndpoint", () => {
  it("accepts loopback", () => {
    expect(() => {
      validateProbeEndpoint("http://127.0.0.1:8096");
    }).not.toThrow();
    expect(() => {
      validateProbeEndpoint("http://localhost:8096");
    }).not.toThrow();
  });

  it("accepts RFC1918 private hosts", () => {
    expect(() => {
      validateProbeEndpoint("http://192.168.68.76:8194");
    }).not.toThrow();
    expect(() => {
      validateProbeEndpoint("http://10.0.0.1:8000");
    }).not.toThrow();
    expect(() => {
      validateProbeEndpoint("http://172.16.0.1:8000");
    }).not.toThrow();
  });

  it("accepts .local mDNS names by default", () => {
    expect(() => {
      validateProbeEndpoint("http://macmini.local:8194");
    }).not.toThrow();
  });

  it("rejects 169.254.x.x (AWS / GCE metadata)", () => {
    expect(() => {
      validateProbeEndpoint("http://169.254.169.254/latest/meta-data/");
    }).toThrow(InvalidEndpointError);
  });

  it("rejects unspecified hosts", () => {
    expect(() => {
      validateProbeEndpoint("http://0.0.0.0:8000");
    }).toThrow(InvalidEndpointError);
  });

  it("rejects non-http schemes", () => {
    expect(() => {
      validateProbeEndpoint("file:///etc/passwd");
    }).toThrow(InvalidEndpointError);
    expect(() => {
      validateProbeEndpoint("gopher://x");
    }).toThrow(InvalidEndpointError);
  });

  it("rejects public hosts by default", () => {
    expect(() => {
      validateProbeEndpoint("http://example.com");
    }).toThrow(InvalidEndpointError);
    expect(() => {
      validateProbeEndpoint("http://1.1.1.1");
    }).toThrow(InvalidEndpointError);
  });

  it("allows public hosts when allowPublic=true", () => {
    expect(() => {
      validateProbeEndpoint("http://example.com", true);
    }).not.toThrow();
  });
});

describe("redactEndpoint", () => {
  it("removes userinfo from URLs", () => {
    expect(redactEndpoint("http://user:pass@host:8080/path")).toBe("http://host:8080/path");
  });

  it("preserves URLs without userinfo (returns input verbatim)", () => {
    expect(redactEndpoint("http://127.0.0.1:8096")).toBe("http://127.0.0.1:8096");
  });

  it("returns unmodified string on invalid URL", () => {
    expect(redactEndpoint("not a url")).toBe("not a url");
  });
});

describe("probeWorkload SSRF guard", () => {
  it("treats link-local target as unreachable + no fetch", async () => {
    let fetched = false;
    const result = await probeWorkload(
      { name: "metadata", endpoint: "http://169.254.169.254", kind: "ModelHost" },
      {
        fetch: (async () => {
          fetched = true;
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    expect(fetched).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.consecutiveErrors).toBe(1);
  });
});
