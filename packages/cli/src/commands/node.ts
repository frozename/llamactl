import { omitUndefined } from "@llamactl/core/object";
import {
  agentConfig as agentConfigMod,
  configSchema,
  createNodeClient,
  createRemoteNodeClient,
  config as kubecfg,
  providerForNode,
  resolveNodeKind,
} from "@llamactl/remote";
import { dirname } from "node:path";

import { getNodeClient } from "../dispatcher.js";
import { required } from "../required.js";
import { mkdirSync, readFileSync, writeFileSync } from "../safe-fs.js";

const USAGE = `Usage: llamactl node <subcommand>

Subcommands:
  ls [--json]
      List nodes in the current context.
  add <name> --bootstrap <blob> [--force]
      Decode a bootstrap blob from 'llamactl agent init' and persist it.
  add <name> --server <url> --fingerprint <sha256:...>
      [--token <tok>|--token-file <p>] [--force]
      Register a node explicitly.
  add-rag <name> --provider <chroma|pgvector> --endpoint <e>
      [--collection <c>] [--embedder-node <n> --embedder-model <m>]
      [--password-env <VAR> | --password-ref <secret-ref>]
      [--extra-arg <a>]...
      Register a RAG-kind node. --password-ref accepts any unified-
      resolver ref: env:VAR / keychain:service/account / file:/path.
  add-cloud <name> --provider <sirius|embersynth|openai-compatible|openai|anthropic>
      --base-url <url> [--api-key-ref <ref>] [--display-name <friendly>]
      [--force]
      Register a gateway/cloud-kind node (sirius-gateway, embersynth,
      raw OpenAI-compat, or a managed provider). --api-key-ref accepts
      any unified-resolver ref: env:VAR / keychain:service/account /
      file:/path (resolved at call time, never at register time).
      --force skips the /v1/models reachability probe.
  rm <name>
      Remove a node (refuses to remove 'local').
  test <name>
      Call nodeFacts() against the node and print the result.

By default, 'add' verifies the node is reachable with the supplied
credentials before persisting. Pass --force to skip the check
(useful when registering a node that isn't online yet).

Kubeconfig path: $LLAMACTL_CONFIG, or $DEV_STORAGE/config, or ~/.llamactl/config.
`;

export async function runNode(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "ls":
      return runLs(rest);
    case "add":
      return await runAdd(rest);
    case "add-rag":
      return runAddRag(rest);
    case "add-cloud":
      return await runAddCloud(rest);
    case "rm":
      return runRm(rest);
    case "test":
      return await runTest(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown node subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function runLs(args: string[]): number {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else {
      process.stderr.write(`node ls: unknown argument ${arg}\n`);
      return 1;
    }
  }
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const nodes = cluster?.nodes ?? [];
  if (json) {
    process.stdout.write(`${JSON.stringify({ context: ctx.name, nodes }, null, 2)}\n`);
    return 0;
  }
  if (nodes.length === 0) {
    process.stdout.write(`(no nodes in context ${ctx.name})\n`);
    return 0;
  }
  const width = Math.max(...nodes.map((n) => n.name.length));
  for (const n of nodes) {
    const suffix = n.name === ctx.defaultNode ? " (default)" : "";
    process.stdout.write(`${n.name.padEnd(width)}  ${n.endpoint}${suffix}\n`);
  }
  return 0;
}

interface AddFlags {
  name: string;
  bootstrap?: string;
  server?: string;
  fingerprint?: string;
  token?: string;
  tokenFile?: string;
  certificate?: string; // inline PEM (currently unused; written if bootstrap + fetch succeeds)
  force: boolean;
}

function assignAddFlag(flags: AddFlags, key: string, value: string | undefined): boolean {
  switch (key) {
    case "--bootstrap":
      if (value !== undefined) flags.bootstrap = value;
      return true;
    case "--server":
      if (value !== undefined) flags.server = value;
      return true;
    case "--fingerprint":
      if (value !== undefined) flags.fingerprint = value;
      return true;
    case "--token":
      if (value !== undefined) flags.token = value;
      return true;
    case "--token-file":
      if (value !== undefined) flags.tokenFile = value;
      return true;
    default:
      return false;
  }
}

function parseAdd(args: string[]): AddFlags | { error: string } {
  if (args.length === 0) return { error: "node add: missing <name>" };
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) return { error: "node add: missing <name>" };
  const flags: AddFlags = { name, force: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = required(rest[i]);
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (assignAddFlag(flags, arg, rest[i + 1])) {
      i++;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v !== undefined && assignAddFlag(flags, k, v)) continue;
    return { error: `node add: unknown argument ${arg}` };
  }
  return flags;
}

