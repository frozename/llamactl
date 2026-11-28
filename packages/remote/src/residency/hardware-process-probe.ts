import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";
import type { SwapCounterSample } from "@llamactl/core/resources/memory";
import type { IncomingMessage } from "node:http";

import { server } from "@llamactl/core";
import { projectManagedCapacity } from "@llamactl/core/resources/managed-capacity";
import { deriveSwapRate } from "@llamactl/core/resources/memory";
import { probeNodeMem } from "@llamactl/fleet-supervisor";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "../safe-fs.js";
import { readLocalManagedCapacity } from "./local-managed-capacity.js";

const HOST = "127.0.0.1";
const PROBE_LOCK = "/tmp/llamactl-residency-hardware-smoke.lock";
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_STREAM_BYTES = 64 * 1024;
const MAX_COMPLETION_TOKENS = 8;
const BENCHMARK_PROMPT = "Reply with exactly the single word OK.";

const planSchema = z.strictObject({
  binary: z.string().refine(isAbsolute),
  binarySha256: SHA256,
  artifact: z.string().refine(isAbsolute),
  artifactSha256: SHA256,
  backend: z.enum(["llamacpp", "omlx", "kapitsa"]),
  model: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/),
  ggufFile: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.gguf$/)
    .optional(),
  contextTokens: z.number().int().min(512).max(131_072).default(4096),
  requiredHeadroomGiB: z.number().int().positive(),
  readinessTimeoutMs: z.number().int().positive().max(180_000).default(60_000),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
});

export type HardwareProcessProbePlan = z.input<typeof planSchema>;
type Plan = z.output<typeof planSchema>;

export interface HardwareProcessProbeOptions {
  execute?: boolean;
  lockDir?: string;
  readCapacity?: () => ManagedCapacitySample;
  signal?: AbortSignal;
}

type Admission = ReturnType<typeof projectManagedCapacity>;
type Status = "NOT_RUN" | "BLOCKED" | "FAIL" | "PASS";
type Sample = {
  state: "first-request" | "repeated-request";
  ttftMs: number;
  latencyMs: number;
  completionTokens: number | null;
  outputMatched: boolean;
};
type Release = { processExited: boolean; portReleased: boolean; forced: boolean; ms: number };

interface Evidence {
  schemaVersion: 1;
  probe: "isolated-process";
  status: Status;
  launched: boolean;
  reason?: string;
  admission?: Admission;
  binarySha256?: string;
  backend?: Plan["backend"];
  contextTokens?: number;
  artifactSha256?: string;
  capacity: ManagedCapacitySample[];
  readyInventoryMs?: number;
  requests: Sample[];
  release?: Release;
  afterRelease?: ManagedCapacitySample;
  swapIo?: {
    before: SwapCounterSample;
    after: SwapCounterSample;
    rate: ReturnType<typeof deriveSwapRate>;
  };
}

class ProbeError extends Error {}

function fail(reason: string): never {
  throw new ProbeError(reason);
}

function signaled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("Canceled");
}

function reason(error: unknown, fallback: string): string {
  return error instanceof ProbeError ? error.message : fallback;
}

function evidence(): Evidence {
  return {
    schemaVersion: 1,
    probe: "isolated-process",
    status: "NOT_RUN",
    launched: false,
    capacity: [],
    requests: [],
  };
}

function block(report: Evidence, value: string): Evidence {
  return { ...report, status: "BLOCKED", reason: value };
}

type Entries = { path: string; rel: string; digest: string; file: boolean }[];

function fingerprint(path: string): { digest: string; file: boolean; dir: boolean } {
  const stat = lstatSync(path, { bigint: true });
  return {
    digest: server.modelRunArtifactGenerationDigest(stat),
    file: stat.isFile(),
    dir: stat.isDirectory(),
  };
}

