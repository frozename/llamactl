// Part of #522
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#522 runbook workload phase read-out", () => {
  const runbook = flat(sectionBody(/^## Exclusive-window runbook/) ?? "");
  const workloadSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
  const modelhostSrc = readOrEmpty(join(REPO, "packages/remote/src/server/modelhost.ts"));
  const coreServerSrc = readOrEmpty(join(REPO, "packages/core/src/server.ts"));

  const S3_COLUMNS =
    "`llamactl get workloads` prints one row per manifest under the columns `NAME`, `NODE`, `KIND`, `PHASE` and `REL`, where `KIND` is `modelrun` or `modelhost` and `REL` is a ModelRun's target or a ModelHost's hosted model rels joined by commas; an empty store prints `No workloads registered.` and `--json` prints the rows as a JSON array instead.";
  const S3_HOST_PHASES =
    "A ModelHost whose `spec.node` is `local` reads `Stopped` when it has no runtime state file, `Unreachable` when a state file exists but its endpoint does not answer, `Foreign` when the endpoint answers but its recorded pid is not alive or another pid holds its port, and `Running` otherwise; any other ModelHost, including every z13 template (`node: z13`) even when llamactl runs on z13 itself, reads what its node's agent reports: `Running`, `Stopped`, `unknown` when the node cannot confirm the recorded pid, or `Unreachable` when the node query fails or misses its deadline (10 s by default, or the node's `rpcTimeouts.queryMs` in the kubeconfig).";
  const S3_RUN_PHASES =
    "A ModelRun reads `Foreign` when a process llamactl did not record answers on its port, `Running` when its node reports the server up on the manifest's target, `Mismatch` when it is up on another rel, `Stopped` otherwise, including when the node cannot confirm the recorded pid, and `Unreachable` when the node query fails or misses its deadline; a gateway ModelRun shows its stored phase, `Pending` when none was written.";
  const S3_TRAILERS =
    "Below the table, a non-loopback ModelHost adds a `warning: modelhost/<name> binds an unauthenticated engine to <host:port>` line, an externally managed ModelHost adds a `note: modelhost/<name> is managed by <controller>` line, and a row whose node query failed adds `unreachable: <kind>/<name> on node <node>, last answered <time|never>: <error>`.";
  // prettier-ignore
  const S3_CONFIRM =
    "`Stopped` confirms the stop only when `llamactl describe workload <production-workload>` shows no `\"identityUnknown\": true` under `LiveStatus:`, because a ModelRun whose recorded pid cannot be confirmed also reads `Stopped` while its process may still be resident; `Unreachable`, `Foreign` and `unknown` never prove the process is gone.";
  const S7_HOST =
    "For a ModelHost, `llamactl describe workload <name>` prints the manifest as `Name:`, `Kind:`, `Node:`, `Engine:`, `Binary:`, `Models:`, `Endpoint:`, `Enabled:`, `ExtraArgs:` and `RestartPolicy:` lines, an `IdleHold:` line only when the manifest carries the idle hold, then its history (for a `local` host a `Source:` line and the conditions only when the node reports them; for any other host always a `Source: controller history` line, then a `NodeHistory:` line when the node reports its own conditions), and last a `LiveStatus:` block holding the node's `modelHostStatus` JSON.";
  // prettier-ignore
  const S7_HOST_STATE =
    "It prints no `PHASE` column: the engine is up when `LiveStatus:` carries `\"state\": \"Running\"` with its `\"pid\"`; `\"state\": \"Stopped\"` without `\"identityUnknown\": true` means no live recorded process, `\"state\": \"Stopped\"` with `\"identityUnknown\": true` means the node cannot confirm the recorded pid and the engine may still be resident, and an `\"error\"` object means the node query failed or missed its deadline.";
  // prettier-ignore
  const S7_RUN =
    "For a ModelRun it prints `Name:`, `Node:`, `Target:`, `ExtraArgs:` and `RestartPolicy:` lines, an optional `IdleHold:` line, a `Status:` line reading `phase=<phase> endpoint=<endpoint|none> pid=<pid|none> since=<time>` when the manifest has a stored status, and the node's `serverStatus` JSON under `LiveStatus:`, whose `\"state\"` is `\"up\"` or `\"down\"`; `\"down\"` with `\"identityUnknown\": true` means the recorded pid cannot be confirmed and the server may still be resident, an `\"error\"` object means the node query failed or missed its deadline, and the `Status:` line is the stored status, not a live probe.";
  // prettier-ignore
  const S9_VERIFY =
    "Verify Running as `Running` in the `PHASE` column of `llamactl get workloads` for the production workload and, in `llamactl describe workload <production-workload>`, `\"state\": \"Running\"` under `LiveStatus:` for a ModelHost or `\"state\": \"up\"` for a ModelRun.";

  const S3_SENTENCES = [S3_COLUMNS, S3_HOST_PHASES, S3_RUN_PHASES, S3_TRAILERS, S3_CONFIRM];
  const S7_SENTENCES = [S7_HOST, S7_HOST_STATE, S7_RUN];

  // Kills: omitting the table-shape, phase-meaning, trailer or stop-proof
  // prose from the stop step, or citing unstable file:line anchors.
  test("step 3 documents workload phases and what Stopped proves", () => {
    for (const sentence of S3_SENTENCES) {
      expect(runbook, sentence.slice(0, 60)).toContain(flat(sentence));
    }
    expect(/\.ts:\d/.test(runbook), "no file:line citation").toBe(false);
  });

  // Kills: placing the phase read-out outside the stop-production step,
  // where the operator decides whether the window can open.
  test("the workload phase sentences sit inside step 3", () => {
    const lo = runbook.indexOf("3. Stop production");
    const hi = runbook.indexOf("4. Diff the template");
    expect(lo, "step 3 anchor").toBeGreaterThanOrEqual(0);
    expect(hi, "step 4 anchor").toBeGreaterThan(lo);
    for (const sentence of S3_SENTENCES) {
      const at = runbook.indexOf(flat(sentence));
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeGreaterThan(lo);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeLessThan(hi);
    }
  });

  // Kills: omitting the describe-output read-out from the readiness step or
  // flattening away the difference between stored status and live node state.
  test("the describe workload sentences sit inside step 7", () => {
    const lo = runbook.indexOf("7. Wait for the readiness probe");
    const hi = runbook.indexOf("8. Run the eval");
    expect(lo, "step 7 anchor").toBeGreaterThanOrEqual(0);
    expect(hi, "step 8 anchor").toBeGreaterThan(lo);
    for (const sentence of S7_SENTENCES) {
      const at = runbook.indexOf(flat(sentence));
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeGreaterThan(lo);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeLessThan(hi);
    }
  });

  // Kills: leaving the exit check as an unexplained "verify Running", or
  // moving the concrete get/describe evidence outside the exit step.
  test("step 9 documents the production Running verification", () => {
    const exitIdx = runbook.indexOf("Exit the window");
    const neverIdx = runbook.indexOf("Never run two group members");
    expect(exitIdx, "step 9 anchor").toBeGreaterThanOrEqual(0);
    expect(neverIdx, "post-runbook warning anchor").toBeGreaterThan(exitIdx);
    const at = runbook.indexOf(flat(S9_VERIFY));
    expect(at, `missing: ${S9_VERIFY.slice(0, 60)}`).toBeGreaterThan(exitIdx);
    expect(at, `missing: ${S9_VERIFY.slice(0, 60)}`).toBeLessThan(neverIdx);
  });

  // Kills: changing the table header, the empty-store text, the local/remote
  // ModelHost split, or the warning/note ordering the prose describes.
  test("source: get workloads renders the documented table and trailers", () => {
    const body = enclosingBody(workloadSrc, "export async function runGet(");
    expect(body, "runGet signature").not.toBe("");
    for (const phrase of [
      '`${pad("NAME", nameW)}  ${pad("NODE", nodeW)}  ${pad("KIND", kindW)}  ${pad("PHASE", phaseW)}  REL\\n`',
      "No workloads registered.",
      "manifest.spec.node === LOCAL_NODE_ID",
      "inspectRemoteModelHost(manifest)",
    ]) {
      expect(body, phrase).toContain(phrase);
    }
    const warnings = body.indexOf("writeExternalBindWarnings(rows)");
    const managed = body.indexOf("writeManagedByNotes(rows)");
    const unreachable = body.indexOf("writeUnreachableNotes(rows)");
    expect(warnings, "external bind warnings").toBeGreaterThanOrEqual(0);
    expect(managed, "managed-by notes").toBeGreaterThan(warnings);
    expect(unreachable, "unreachable notes").toBeGreaterThan(managed);
  });

  // Kills: dropping a workload phase from the row type without updating the
  // operator-facing vocabulary.
  test("source: workload rows keep the documented phase union", () => {
    expect(workloadSrc).toContain(
      'phase: "Running" | "Stopped" | "Mismatch" | "Unreachable" | "Pending" | "Failed" | "Foreign";',
    );
  });

  // Kills: reordering or collapsing the local ModelHost verdicts so a dead
  // endpoint, foreign listener or live recorded pid reads as another phase.
  test("source: local ModelHost inspection keeps the documented phase precedence", () => {
    const body = enclosingBody(workloadSrc, "async function inspectLocalModelHost(");
    expect(body, "inspectLocalModelHost signature").not.toBe("");
    for (const phrase of [
      'let phase: ModelHostLive["phase"] = "Stopped";',
      'phase = "Unreachable";',
      'phase = "Foreign";',
      'phase = "Running";',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
    expect(body.indexOf("!ownership.reachable")).toBeLessThan(body.indexOf('phase = "Foreign";'));
  });

  // Kills: losing the remote ModelHost distinction between a proven stop, an
  // unconfirmed pid identity and a node query failure.
  test("source: remote ModelHost inspection reports unknown and unreachable distinctly", () => {
    const body = enclosingBody(workloadSrc, "async function inspectRemoteModelHost(");
    expect(body, "inspectRemoteModelHost signature").not.toBe("");
    expect(body).toContain('status.identityUnknown === true ? "unknown" : "Stopped"');
    expect(body).toContain('phase: "Unreachable"');
  });

  // Kills: letting a squatter read as Running, reversing the foreign-first
  // precedence, or treating an unknown recorded-pid identity as proof of stop.
  test("source: ModelRun inspection keeps gateway, foreign and stop semantics", () => {
    const body = enclosingBody(
      workloadSrc,
      "async function inspect(manifest: workloadSchema.ModelRun)",
    );
    expect(body, "inspect ModelRun signature").not.toBe("");
    expect(body).toContain('status?.phase ?? "Pending"');
    expect(body).toContain('let phase: WorkloadRow["phase"] = "Stopped";');
    expect(body).toContain('if (status.foreign) phase = "Foreign";');
    expect(body.indexOf('if (status.foreign) phase = "Foreign";')).toBeLessThan(
      body.indexOf('phase = "Running";'),
    );
    expect(body).not.toContain("identityUnknown");
  });

  // Kills: removing the node query deadline or its kubeconfig override while
  // the runbook still promises a bounded Unreachable verdict.
  test("source: node queries keep the documented deadline and kubeconfig override", () => {
    expect(workloadSrc).toContain("const GET_NODE_QUERY_TIMEOUT_MS = 10_000;");
    const body = enclosingBody(workloadSrc, "export function nodeQueryTimeoutMsFor(");
    expect(body, "nodeQueryTimeoutMsFor signature").not.toBe("");
    expect(body).toContain("rpcTimeouts?.queryMs");
    expect(body).toContain("return GET_NODE_QUERY_TIMEOUT_MS;");
  });

  // Kills: dropping manifest fields, history or LiveStatus from the ModelHost
  // describe output the runbook teaches operators to inspect.
  test("source: describe ModelHost renders the documented fields, history and live status", () => {
    const body = enclosingBody(workloadSrc, "async function runDescribeModelHost(");
    expect(body, "runDescribeModelHost signature").not.toBe("");
    for (const phrase of [
      "`Kind:       ModelHost\\n`",
      "`Enabled:    ",
      "writeHostHistory(",
      "writeLiveStatus(liveStatus)",
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  // Kills: conflating local sidecar history with controller history or hiding
  // node-side conditions behind the controller's record.
  test("source: ModelHost history keeps local, controller and node sources distinct", () => {
    const body = enclosingBody(workloadSrc, "function writeHostHistory(");
    expect(body, "writeHostHistory signature").not.toBe("");
    expect(body).toContain("`Source:     modelhost.conditions.json on local");
    expect(body).toContain("`Source:     controller history (none recorded)");
    expect(body).toContain("`NodeHistory: ");
  });

  // Kills: dropping the target or stored-status line from ModelRun describe,
  // which would leave operators unable to separate stored state from a probe.
  test("source: describe ModelRun renders target and stored status", () => {
    const body = enclosingBody(workloadSrc, "async function runDescribeWorkload(");
    expect(body, "runDescribeWorkload signature").not.toBe("");
    expect(body).toContain("`Target:     ");
    expect(body).toContain("phase=${manifest.status.phase} endpoint=");
  });

  // Kills: removing the LiveStatus label the runbook uses for both workload
  // kinds.
  test("source: describe workload labels live status", () => {
    const body = enclosingBody(workloadSrc, "function writeLiveStatus(");
    expect(body, "writeLiveStatus signature").not.toBe("");
    expect(body).toContain("`LiveStatus: ");
  });

  // Kills: changing the ModelHost status wire shape or losing the explicit
  // identity-unknown bit that prevents an unknown pid from proving a stop.
  test("source: modelHostStatus exposes state, pid and identityUnknown", () => {
    const result = enclosingBody(modelhostSrc, "export interface StatusModelHostResult {");
    expect(result, "StatusModelHostResult signature").not.toBe("");
    expect(result).toContain('state: "Running" | "Stopped";');
    expect(result).toContain("identityUnknown?: boolean;");

    const body = enclosingBody(modelhostSrc, "export function statusModelHost(");
    expect(body, "statusModelHost signature").not.toBe("");
    expect(body).toContain('identityUnknown: verdict === "unknown" ? true : undefined');
    expect(body).toContain("pid: state.pid,");
  });

  // Kills: weakening the serverStatus contract that says identityUnknown is
  // not evidence the recorded process is gone.
  test("source: serverStatus keeps up/down and the identityUnknown warning", () => {
    expect(coreServerSrc).toContain('state: "up" | "down";');
    expect(coreServerSrc).toContain("identityUnknown?: boolean;");
    expect(coreServerSrc).toContain(
      "process may still be resident, so callers must not treat it as stopped.",
    );
  });
});
