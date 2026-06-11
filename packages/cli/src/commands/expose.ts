import {
  config as kubecfg,
  workloadApply,
  type workloadSchema,
  workloadStore,
} from "@llamactl/remote";

import { getNodeClientByName, resolveEffectiveNodeName } from "../dispatcher.js";
import { required } from "../required.js";

const USAGE = `Usage: llamactl expose <target> [--node <name>]
                      [--name <workload>] [--extra-args="..."]
                      [--timeout=<s>] [--json]

Deploy a model on a node as a declarative workload and print the URL
an OpenAI-compatible client (ember synth, etc.) should use.

Equivalent to:
  1. write a minimal ModelRun manifest targeting <node>
  2. llamactl apply -f <manifest>
  3. print the advertisedEndpoint the node reports after startup

\`<target>\` is either a rel path (e.g. org/model-Q4_K_M.gguf) or a
preset alias (fast | balanced | best | vision | …) the target node
can resolve. When --node is omitted, uses the current-context's
defaultNode.

Flags:
  --node <n>         node to deploy on
  --name <w>         workload manifest name; defaults to a slug of target
  --extra-args="..." forwarded to llama-server verbatim
  --timeout=<s>      startServer timeout (default 60)
  --json             machine-readable output
`;

interface ExposeFlags {
  target: string;
  node: string;
  workloadName: string;
  extraArgs: string[];
  timeoutSeconds: number;
  json: boolean;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 63) || "expose"
  );
}

interface ExposeParseState {
  target: string;
  nodeFlag: string | null;
  workloadName: string | null;
  extraArgs: string[];
  timeoutSeconds: number;
  json: boolean;
}

type ExposeArgStep = { next: number } | { error: string };

function splitExtraArgs(raw: string): string[] {
  return raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
}

/** Space-separated value flags (--node <n>, --name <w>, --extra-args "..."). */
function applyValueExposeFlag(
  arg: string,
  args: string[],
  i: number,
  state: ExposeParseState,
): ExposeArgStep | null {
  if (arg === "--node" || arg === "-n") {
    state.nodeFlag = args[i + 1] ?? "";
    if (!state.nodeFlag) return { error: "expose: --node requires a value" };
    return { next: i + 2 };
  }
  if (arg === "--name") {
    state.workloadName = args[i + 1] ?? "";
    if (!state.workloadName) return { error: "expose: --name requires a value" };
    return { next: i + 2 };
  }
  if (arg === "--extra-args") {
    state.extraArgs = splitExtraArgs(args[i + 1] ?? "");
    return { next: i + 2 };
  }
  return null;
}

/** Inline `--key=value` flags. True → handled; false → not an inline flag. */
function applyInlineExposeFlag(arg: string, state: ExposeParseState): boolean | { error: string } {
  if (arg.startsWith("--node=")) {
    state.nodeFlag = arg.slice("--node=".length);
    return true;
  }
  if (arg.startsWith("--name=")) {
    state.workloadName = arg.slice("--name=".length);
    return true;
  }
  if (arg.startsWith("--extra-args=")) {
    state.extraArgs = splitExtraArgs(arg.slice("--extra-args=".length));
    return true;
  }
  if (arg.startsWith("--timeout=")) {
    const n = Number.parseInt(arg.slice("--timeout=".length), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `expose: invalid --timeout: ${arg}` };
    }
    state.timeoutSeconds = n;
    return true;
  }
  return false;
}

function applyExposePositional(arg: string, i: number, state: ExposeParseState): ExposeArgStep {
  if (arg.startsWith("-")) {
    return { error: `expose: unknown flag ${arg}` };
  }
  if (!state.target) {
    state.target = arg;
    return { next: i + 1 };
  }
  return { error: `expose: unexpected positional ${arg}` };
}

function applyExposeArg(args: string[], i: number, state: ExposeParseState): ExposeArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    state.json = true;
    return { next: i + 1 };
  }
  if (arg === "-h" || arg === "--help") return { error: "help" };
  const valueFlag = applyValueExposeFlag(arg, args, i, state);
  if (valueFlag !== null) return valueFlag;
  const inline = applyInlineExposeFlag(arg, state);
  if (typeof inline === "object") return inline;
  if (inline) return { next: i + 1 };
  return applyExposePositional(arg, i, state);
}