function entries(root: string): Entries {
  const files: Entries = [];
  function visit(path: string, rel: string): void {
    if (files.length >= 4096) fail("ArtifactInventoryTooLarge");
    const { digest, file, dir } = fingerprint(path);
    if (!file && !dir) fail("UnsupportedArtifactEntry");
    files.push({ path, rel, digest, file });
    if (dir) {
      for (const name of readdirSync(path).sort())
        visit(join(path, name), rel ? rel + "/" + name : name);
    }
  }
  visit(root, "");
  return files;
}

async function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes as Buffer);
  return hash.digest("hex");
}

async function assetSha256(inventory: Entries, signal: AbortSignal): Promise<string> {
  const [root] = inventory;
  if (root?.file) return await fileSha256(root.path, signal);
  const content: [string, string][] = [];
  for (const file of inventory) {
    if (file.file) content.push([file.rel, await fileSha256(file.path, signal)]);
  }
  if (content.length === 0) fail("EmptyArtifact");
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function unchanged(inventory: Entries): boolean {
  return inventory.every(({ path, digest }) => fingerprint(path).digest === digest);
}

const SHARDED_GGUF = /-\d{5}-of-\d{5}\.gguf$/;

function sourceModel(plan: Plan, artifact: Entries): string {
  if (plan.backend !== "llamacpp") {
    if (artifact[0]?.file || plan.ggufFile !== undefined) fail("InvalidArtifactLayout");
    if (plan.backend === "omlx") {
      const modelDirs = artifact.filter(
        ({ file, rel }) => !file && rel !== "" && !rel.includes("/"),
      );
      if (modelDirs.length !== 1 || modelDirs[0]?.rel !== plan.model) fail("InvalidArtifactLayout");
    }
    return plan.artifact;
  }
  if (artifact[0]?.file) {
    if (
      !plan.artifact.endsWith(".gguf") ||
      SHARDED_GGUF.test(plan.artifact) ||
      plan.ggufFile !== undefined
    ) {
      fail("InvalidArtifactLayout");
    }
    return plan.artifact;
  }
  const selected = artifact.find(
    (entry) => entry.file && entry.rel !== "" && entry.rel === plan.ggufFile,
  );
  if (selected === undefined) fail("InvalidArtifactLayout");
  return selected.path;
}

interface PinnedInputs {
  inventory: Entries;
  modelPath: string;
}

async function pinAssets(
  plan: Plan,
  report: Evidence,
  signal?: AbortSignal,
): Promise<PinnedInputs> {
  const deadline = AbortSignal.timeout(600_000);
  const boundedSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const binary = entries(plan.binary);
  if (binary.length !== 1 || !binary[0]?.file) fail("InvalidBinary");
  if ((await assetSha256(binary, boundedSignal)) !== plan.binarySha256) fail("BinaryMismatch");
  report.binarySha256 = plan.binarySha256;
  const artifact = entries(plan.artifact);
  const modelPath = sourceModel(plan, artifact);
  if ((await assetSha256(artifact, boundedSignal)) !== plan.artifactSha256)
    fail("ArtifactMismatch");
  report.artifactSha256 = plan.artifactSha256;
  const inventory = [...binary, ...artifact];
  if (!unchanged(inventory)) fail("PinnedInputChanged");
  return { inventory, modelPath };
}

function engineArgs(plan: Plan, modelPath: string, runDir: string, port: number): string[] {
  const listener = ["--host", HOST, "--port", String(port)];
  switch (plan.backend) {
    case "llamacpp":
      return [
        ...listener,
        "--model",
        modelPath,
        "--alias",
        plan.model,
        "--ctx-size",
        String(plan.contextTokens),
        "--parallel",
        "1",
        "--slot-save-path",
        runDir,
      ];
    case "omlx":
      return [
        "serve",
        ...listener,
        "--model-dir",
        modelPath,
        "--base-path",
        runDir,
        "--max-concurrent-requests",
        "1",
        "--memory-guard",
        "safe",
        "--headless",
      ];
    case "kapitsa":
      return [
        "serve",
        ...listener,
        "--model",
        modelPath,
        "--model-id",
        plan.model,
        "--local",
        "--private",
        "--mem-budget",
        String(plan.requiredHeadroomGiB),
        "--context",
        String(plan.contextTokens),
        "--slots",
        "1",
      ];
  }
}

function reservePort(port = 0): number {
  const listener = Bun.serve({
    hostname: HOST,
    port,
    fetch: () => new Response(null, { status: 404 }),
  });
  const bound = listener.port;
  void listener.stop(true);
  if (!bound) fail("PortUnverified");
  return bound;
}

function listenerStatus(lsof: string, pid: number, port: number): "ready" | "pending" {
  const result = spawnSync(lsof, ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8",
    timeout: 1200,
  });
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr.trim() !== "") {
    fail("ListenerInspectionFailed");
  }
  const sockets = result.stdout.split("\n").filter((line) => line.startsWith("n"));
  if (sockets.length === 0) return "pending";
  if (sockets.length !== 1 || sockets[0] !== "n" + HOST + ":" + String(port))
    fail("UnexpectedListener");
  return "ready";
}

