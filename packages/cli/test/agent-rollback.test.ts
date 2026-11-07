import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentRollback } from "../src/commands/agent-rollback.js";
import { resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessIo } from "./helpers.js";

const CONFIG_YAML = `apiVersion: llamactl/v1
kind: Config
currentContext: home
contexts:
  - {name: home, cluster: lab, user: op, defaultNode: local}
  - {name: orphan-user, cluster: lab, user: ghost-user}
clusters:
  - name: lab
    nodes:
      - {name: local, endpoint: "inproc://local"}
      - {name: sidecar, endpoint: "inproc://sidecar"}
      - {name: gpu1, endpoint: "https://gpu1.invalid:7843"}
users:
  - {name: op, token: test-token}
`;

let dir = "";
const priorEnvConfig = process.env["LLAMACTL_CONFIG"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-agent-rollback-"));
  writeFileSync(join(dir, "config"), CONFIG_YAML);
  process.env["LLAMACTL_CONFIG"] = join(dir, "config");
});

afterEach(() => {
  resetGlobals();
  if (priorEnvConfig === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  else process.env["LLAMACTL_CONFIG"] = priorEnvConfig;
  rmSync(dir, { recursive: true, force: true });
});

describe("agent rollback: flag parsing and node resolution", () => {
  describe("exit codes", () => {
    test("--help gives 0 with expected output", async () => {
      const {
        result: code,
        cap: { out, err },
      } = await captureProcessIo(() => runAgentRollback(["--help"]));
      expect(code).toBe(0);
      expect(out).toContain("llamactl agent rollback — restore the previous agent binary");
      expect(out).toContain("--readiness-timeout=<s>");
      expect(err).toBe("");
    });

    test("-h gives 0 with expected output", async () => {
      const {
        result: code,
        cap: { out, err },
      } = await captureProcessIo(() => runAgentRollback(["-h"]));
      expect(code).toBe(0);
      expect(out).toContain("llamactl agent rollback — restore the previous agent binary");
      expect(out).toContain("--readiness-timeout=<s>");
      expect(err).toBe("");
    });

    test("--verbose (no =) gives 1", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--verbose"]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: flags must be --key=value (--verbose)");
      expect(err).toContain("USAGE:");
    });

    test("--bogus=1 gives 1 with unknown flag error", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--bogus=1"]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: unknown flag --bogus");
    });

    test("--readiness-timeout=0 gives 1", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--readiness-timeout=0"]));
      expect(code).toBe(1);
      expect(err).toContain(
        "agent rollback: --readiness-timeout must be a positive integer (got 0)",
      );
    });

    test("--readiness-timeout=-5 gives 1", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--readiness-timeout=-5"]));
      expect(code).toBe(1);
      expect(err).toContain(
        "agent rollback: --readiness-timeout must be a positive integer (got -5)",
      );
    });

    test("--readiness-timeout=abc gives 1", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--readiness-timeout=abc"]));
      expect(code).toBe(1);
      expect(err).toContain(
        "agent rollback: --readiness-timeout must be a positive integer (got abc)",
      );
    });

    test("flags handled left to right: first error wins (--bogus=1 before --help)", async () => {
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--bogus=1", "--help"]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: unknown flag --bogus");
    });

    test("flags handled left to right: --help before --bogus=1", async () => {
      const {
        result: code,
        cap: { out },
      } = await captureProcessIo(() => runAgentRollback(["--help", "--bogus=1"]));
      expect(code).toBe(0);
      expect(out).toContain("USAGE:");
    });

    test("no nodeName (context defaultNode local) gives 1", async () => {
      setGlobals({ nodeName: null, contextName: null, configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: --node is required + must point at a non-local agent");
    });

    test("nodeName 'local' gives 1", async () => {
      setGlobals({ nodeName: "local", contextName: null, configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: --node is required + must point at a non-local agent");
    });

    test("unknown node 'ghost' gives 1", async () => {
      setGlobals({ nodeName: "ghost", contextName: null, configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: node 'ghost' not found in current context");
    });

    test("unknown context gives 1", async () => {
      setGlobals({ nodeName: "gpu1", contextName: "nope", configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: context not found in kubeconfig");
    });

    test("non-local in-proc node gives 1", async () => {
      setGlobals({ nodeName: "sidecar", contextName: null, configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain(
        "agent rollback: 'sidecar' is a local in-proc node — nothing to roll back",
      );
    });

    test("missing user in orphan context gives 1", async () => {
      setGlobals({ nodeName: "gpu1", contextName: "orphan-user", configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback([]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: user 'ghost-user' not found in kubeconfig");
    });

    test("parseInt leniency pinned: '5s' accepted as 5, --json consumed", async () => {
      setGlobals({ nodeName: "ghost", contextName: null, configPath: null });
      const {
        result: code,
        cap: { err },
      } = await captureProcessIo(() => runAgentRollback(["--readiness-timeout=5s", "--json"]));
      expect(code).toBe(1);
      expect(err).toContain("agent rollback: node 'ghost' not found in current context");
      expect(err).not.toContain("positive integer");
    });
  });

  describe("error cases: no network attempted", () => {
    const errorCases: {
      label: string;
      globals: { nodeName: string | null; contextName: string | null; configPath: string | null };
    }[] = [
      {
        label: "no nodeName (default local)",
        globals: { nodeName: null, contextName: null, configPath: null },
      },
      {
        label: "nodeName 'local'",
        globals: { nodeName: "local", contextName: null, configPath: null },
      },
      {
        label: "unknown node 'ghost'",
        globals: { nodeName: "ghost", contextName: null, configPath: null },
      },
      {
        label: "unknown context",
        globals: { nodeName: "gpu1", contextName: "nope", configPath: null },
      },
      {
        label: "non-local in-proc 'sidecar'",
        globals: { nodeName: "sidecar", contextName: null, configPath: null },
      },
      {
        label: "missing user",
        globals: { nodeName: "gpu1", contextName: "orphan-user", configPath: null },
      },
    ];

    for (const { label, globals } of errorCases) {
      test(`${label}: no network request attempted`, async () => {
        setGlobals(globals);
        const { result: code, cap } = await captureProcessIo(() => runAgentRollback([]));
        expect(code).toBe(1);
        expect(cap.out).toBe("");
        expect(cap.err).not.toContain("requesting swap");
      });
    }
  });
});
