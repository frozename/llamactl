import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve as resolveNodePath } from "node:path";

import { __resetWorkloadTestSeams, runApply, runDelete, runGet } from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins for `llamactl apply` / `get` / `delete` workload argument handling
 * (frozename/llamactl#335). Each test isolates one rule and names the
 * mutation it would catch.
 */

let tmp = "";
let originalEnv: NodeJS.ProcessEnv = {};

beforeEach(() => {
  originalEnv = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "llamactl-workload-args-"));
  process.env["DEV_STORAGE"] = tmp;
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  mkdirSync(process.env["LLAMACTL_CONFIG"], { recursive: true });
});

afterEach(() => {
  __resetWorkloadTestSeams();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array): boolean => {
    out.push(typeof s === "string" ? s : String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array): boolean => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

// ---- apply (runApply) -------------------------------------------------

describe("apply — argument parsing", () => {
  test('["--help"] -> code 0, usage on stdout (mutation: route help to stderr, or return 1)', async () => {
    const { code, out, err } = await capture(() => runApply(["--help"]));
    expect(code).toBe(0);
    expect(out).toContain("Usage: llamactl apply -f <manifest.yaml>");
    expect(err).toBe("");
  });

  test('["-h"] -> same as --help (mutation: drop "-h" from the help check)', async () => {
    const { code, out, err } = await capture(() => runApply(["-h"]));
    expect(code).toBe(0);
    expect(out).toContain("Usage: llamactl apply -f <manifest.yaml>");
    expect(err).toBe("");
  });

  test("[] -> code 1, no -f given (mutation: remove the `if (!draft.file)` required-file check)", async () => {
    const { code, out, err } = await capture(() => runApply([]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl apply");
    expect(out).toBe("");
  });

  test("missing file at -f (mutation: ignore -f's value)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["-f", p]));
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${p}\n`);
  });

  test("--file= missing (mutation: slice the wrong prefix length for --file=)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["--file=" + p]));
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${p}\n`);
  });

  test("--file missing (mutation: drop the --file long form)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["--file", p]));
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${p}\n`);
  });

  test("positional missing (mutation: remove the positional fallback)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply([p]));
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${p}\n`);
  });

  test("relative path resolves against cwd (mutation: drop resolvePath)", async () => {
    const rel = "rel-missing.yaml";
    const resolved = resolveNodePath(rel);
    const { code, err } = await capture(() => runApply(["-f", rel]));
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${resolved}\n`);
  });

  test("extra positional after -f (mutation: let a second positional overwrite file)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply([p, "extra.yaml"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl apply");
    expect(err).not.toContain("file not found");
  });

  test("unknown flag after -f (mutation: ignore unknown flags)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["-f", p, "--bogus"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl apply");
    expect(err).not.toContain("file not found");
  });

  test("--evict= empty value (mutation: drop the empty-value guard in appendEvict)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["-f", p, "--evict="]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl apply");
    expect(err).not.toContain("file not found");
  });

  test("--evict no value (mutation: drop the empty-value guard in appendEvict)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() => runApply(["-f", p, "--evict"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl apply");
    expect(err).not.toContain("file not found");
  });

  test("--evict with value + --force + --json all parsed (mutation: --evict with separate value not consuming it)", async () => {
    const p = join(tmp, "missing.yaml");
    const { code, err } = await capture(() =>
      runApply(["-f", p, "--evict", "a", "--evict=b", "--force", "--json"]),
    );
    expect(code).toBe(1);
    expect(err).toBe(`apply: file not found: ${p}\n`);
  });

  test("unparseable YAML (mutation: drop the YAML try/catch)", async () => {
    const p = join(tmp, "bad.yaml");
    writeFileSync(p, "kind: [unclosed\n", "utf8");
    const { code, err } = await capture(() => runApply(["-f", p]));
    expect(code).toBe(1);
    expect(err).toBe("apply: manifest YAML is not parseable\n");
  });
});

// ---- get (runGet) -----------------------------------------------------

describe("get — argument parsing", () => {
  test('["workloads", "--bogus"] -> unknown argument (mutation: ignore unknown args)', async () => {
    const { code, err } = await capture(() => runGet(["workloads", "--bogus"]));
    expect(code).toBe(1);
    expect(err).toBe("get: unknown argument --bogus\n");
  });

  test('["pods"] -> usage on wrong subcommand (mutation: accept any subcommand)', async () => {
    const { code, out, err } = await capture(() => runGet(["pods"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl get workloads");
    expect(out).toBe("");
  });

  test('["--json"] in subcommand slot (mutation: sub is args[0])', async () => {
    const { code, err } = await capture(() => runGet(["--json"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl get workloads");
  });

  test('["pods", "--help"] -> help before subcommand check (mutation: help after subcommand check)', async () => {
    const { code, out } = await capture(() => runGet(["pods", "--help"]));
    expect(code).toBe(0);
    expect(out).toContain("Usage: llamactl get workloads");
  });

  test('["workloads", "--json"] with empty dir -> [] (mutation: non-deterministic empty-list output)', async () => {
    const { code, out } = await capture(() => runGet(["workloads", "--json"]));
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]);
  });
});

// ---- delete (runDelete) -----------------------------------------------

describe("delete — argument parsing", () => {
  test('["workload", "x", "--bogus"] -> unknown argument before lookup (mutation: ignore unknown args)', async () => {
    const { code, err } = await capture(() => runDelete(["workload", "x", "--bogus"]));
    expect(code).toBe(1);
    expect(err).toBe("delete: unknown argument --bogus\n");
  });

  test('["workload", "x", "--help"] -> help (mutation: help after name check)', async () => {
    const { code, out } = await capture(() => runDelete(["workload", "x", "--help"]));
    expect(code).toBe(0);
    expect(out).toContain("Usage: llamactl delete workload <name>");
  });

  test('["pods", "x"] -> usage on wrong kind (mutation: accept any kind)', async () => {
    const { code, err } = await capture(() => runDelete(["pods", "x"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl delete workload");
  });

  test('["workload"] no name (mutation: remove the `!name` check)', async () => {
    const { code, err } = await capture(() => runDelete(["workload"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl delete workload");
  });

  test('["workload", "ghost"] not found (mutation: skip the manifest lookup)', async () => {
    const wlDir = join(tmp, "workloads");
    const { code, err } = await capture(() => runDelete(["workload", "ghost"]));
    expect(code).toBe(1);
    expect(err.startsWith("delete: workload manifest not found: ")).toBe(true);
    expect(err).toContain(wlDir);
  });

  test('["noderun", "ghost"] -> not found (mutation: skip noderun lookup)', async () => {
    const { code, err } = await capture(() => runDelete(["noderun", "ghost"]));
    expect(code).toBe(1);
    expect(err).toBe("delete: noderun ghost not found\n");
  });

  test('["noderun"] no name (mutation: remove the noderun `!name` check)', async () => {
    const { code, err } = await capture(() => runDelete(["noderun"]));
    expect(code).toBe(1);
    expect(err).toContain("Usage: llamactl delete workload");
  });
});