interface ProcessRun {
  pid: number;
  exited: Promise<void>;
  hasExited: () => boolean;
}

function start(plan: Plan, modelPath: string, runDir: string, port: number): ProcessRun {
  const child = spawn(plan.binary, engineArgs(plan, modelPath, runDir, port), {
    detached: true,
    cwd: runDir,
    stdio: "ignore",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      XDG_CACHE_HOME: runDir,
      XDG_CONFIG_HOME: runDir,
      TMPDIR: runDir,
      HF_HUB_OFFLINE: "1",
      KAPITSA_NO_AUTO_UPDATE: "1",
      KAPITSA_HOME: runDir,
    },
  });
  let finished = false;
  const exited = new Promise<void>((resolve) => {
    const done = (): void => {
      finished = true;
      resolve();
    };
    child.once("error", done);
    child.once("exit", done);
  });
  if (child.pid === undefined) fail("SpawnFailed");
  return { pid: child.pid, exited, hasExited: () => finished };
}

async function bounded(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function processGroupSignal(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function groupExited(pid: number): Promise<boolean> {
  const deadline = performance.now() + 2000;
  while (processGroupSignal(pid, 0)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}

async function release(run: ProcessRun, port: number): Promise<Release> {
  const began = performance.now();
  if (!run.hasExited()) processGroupSignal(run.pid, "SIGTERM");
  const exitedGracefully = await bounded(run.exited, 3000);
  const forced = !exitedGracefully;
  if (!exitedGracefully && !run.hasExited()) processGroupSignal(run.pid, "SIGKILL");
  const processExited = (await bounded(run.exited, 2000)) && (await groupExited(run.pid));
  let portReleased = false;
  try {
    portReleased = reservePort(port) === port;
  } catch {
    // A port claimed by an unknown listener is not verified released.
  }
  return { processExited, portReleased, forced, ms: performance.now() - began };
}

const inventorySchema = z.object({ data: z.array(z.object({ id: z.string() })) });

type LocalRoute = "/v1/models" | "/v1/chat/completions";

function directRequest(
  port: number,
  path: LocalRoute,
  signal: AbortSignal,
  body?: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: HOST,
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        agent: false,
        signal,
        ...(body === undefined
          ? {}
          : {
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            }),
      },
      resolve,
    );
    req.once("error", reject);
    req.end(body);
  });
}

async function inventoryBody(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STREAM_BYTES) fail("InventoryTooLarge");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

async function checkModel(port: number, model: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await directRequest(port, "/v1/models", signal);
    if (response.statusCode !== 200) {
      response.destroy();
      return false;
    }
    const inventory = inventorySchema.safeParse(await inventoryBody(response));
    return inventory.success && inventory.data.data.some((entry) => entry.id === model);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    return false;
  }
}