interface AddCredentials {
  url: string;
  fingerprint: string;
  token: string;
  certificate: string | undefined;
}

function resolveAddToken(f: AddFlags): string | undefined {
  if (f.token) return f.token;
  if (f.tokenFile) return readFileSync(f.tokenFile, "utf8").trim();
  return undefined;
}

function resolveAddCredentials(f: AddFlags): AddCredentials | { error: string } {
  if (f.bootstrap) {
    const decoded = agentConfigMod.decodeBootstrap(f.bootstrap);
    return {
      url: decoded.url,
      fingerprint: decoded.fingerprint,
      token: decoded.token,
      certificate: decoded.certificate,
    };
  }
  if (!f.server || !f.fingerprint) {
    return {
      error: "node add: --bootstrap or (--server + --fingerprint + --token|--token-file) required",
    };
  }
  const token = resolveAddToken(f);
  if (token === undefined) {
    return { error: "node add: --token or --token-file required when not using --bootstrap" };
  }
  return { url: f.server, fingerprint: f.fingerprint, token, certificate: undefined };
}

// Probe the node for reachability + credential validity before we
// commit anything to the kubeconfig. nodeFacts is the cheapest query
// on the router that exercises auth + TLS end-to-end.
type ProbeFacts = {
  nodeName: string;
  profile: string;
  platform: string;
  advertisedEndpoint?: string;
};

async function probeAddTarget(creds: AddCredentials): Promise<ProbeFacts | null> {
  const { url, token, certificate, fingerprint } = creds;
  try {
    const probeClient = createRemoteNodeClient({
      url,
      token,
      ...(certificate ? { certificate } : {}),
      certificateFingerprint: fingerprint,
    });
    return await probeClient.nodeFacts.query();
  } catch (err) {
    process.stderr.write(
      [
        `node add: reachability check failed for ${url}`,
        `  error: ${(err as Error).message}`,
        `  hint:  verify the agent is running and \`llamactl agent serve\``,
        `         started successfully on that host; or pass --force to`,
        `         persist without the check.`,
        "",
      ].join("\n"),
    );
    return null;
  }
}

// Persist the token at the user's tokenRef path if present; otherwise
// inline it on the user entry.
function persistUserToken(
  cfg: configSchema.Config,
  userName: string,
  token: string,
): configSchema.Config {
  return {
    ...cfg,
    users: cfg.users.map((u) => {
      if (u.name !== userName) return u;
      const updated: configSchema.User = { ...u };
      if (u.tokenRef) {
        // Write token to referenced file. Not caching the write here —
        // user-managed path semantics.
        const tokenRef = u.tokenRef.replace(/^~(?=$|\/)/, process.env["HOME"] ?? "");
        try {
          mkdirSync(dirname(tokenRef), { recursive: true });
          writeFileSync(tokenRef, token, { mode: 0o600 });
        } catch {
          // fall through: inline the token as a fallback.
          updated.token = token;
        }
      } else {
        updated.token = token;
      }
      return updated;
    }),
  };
}

function renderAddResult(
  name: string,
  url: string,
  ctxName: string,
  probeFacts: ProbeFacts | null,
): void {
  if (!probeFacts) {
    // --force path — unverified persistence
    process.stdout.write(`added node '${name}' (${url}) to context '${ctxName}' [unverified]\n`);
    return;
  }
  const advertised =
    probeFacts.advertisedEndpoint && probeFacts.advertisedEndpoint.length > 0
      ? probeFacts.advertisedEndpoint
      : "(not set)";
  process.stdout.write(
    [
      `added node '${name}' (${url}) to context '${ctxName}'`,
      `  profile:    ${probeFacts.profile}`,
      `  platform:   ${probeFacts.platform}`,
      `  advertised: ${advertised}`,
      "",
    ].join("\n"),
  );
}

