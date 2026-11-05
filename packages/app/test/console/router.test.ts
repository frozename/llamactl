// packages/app/test/console/router.test.ts
// Issue #410, P5a RED — pins the console path router. Four views, one
// optional trailing workload segment on workloads and logs, and a
// ?node= query that is validated against the console node-name rule:
// invalid values surface decoded under `invalidNode` and never under
// `node`. Unknown or malformed paths degrade to the fleet view with
// `notFound`, never a throw. consoleHref is the exact inverse on the
// routes it can express. The module does not exist at the base commit,
// so every case fails by assertion through the import-catch pattern —
// never by import error.

import { describe, expect, test } from "bun:test";

const ROUTER_SPEC = "../../src/console/router.ts";

interface ConsoleRoute {
  view: string;
  workload?: string;
  node?: string;
  invalidNode?: string;
  notFound?: boolean;
}

interface ConsoleRouterModule {
  parseConsoleRoute?: (pathname: string, search: string) => ConsoleRoute;
  consoleHref?: (route: ConsoleRoute) => string;
}

async function importRouter(): Promise<ConsoleRouterModule | null> {
  return (await import(ROUTER_SPEC).catch(() => null)) as ConsoleRouterModule | null;
}

describe("console router (#410 P5a)", () => {
  test("parses the four views and their workload deep links", async () => {
    const mod = await importRouter();
    expect(mod?.parseConsoleRoute).toBeFunction();

    const parse = mod!.parseConsoleRoute!;
    expect(parse("/", "")).toEqual({ view: "fleet" });
    expect(parse("/fleet", "")).toEqual({ view: "fleet" });
    expect(parse("/workloads", "")).toEqual({ view: "workloads" });
    expect(parse("/workloads/", "")).toEqual({ view: "workloads" });
    expect(parse("/workloads/qwen-coder", "")).toEqual({
      view: "workloads",
      workload: "qwen-coder",
    });
    expect(parse("/workloads/a%20b", "")).toEqual({ view: "workloads", workload: "a b" });
    expect(parse("/nodes", "")).toEqual({ view: "nodes" });
    expect(parse("/logs", "")).toEqual({ view: "logs" });
    expect(parse("/logs/qwen-coder", "")).toEqual({ view: "logs", workload: "qwen-coder" });
  });

  test("attaches a valid ?node= to the parsed route", async () => {
    const mod = await importRouter();
    expect(mod?.parseConsoleRoute).toBeFunction();

    const parse = mod!.parseConsoleRoute!;
    expect(parse("/nodes", "?node=gpu-1")).toEqual({ view: "nodes", node: "gpu-1" });
    expect(parse("/workloads/qwen", "?node=gpu-1")).toEqual({
      view: "workloads",
      workload: "qwen",
      node: "gpu-1",
    });
  });

  test("invalid ?node= values surface decoded under invalidNode, never node", async () => {
    const mod = await importRouter();
    expect(mod?.parseConsoleRoute).toBeFunction();

    const parse = mod!.parseConsoleRoute!;
    for (const [search, decoded] of [
      ["?node=..%2Fx", "../x"],
      ["?node=a%20b", "a b"],
    ] as const) {
      const route = parse("/", search);
      expect(route).toEqual({ view: "fleet", invalidNode: decoded });
      expect("node" in route).toBe(false);
    }
  });

  test("unknown, nested and malformed paths degrade to fleet notFound without throwing", async () => {
    const mod = await importRouter();
    expect(mod?.parseConsoleRoute).toBeFunction();

    const parse = mod!.parseConsoleRoute!;
    for (const pathname of [
      "/chat",
      "/api/x",
      "/workloads/a/b",
      "/nodes/x",
      "/workloads/%E0%A4%A",
    ]) {
      let route: ConsoleRoute | undefined;
      expect(() => {
        route = parse(pathname, "");
      }).not.toThrow();
      expect(route).toEqual({ view: "fleet", notFound: true });
    }
  });

  test("a valid ?node= is still attached on notFound routes", async () => {
    const mod = await importRouter();
    expect(mod?.parseConsoleRoute).toBeFunction();

    expect(mod!.parseConsoleRoute!("/chat", "?node=gpu-1")).toEqual({
      view: "fleet",
      notFound: true,
      node: "gpu-1",
    });
  });

  test("consoleHref renders view paths and drops workload off workload-less views", async () => {
    const mod = await importRouter();
    expect(mod?.consoleHref).toBeFunction();

    const href = mod!.consoleHref!;
    expect(href({ view: "fleet" })).toBe("/");
    expect(href({ view: "workloads", workload: "a b", node: "gpu-1" })).toBe(
      "/workloads/a%20b?node=gpu-1",
    );
    expect(href({ view: "nodes", workload: "x" })).toBe("/nodes");
    expect(href({ view: "fleet", workload: "x" })).toBe("/");
  });

  test("consoleHref round-trips through parseConsoleRoute", async () => {
    const mod = await importRouter();
    expect(mod?.consoleHref).toBeFunction();
    expect(mod?.parseConsoleRoute).toBeFunction();

    const href = mod!.consoleHref!;
    const parse = mod!.parseConsoleRoute!;
    const routes: ConsoleRoute[] = [
      { view: "fleet" },
      { view: "fleet", node: "gpu-1" },
      { view: "nodes" },
      { view: "nodes", node: "gpu-1" },
      { view: "workloads" },
      { view: "workloads", node: "gpu-1" },
      { view: "workloads", workload: "qwen" },
      { view: "workloads", workload: "a b", node: "gpu-1" },
      { view: "logs" },
      { view: "logs", workload: "qwen", node: "gpu-1" },
    ];
    for (const route of routes) {
      const url = href(route);
      const boundary = url.indexOf("?");
      const pathname = boundary === -1 ? url : url.slice(0, boundary);
      const search = boundary === -1 ? "" : url.slice(boundary);
      expect(parse(pathname, search)).toEqual(route);
    }
  });
});