async function ready(
  plan: Plan,
  run: ProcessRun,
  port: number,
  lsof: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + plan.readinessTimeoutMs;
  while (performance.now() < deadline) {
    signaled(signal);
    if (run.hasExited()) fail("EngineExited");
    if (
      listenerStatus(lsof, run.pid, port) === "ready" &&
      (await checkModel(port, plan.model, AbortSignal.any([signal, AbortSignal.timeout(1000)])))
    )
      return;
    await Bun.sleep(100);
  }
  fail("ReadinessTimeout");
}

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(1),
  usage: z.object({ completion_tokens: z.number().int().nonnegative() }).nullable().optional(),
});

interface Accumulator {
  firstContentMs?: number;
  completionTokens: number | null;
  content: string;
  finishSeen: boolean;
  modelSeen: boolean;
  done: boolean;
}

function applyEvent(event: string, response: Accumulator, model: string): boolean {
  const message = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (message === "") return false;
  if (message === "[DONE]") {
    response.done = true;
    return true;
  }
  const chunk = completionSchema.parse(JSON.parse(message) as unknown);
  if (chunk.model !== undefined) {
    if (chunk.model !== model) fail("WrongResponseModel");
    response.modelSeen = true;
  }
  const [choice] = chunk.choices;
  const content = choice?.delta?.content;
  if (content) {
    response.firstContentMs ??= performance.now();
    response.content += content;
  }
  if (choice?.finish_reason) response.finishSeen = true;
  response.completionTokens = chunk.usage?.completion_tokens ?? response.completionTokens;
  return false;
}

async function collect(stream: IncomingMessage, model: string): Promise<Accumulator> {
  const decoder = new TextDecoder();
  const response: Accumulator = {
    completionTokens: null,
    content: "",
    finishSeen: false,
    modelSeen: false,
    done: false,
  };
  let buffer = "";
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STREAM_BYTES) fail("ResponseTooLarge");
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    if (frames.some((event) => applyEvent(event, response, model))) break;
  }
  return response;
}

async function measure(
  plan: Plan,
  port: number,
  state: Sample["state"],
  signal: AbortSignal,
): Promise<Sample> {
  const began = performance.now();
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(plan.requestTimeoutMs)]);
  const body = JSON.stringify({
    model: plan.model,
    messages: [{ role: "user", content: BENCHMARK_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_COMPLETION_TOKENS,
    temperature: 0,
  });
  const response = await directRequest(port, "/v1/chat/completions", boundedSignal, body);
  if (
    response.statusCode !== 200 ||
    !response.headers["content-type"]?.includes("text/event-stream")
  ) {
    response.destroy();
    fail("CompletionUnavailable");
  }
  const output = await collect(response, plan.model);
  if (
    !output.done ||
    !output.finishSeen ||
    !output.modelSeen ||
    output.firstContentMs === undefined
  ) {
    fail("IncompleteCompletion");
  }
  if (output.completionTokens !== null && output.completionTokens > MAX_COMPLETION_TOKENS)
    fail("OutputBudgetExceeded");
  return {
    state,
    ttftMs: output.firstContentMs - began,
    latencyMs: performance.now() - began,
    completionTokens: output.completionTokens,
    outputMatched: output.content.trim() === "OK",
  };
}

function safeCapacity(
  readCapacity: () => ManagedCapacitySample | undefined,
): ManagedCapacitySample | undefined {
  try {
    return readCapacity();
  } catch {
    return undefined;
  }
}

function capacityCheck(
  readCapacity: () => ManagedCapacitySample | undefined,
  report: Evidence,
  minimumGiB = 0,
): string | undefined {
  const sample = safeCapacity(readCapacity);
  if (sample === undefined) return "CapacityUnknown";
  report.capacity.push(sample);
  const admission = projectManagedCapacity(sample, { nowMs: Date.now() });
  if (!report.launched) report.admission = admission;
  if (!admission.ok) return admission.reason;
  return admission.launchHeadroomGiB < minimumGiB ? "InsufficientHeadroom" : undefined;
}

async function probeServing(
  plan: Plan,
  run: ProcessRun,
  port: number,
  lsof: string,
  signal: AbortSignal,
  report: Evidence,
  launchStarted: number,
): Promise<void> {
  await ready(plan, run, port, lsof, signal);
  report.readyInventoryMs = performance.now() - launchStarted;
  for (const state of [
    "first-request",
    "repeated-request",
    "repeated-request",
    "repeated-request",
  ] as const) {
    signaled(signal);
    if (run.hasExited() || listenerStatus(lsof, run.pid, port) !== "ready") fail("ListenerLost");
    report.requests.push(await measure(plan, port, state, signal));
  }
  if (report.requests.some((sample) => !sample.outputMatched)) fail("OutputMismatch");
}

function beginCapacityMonitor(
  read: () => ManagedCapacitySample | undefined,
  report: Evidence,
  controller: AbortController,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const refused = capacityCheck(read, report);
    if (refused !== undefined) controller.abort(refused);
  }, 1000);
}