function parseFlags(args: string[]): ExposeFlags | { error: string } {
  const state: ExposeParseState = {
    target: "",
    nodeFlag: null,
    workloadName: null,
    extraArgs: [],
    timeoutSeconds: 60,
    json: false,
  };

  let i = 0;
  while (i < args.length) {
    const step = applyExposeArg(args, i, state);
    if ("error" in step) return step;
    i = step.next;
  }

  if (!state.target) return { error: "expose: missing <target>" };
  const node = state.nodeFlag ?? resolveEffectiveNodeName();
  const name = state.workloadName ?? slug(state.target);
  return {
    target: state.target,
    node,
    workloadName: name,
    extraArgs: state.extraArgs,
    timeoutSeconds: state.timeoutSeconds,
    json: state.json,
  };
}

export async function runExpose(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if ("error" in parsed) {
    const stream = parsed.error === "help" ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === "help" ? 0 : 1;
  }

  const { target, node, workloadName, extraArgs, timeoutSeconds, json } = parsed;

  // A rel looks like "<repo-dir>/<file>.gguf"; anything else is treated
  // as a preset alias that the target node resolves locally.
  const targetKind: "rel" | "alias" =
    target.endsWith(".gguf") || target.includes("/") ? "rel" : "alias";

  const manifest: workloadSchema.ModelRun = {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: workloadName, labels: {}, annotations: {} },
    spec: {
      node,
      enabled: true,
      target: { kind: targetKind, value: target },
      extraArgs,
      workers: [],
      restartPolicy: "Always",
      timeoutSeconds,
      gateway: false,
      allowExternalBind: false,
    },
  };

  const result = await applyExposeManifest(manifest);
  if (result === null) return 1;
  if (result.error) {
    process.stderr.write(`expose: ${result.error}\n`);
    return 1;
  }

  const persisted: workloadSchema.ModelRun = { ...manifest, status: result.statusSection };
  const savedPath = workloadStore.saveWorkload(persisted);

  // Pull the advertisedEndpoint off the live node for the printed URL.
  // applyOne populated statusSection.endpoint from the startServer
  // result, but that's the bind URL; we specifically want the
  // advertised one for ember synth.
  const advertised = await fetchAdvertisedEndpoint(
    node,
    workloadName,
    result.statusSection.endpoint ?? null,
  );
  const openaiUrl = advertised ? `${advertised}/v1` : null;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          workload: workloadName,
          node,
          action: result.action,
          manifest: savedPath,
          advertisedEndpoint: advertised,
          openaiBaseUrl: openaiUrl,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  printExposeSummary({ result, workloadName, node, savedPath, advertised, openaiUrl });
  return 0;
}

async function applyExposeManifest(
  manifest: workloadSchema.ModelRun,
): Promise<workloadApply.ApplyResult | null> {
  try {
    const cfg = kubecfg.loadConfig();
    return await workloadApply.applyOne(
      manifest,
      (n) => getNodeClientByName(n),
      undefined,
      undefined,
      {
        resolveNodeIdentity: (n) => {
          try {
            return kubecfg.resolveNode(cfg, n).node.endpoint || null;
          } catch {
            return null;
          }
        },
      },
    );
  } catch (err) {
    process.stderr.write(`expose: apply failed: ${(err as Error).message}\n`);
    return null;
  }
}

async function fetchAdvertisedEndpoint(
  node: string,
  workloadName: string,
  fallback: string | null,
): Promise<string | null> {
  try {
    // A version-skewed agent can omit the field over the wire despite the
    // non-optional static type; never clear the endpoint we already have.
    const status: { advertisedEndpoint?: string | null } = await getNodeClientByName(
      node,
    ).serverStatus.query({ workload: workloadName });
    return status.advertisedEndpoint ?? fallback;
  } catch {
    // Not fatal — fall back to whatever applyOne recorded.
    return fallback;
  }
}

function printExposeSummary(opts: {
  result: workloadApply.ApplyResult;
  workloadName: string;
  node: string;
  savedPath: string;
  advertised: string | null;
  openaiUrl: string | null;
}): void {
  const { result, workloadName, node, savedPath, advertised, openaiUrl } = opts;
  process.stdout.write(`${result.action} modelrun/${workloadName} on node ${node}\n`);
  process.stdout.write(`  manifest:  ${savedPath}\n`);
  if (result.statusSection.serverPid) {
    process.stdout.write(`  pid:       ${String(result.statusSection.serverPid)}\n`);
  }
  if (advertised) process.stdout.write(`  endpoint:  ${advertised}\n`);
  if (openaiUrl) {
    process.stdout.write(`  openai:    ${openaiUrl}\n`);
    process.stdout.write("\n");
    process.stdout.write(
      `Point OpenAI-compatible clients (ember synth, etc.) at:\n  ${openaiUrl}\n`,
    );
  }
}