async function runAdd(args: string[]): Promise<number> {
  const parsed = parseAdd(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  const creds = resolveAddCredentials(f);
  if ("error" in creds) {
    process.stderr.write(`${creds.error}\n`);
    return 1;
  }
  const { url, fingerprint, certificate, token } = creds;

  let probeFacts: ProbeFacts | null = null;
  if (!f.force) {
    probeFacts = await probeAddTarget(creds);
    if (!probeFacts) return 1;
  }

  const cfgPath = kubecfg.defaultConfigPath();
  let cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  cfg = persistUserToken(cfg, ctx.user, token);

  const nodeEntry: configSchema.ClusterNode = {
    name: f.name,
    endpoint: url,
    certificateFingerprint: fingerprint,
  };
  if (certificate) nodeEntry.certificate = certificate;
  cfg = kubecfg.upsertNode(cfg, ctx.cluster, nodeEntry);

  kubecfg.saveConfig(cfg, cfgPath);
  renderAddResult(f.name, url, ctx.name, probeFacts);
  return 0;
}

function runRm(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) {
    process.stderr.write("node rm: missing <name>\n");
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`node rm: unexpected argument ${String(rest[0])}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  let cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  try {
    cfg = kubecfg.removeNode(cfg, ctx.cluster, name);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  kubecfg.saveConfig(cfg, cfgPath);
  process.stdout.write(`removed node '${name}' from context '${ctx.name}'\n`);
  return 0;
}

async function runTest(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) {
    process.stderr.write("node test: missing <name>\n");
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`node test: unexpected argument ${String(rest[0])}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);

  // Cloud / gateway / provider-kind nodes have no `endpoint`, so the
  // tRPC HTTP link below builds an invalid URL and Bun's fetch fails
  // with "URL is invalid". Probe these via the OpenAI-compat provider
  // factory — same path used by `add-cloud`'s reachability check.
  let resolved: {
    node: configSchema.ClusterNode;
    user: configSchema.Config["users"][number];
  } | null = null;
  try {
    const r = kubecfg.resolveNode(cfg, name);
    resolved = { node: r.node, user: r.user };
  } catch (err) {
    process.stderr.write(`node test failed: ${(err as Error).message}\n`);
    return 1;
  }
  const kind = resolveNodeKind(resolved.node);
  if (kind === "gateway" || kind === "cloud" || kind === "provider") {
    try {
      const provider = providerForNode({ node: resolved.node, user: resolved.user, cfg });
      const health = (await provider.healthCheck?.()) ?? { state: "unknown" };
      let modelsCount = 0;
      let sampleModels: string[] = [];
      try {
        const models = (await provider.listModels?.()) ?? [];
        modelsCount = models.length;
        sampleModels = models.slice(0, 3).map((m) => (m as { id: string }).id);
      } catch {
        // Some providers don't expose listModels (or rate-limit it).
        // Health alone is enough to call the test successful.
      }
      const facts = {
        kind,
        provider: resolved.node.cloud?.provider ?? null,
        baseUrl: resolved.node.cloud?.baseUrl ?? null,
        health,
        modelsCount,
        sampleModels,
      };
      process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`node test failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  // Agent-kind nodes: existing tRPC nodeFacts path.
  const client = createNodeClient(cfg, { nodeName: name });
  try {
    const facts = await client.nodeFacts.query();
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`node test failed: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * `llamactl node add-rag` — registers a RAG-kind node in the current
 * context. Covers the common operator paths: pgvector with env or
 * keychain-sourced password + optional delegated embedder, chroma-mcp
 * with an optional collection override.
 *
 * Wraps `kubecfg.upsertNode` so it rides the same validation path as
 * hand-editing the kubeconfig — the `.refine()` validator on
 * `ClusterNodeSchema` catches bad provider/missing-rag combinations.
 */
interface AddRagFlags {
  name: string;
  provider: "chroma" | "pgvector";
  endpoint: string;
  collection?: string;
  embedderNode?: string;
  embedderModel?: string;
  passwordEnv?: string;
  passwordRef?: string;
  extraArgs: string[];
}

interface AddRagDraft {
  name?: string;
  provider?: "chroma" | "pgvector";
  endpoint?: string;
  collection?: string;
  embedderNode?: string;
  embedderModel?: string;
  passwordEnv?: string;
  passwordRef?: string;
  extraArgs: string[];
}

function takeFlagValue(
  args: string[],
  i: number,
  inline: string | undefined,
): { value: string | undefined; next: number } {
  // Truthiness on purpose: an empty-string value is deliberately treated as unset.
  if (inline !== undefined) return { value: inline, next: i + 1 };
  const next = args[i + 1];
  if (next && !next.startsWith("-")) return { value: next, next: i + 2 };
  return { value: undefined, next: i + 1 };
}

function assignIfDefined<K extends keyof AddRagDraft>(
  draft: AddRagDraft,
  key: K,
  value: AddRagDraft[K] | undefined,
): void {
  if (value !== undefined) draft[key] = value;
}

function assignAddRagValue(
  draft: AddRagDraft,
  flag: string,
  value: string | undefined,
): { ok: true } | { error: string } {
  switch (flag) {
    case "--provider": {
      if (value !== "chroma" && value !== "pgvector") {
        return {
          error: `node add-rag: --provider must be 'chroma' or 'pgvector' (got ${value ?? "<empty>"})`,
        };
      }
      draft.provider = value;
      return { ok: true };
    }
    case "--endpoint":
      assignIfDefined(draft, "endpoint", value);
      return { ok: true };
    case "--collection":
      assignIfDefined(draft, "collection", value);
      return { ok: true };
    case "--embedder-node":
      assignIfDefined(draft, "embedderNode", value);
      return { ok: true };
    case "--embedder-model":
      assignIfDefined(draft, "embedderModel", value);
      return { ok: true };
    case "--password-env":
      assignIfDefined(draft, "passwordEnv", value);
      return { ok: true };
    case "--password-ref":
      assignIfDefined(draft, "passwordRef", value);
      return { ok: true };
    default:
      return { error: `node add-rag: unknown flag ${flag}` };
  }
}

// Extra args frequently begin with `--` (e.g. `--persist-directory`),
// so we accept the next argv slot unconditionally rather than stopping
// at a dash.
function consumeExtraArg(
  draft: AddRagDraft,
  args: string[],
  i: number,
  inline: string | undefined,
): { next: number } {
  if (inline !== undefined) {
    draft.extraArgs.push(inline);
    return { next: i + 1 };
  }
  if (i + 1 < args.length) {
    draft.extraArgs.push(required(args[i + 1]));
    return { next: i + 2 };
  }
  return { next: i + 1 };
}

function consumeAddRagArg(
  draft: AddRagDraft,
  args: string[],
  i: number,
): { next: number } | { error: string } | { help: true } {
  const arg = required(args[i]);
  const [flag, inline] = splitFlag(arg);
  if (!flag.startsWith("-")) {
    if (draft.name !== undefined) {
      return { error: `node add-rag: unexpected positional ${flag}` };
    }
    draft.name = flag;
    return { next: i + 1 };
  }
  if (flag === "-h" || flag === "--help") return { help: true };
  if (flag === "--extra-arg") return consumeExtraArg(draft, args, i, inline);
  const { value, next } = takeFlagValue(args, i, inline);
  const assigned = assignAddRagValue(draft, flag, value);
  if ("error" in assigned) return assigned;
  return { next };
}

function validateAddRagDraft(draft: AddRagDraft): AddRagFlags | { error: string } {
  if (!draft.name) {
    return { error: "node add-rag: missing <name>" };
  }
  if (!draft.provider) {
    return { error: "node add-rag: --provider is required" };
  }
  if (!draft.endpoint) {
    return { error: "node add-rag: --endpoint is required" };
  }
  if ((draft.embedderNode === undefined) !== (draft.embedderModel === undefined)) {
    return {
      error: "node add-rag: --embedder-node and --embedder-model must be set together",
    };
  }
  if (draft.passwordEnv && draft.passwordRef) {
    return { error: "node add-rag: pass only one of --password-env / --password-ref" };
  }
  return {
    name: draft.name,
    provider: draft.provider,
    endpoint: draft.endpoint,
    ...omitUndefined({ collection: draft.collection }),
    ...omitUndefined({ embedderNode: draft.embedderNode }),
    ...omitUndefined({ embedderModel: draft.embedderModel }),
    ...omitUndefined({ passwordEnv: draft.passwordEnv }),
    ...omitUndefined({ passwordRef: draft.passwordRef }),
    extraArgs: draft.extraArgs,
  };
}

function parseAddRagFlags(args: string[]): AddRagFlags | { error: string } | { help: true } {
  const draft: AddRagDraft = { extraArgs: [] };
  let i = 0;
  while (i < args.length) {
    const step = consumeAddRagArg(draft, args, i);
    if ("error" in step) return step;
    if ("help" in step) return step;
    i = step.next;
  }
  return validateAddRagDraft(draft);
}

function runAddRag(args: string[]): number {
  const parsed = parseAddRagFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }

  const binding: Record<string, unknown> = {
    provider: parsed.provider,
    endpoint: parsed.endpoint,
    extraArgs: parsed.extraArgs,
  };
  if (parsed.collection) binding["collection"] = parsed.collection;
  if (parsed.embedderNode && parsed.embedderModel) {
    binding["embedder"] = { node: parsed.embedderNode, model: parsed.embedderModel };
  }
  if (parsed.passwordEnv) {
    binding["auth"] = { tokenEnv: parsed.passwordEnv };
  } else if (parsed.passwordRef) {
    binding["auth"] = { tokenRef: parsed.passwordRef };
  }

  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  let next;
  try {
    next = kubecfg.upsertNode(cfg, ctx.cluster, {
      name: parsed.name,
      endpoint: "",
      kind: "rag",
      rag: configSchema.RagBindingSchema.parse(binding),
    });
  } catch (err) {
    process.stderr.write(`node add-rag: invalid binding: ${(err as Error).message}\n`);
    return 1;
  }
  kubecfg.saveConfig(next, cfgPath);
  process.stdout.write(
    `added rag node '${parsed.name}' (${parsed.provider}) to context '${ctx.name}'\n`,
  );
  return 0;
}

/**
 * `llamactl node add-cloud` — registers a gateway/cloud-kind node
 * (sirius-gateway, embersynth, raw OpenAI-compatible, or a managed
 * provider such as openai/anthropic). Shape-translates CLI flags
 * into `nodeAddCloud`'s tRPC input; resolution of `apiKeyRef`
 * happens at call time, never at register time. Operators who
 * containerize sirius/embersynth hit this after `docker run` /
 * `composite apply` to register the running gateway under a name
 * the composite's `gateways:` block can reference.
 */
const CLOUD_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "together",
  "groq",
  "mistral",
  "openai-compatible",
  "sirius",
  "embersynth",
] as const;
type CloudProviderFlag = (typeof CLOUD_PROVIDERS)[number];

interface AddCloudFlags {
  name: string;
  provider: CloudProviderFlag;
  baseUrl: string;
  apiKeyRef: string | undefined;
  displayName: string | undefined;
  force: boolean;
}

interface AddCloudDraft {
  name?: string;
  provider?: CloudProviderFlag;
  baseUrl?: string;
  apiKeyRef?: string;
  displayName?: string;
  force: boolean;
}

function assignAddCloudValue(
  draft: AddCloudDraft,
  flag: string,
  value: string | undefined,
): { ok: true } | { error: string } {
  switch (flag) {
    case "--provider": {
      const provider = CLOUD_PROVIDERS.find((p) => p === value);
      if (!provider) {
        return {
          error: `node add-cloud: --provider must be one of ${CLOUD_PROVIDERS.join("|")} (got ${value ?? "<empty>"})`,
        };
      }
      draft.provider = provider;
      return { ok: true };
    }
    case "--base-url":
      if (value !== undefined) draft.baseUrl = value;
      return { ok: true };
    case "--api-key-ref":
      if (value !== undefined) draft.apiKeyRef = value;
      return { ok: true };
    case "--display-name":
      if (value !== undefined) draft.displayName = value;
      return { ok: true };
    default:
      return { error: `node add-cloud: unknown flag ${flag}` };
  }
}

function consumeAddCloudArg(
  draft: AddCloudDraft,
  args: string[],
  i: number,
): { next: number } | { error: string } | { help: true } {
  const arg = required(args[i]);
  const [flag, inline] = splitFlag(arg);
  if (!flag.startsWith("-")) {
    if (draft.name !== undefined) {
      return { error: `node add-cloud: unexpected positional ${flag}` };
    }
    draft.name = flag;
    return { next: i + 1 };
  }
  if (flag === "-h" || flag === "--help") return { help: true };
  if (flag === "--force") {
    draft.force = true;
    return { next: i + 1 };
  }
  const { value, next } = takeFlagValue(args, i, inline);
  const assigned = assignAddCloudValue(draft, flag, value);
  if ("error" in assigned) return assigned;
  return { next };
}

function validateAddCloudDraft(draft: AddCloudDraft): AddCloudFlags | { error: string } {
  if (!draft.name) {
    return { error: "node add-cloud: missing <name>" };
  }
  if (!draft.provider) {
    return { error: "node add-cloud: --provider is required" };
  }
  if (!draft.baseUrl) {
    return { error: "node add-cloud: --base-url is required" };
  }
  return {
    name: draft.name,
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    apiKeyRef: draft.apiKeyRef,
    displayName: draft.displayName,
    force: draft.force,
  };
}

function parseAddCloudFlags(args: string[]): AddCloudFlags | { error: string } | { help: true } {
  const draft: AddCloudDraft = { force: false };
  let i = 0;
  while (i < args.length) {
    const step = consumeAddCloudArg(draft, args, i);
    if ("error" in step) return step;
    if ("help" in step) return step;
    i = step.next;
  }
  return validateAddCloudDraft(draft);
}

function buildAddCloudInput(f: AddCloudFlags): {
  name: string;
  provider: CloudProviderFlag;
  baseUrl: string;
  apiKeyRef?: string;
  displayName?: string;
  skipProbe?: boolean;
} {
  const input: {
    name: string;
    provider: CloudProviderFlag;
    baseUrl: string;
    apiKeyRef?: string;
    displayName?: string;
    skipProbe?: boolean;
  } = { name: f.name, provider: f.provider, baseUrl: f.baseUrl };
  if (f.apiKeyRef) input.apiKeyRef = f.apiKeyRef;
  if (f.displayName) input.displayName = f.displayName;
  if (f.force) input.skipProbe = true;
  return input;
}

function renderAddCloudSuccess(f: AddCloudFlags, result: { name: string; baseUrl: string }): void {
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  const lines = [
    `added cloud node '${result.name}' (${f.provider} @ ${result.baseUrl})`,
    `  context:     ${ctx.name}`,
  ];
  if (f.apiKeyRef) {
    lines.push(`  apiKey:      ${f.apiKeyRef} (not resolved at register time)`);
  } else {
    lines.push("  apiKey:      (anonymous — no Authorization header sent)");
  }
  if (f.displayName) lines.push(`  displayName: ${f.displayName}`);
  if (f.force) lines.push("  [unverified — probe skipped via --force]");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function reportAddCloudError(err: unknown, force: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  // The router wraps probe failures as `cloud node probe failed: …`.
  // Mirror add-rag's error UX: surface the message, suggest --force
  // when we're confident the failure is reachability-flavoured.
  process.stderr.write(`node add-cloud: ${message}\n`);
  if (
    !force &&
    /probe failed|health check|unhealthy|ECONNREFUSED|fetch failed|ENOTFOUND|timeout/i.test(message)
  ) {
    process.stderr.write("  hint: pass --force to persist without the /v1/models probe\n");
  }
}

async function runAddCloud(args: string[]): Promise<number> {
  const parsed = parseAddCloudFlags(args);
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const client = getNodeClient();
  try {
    // The router's local input enum predates 'gemini'; the CLI's CLOUD_PROVIDERS
    // tracks @llamactl/core CloudProviderSchema, which is the authoritative list.
    // Cast widens the static type so the new provider reaches the mutation; the
    // router still validates the payload via its own Zod schema at call time.
    const input = buildAddCloudInput(parsed) as Parameters<typeof client.nodeAddCloud.mutate>[0];
    const result = await client.nodeAddCloud.mutate(input);
    renderAddCloudSuccess(parsed, result);
    return 0;
  } catch (err) {
    reportAddCloudError(err, parsed.force);
    return 1;
  }
}