async function snapshotSwap(): Promise<SwapCounterSample | undefined> {
  return await probeNodeMem().then(
    (sample) => sample.swap_io,
    () => undefined,
  );
}

async function recordSwapIo(
  report: Evidence,
  before: SwapCounterSample | undefined,
): Promise<void> {
  const after = await snapshotSwap();
  if (before !== undefined && after !== undefined) {
    report.swapIo = {
      before,
      after,
      rate: deriveSwapRate(before, after, {
        nowMs: Date.now(),
        maxAgeMs: 10 * 60_000,
      }),
    };
  }
}

function safeToReleaseWorkspace(report: Evidence): boolean {
  return (
    !report.launched || (report.release?.processExited === true && report.release.portReleased)
  );
}

function lockProbe(path: string): string | undefined {
  try {
    mkdirSync(path, { mode: 0o700 });
    return undefined;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST"
      ? "ProbeInProgressOrUnsettled"
      : "ProbeLockUnavailable";
  }
}

function saveRecovery(
  path: string,
  runtime?: { runDir: string; port: number; processGroup?: number },
): void {
  const pending = join(path, "run.pending");
  writeFileSync(pending, JSON.stringify({ supervisorPid: process.pid, ...runtime }) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(pending, join(path, "run.json"));
}

function completeProbe(report: Evidence, failure: string | undefined): Evidence {
  const release = report.release;
  if (!release?.processExited || !release.portReleased || release.forced)
    failure ??= "ReleaseUnverified";
  return failure === undefined
    ? { ...report, status: "PASS" }
    : { ...report, status: "FAIL", reason: failure };
}

async function settleProbe(
  run: ProcessRun,
  port: number,
  report: Evidence,
  readCapacity: () => ManagedCapacitySample | undefined,
  swapBefore: SwapCounterSample | undefined,
): Promise<void> {
  report.release = await release(run, port);
  const sample = safeCapacity(readCapacity);
  if (sample !== undefined) report.afterRelease = sample;
  await recordSwapIo(report, swapBefore);
}

async function executeProbe(
  plan: Plan,
  report: Evidence,
  pinned: PinnedInputs,
  lsof: string,
  readCapacity: () => ManagedCapacitySample | undefined,
  lockDir: string,
  signal?: AbortSignal,
): Promise<Evidence> {
  const port = reservePort();
  const runDir = mkdtempSync(join(tmpdir(), "llamactl-hardware-"));
  const controller = new AbortController();
  const runSignal = AbortSignal.any([controller.signal, signal ?? new AbortController().signal]);
  const swapBefore = await snapshotSwap();
  let run: ProcessRun | undefined;
  let failure: string | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    signaled(runSignal);
    saveRecovery(lockDir, { runDir, port });
    const admissionRefusal = capacityCheck(readCapacity, report, plan.requiredHeadroomGiB);
    if (admissionRefusal !== undefined) return block(report, admissionRefusal);
    if (!unchanged(pinned.inventory)) return block(report, "PinnedInputChanged");
    monitor = beginCapacityMonitor(readCapacity, report, controller);
    const launchStarted = performance.now();
    run = start(plan, pinned.modelPath, runDir, port);
    report.launched = true;
    saveRecovery(lockDir, { runDir, port, processGroup: run.pid });
    await probeServing(plan, run, port, lsof, runSignal, report, launchStarted);
    failure = capacityCheck(readCapacity, report);
    if (run.hasExited()) failure ??= "EngineExited";
    if (!unchanged(pinned.inventory)) failure ??= "PinnedInputChanged";
  } catch (error) {
    const blocked: unknown = controller.signal.reason;
    failure =
      typeof blocked === "string"
        ? blocked
        : reason(error, runSignal.aborted ? "Canceled" : "ProbeFailed");
  } finally {
    clearInterval(monitor);
    try {
      if (run !== undefined) await settleProbe(run, port, report, readCapacity, swapBefore);
    } finally {
      if (safeToReleaseWorkspace(report)) rmSync(runDir, { force: true, recursive: true });
    }
  }
  return completeProbe(report, failure);
}

export async function runHardwareProcessProbe(
  input: unknown,
  opts: HardwareProcessProbeOptions = {},
): Promise<Evidence> {
  const report = evidence();
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return block(report, "InvalidPlan");
  const plan = parsed.data;
  report.backend = plan.backend;
  if (plan.backend !== "omlx") report.contextTokens = plan.contextTokens;
  const readCapacity = opts.readCapacity ?? readLocalManagedCapacity;
  const refused = capacityCheck(readCapacity, report, plan.requiredHeadroomGiB);
  if (refused !== undefined) return block(report, refused);
  if (opts.execute !== true) return report;
  const lsof = Bun.which("lsof", { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
  if (lsof === null) return block(report, "ListenerInspectionUnavailable");
  const lockDir = opts.lockDir ?? PROBE_LOCK;
  const lockRefusal = lockProbe(lockDir);
  if (lockRefusal !== undefined) return block(report, lockRefusal);
  try {
    saveRecovery(lockDir);
    signaled(opts.signal);
    const pinned = await pinAssets(plan, report, opts.signal);
    return await executeProbe(plan, report, pinned, lsof, readCapacity, lockDir, opts.signal);
  } catch (error) {
    const detail = reason(error, opts.signal?.aborted ? "Canceled" : "InputOrCleanupUnverified");
    return report.launched ? { ...report, status: "FAIL", reason: detail } : block(report, detail);
  } finally {
    if (safeToReleaseWorkspace(report)) rmSync(lockDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const [, , mode, planPath] = process.argv;
  if ((mode !== "--preflight" && mode !== "--execute") || !planPath || process.argv.length !== 4) {
    console.error("Usage: bun hardware-process-probe.ts --preflight|--execute <private-plan.json>");
    process.exitCode = 2;
  } else {
    const cancel = new AbortController();
    const abort = (): void => {
      cancel.abort();
    };
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      const content: unknown = await Bun.file(planPath).json();
      const report = await runHardwareProcessProbe(content, {
        execute: mode === "--execute",
        signal: cancel.signal,
      });
      process.stdout.write(JSON.stringify(report) + "\n");
      process.exitCode = report.status === "FAIL" ? 1 : report.status === "BLOCKED" ? 2 : 0;
    } catch {
      process.stdout.write(JSON.stringify(block(evidence(), "PlanUnreadable")) + "\n");
      process.exitCode = 2;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}
