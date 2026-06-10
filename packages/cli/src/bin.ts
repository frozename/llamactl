#!/usr/bin/env bun
import { runAdmit } from "./commands/admit.js";
import { runAgent } from "./commands/agent.js";
import { runArtifacts } from "./commands/artifacts.js";
import { runBench } from "./commands/bench.js";
import { runCandidate } from "./commands/candidate.js";
import { runCatalog } from "./commands/catalog.js";
import { runComposite } from "./commands/composite.js";
import { runController } from "./commands/controller.js";
import { runCostGuardian } from "./commands/cost-guardian.js";
import { runCtx } from "./commands/ctx.js";
import { runDeployNode } from "./commands/deploy.js";
import { runDisable } from "./commands/disable.js";
import { runDiscover } from "./commands/discover.js";
import { runDoctor } from "./commands/doctor.js";
import { runEmbersynth } from "./commands/embersynth.js";
import { runEnable } from "./commands/enable.js";
import { runEnv } from "./commands/env.js";
import { runEval } from "./commands/eval.js";
import { runExpose } from "./commands/expose.js";
import { runFleet } from "./commands/fleet.js";
import { runHeal } from "./commands/heal.js";
import { runInfra } from "./commands/infra.js";
import { runInit } from "./commands/init.js";
import { runKeepAlive } from "./commands/keepAlive.js";
import { runLMStudio } from "./commands/lmstudio.js";
import { runNode } from "./commands/node.js";
import { runPlan } from "./commands/plan.js";
import { runProject } from "./commands/project.js";
import { runPull } from "./commands/pull.js";
import { runRag } from "./commands/rag.js";
import { runRecommendations } from "./commands/recommendations.js";
import { runRunbookCmd } from "./commands/runbook.js";
import { runServer } from "./commands/server.js";
import { runSirius } from "./commands/sirius.js";
import { runSupervisor } from "./commands/supervisor.js";
import { runTunnel } from "./commands/tunnel.js";
import { runUninstall } from "./commands/uninstall.js";
import { runApply, runDelete, runDescribe, runGet } from "./commands/workload.js";
import { extractGlobalFlags, setGlobals } from "./dispatcher.js";

const USAGE = `llamactl — local-first toolkit for running llama.cpp

Usage:
  llamactl env --eval                         Emit POSIX export lines for eval
  llamactl env --json                         Emit the resolved environment as JSON
  llamactl catalog list [all|builtin|custom]  List curated + custom catalog rows
      [--json|--tsv]
  llamactl bench show <target>                Latest tuned bench record for target
  llamactl bench history [target]             Last 20 bench-history rows (optionally
                                              filtered to a single rel/preset)
  llamactl catalog status <rel> [--json]      Layered class + scope + HF lookup
  llamactl recommendations [current|all|<p>]  Preset ladder per profile with live HF
  llamactl discover [filter] [profile] [limit]
                                              HF discovery feed, classified and
                                              scored for fit on the chosen profile

Write commands:
  llamactl catalog add <repo> <file> [label] [family] [class] [scope]
                                              Append a custom catalog entry
  llamactl catalog promote <profile> <preset> <rel-or-alias>
                                              Write a preset override
  llamactl catalog promotions                 List active promotions
  llamactl uninstall <rel> [--force]          Remove a pulled model and TSV state
  llamactl pull <repo> [target]               Bulk pull an HF repo
  llamactl pull file <repo> <file>            Pull a single GGUF + mmproj sibling
  llamactl pull candidate <repo> [file] [profile]
                                              Pick the best GGUF for the profile
                                              and pull it (--json supported)
  llamactl bench preset <target> [auto|text|vision]
                                              Sweep llama-bench across three
                                              profiles and save the fastest
  llamactl bench vision <target>              Run the multimodal bench and
                                              record the timings (--json supported)
  llamactl candidate test <repo> [file] [profile]
                                              Discover + pull + tune + compare
                                              pipeline (--json supported)
  llamactl server start [target] [--timeout=60] [-- extra llama-server args]
                                              Start llama-server in the
                                              background with tuned args
  llamactl server stop [--grace=5]            Stop the tracked llama-server
  llamactl server status                      Show state + endpoint + pid
  llamactl keep-alive start <target>          Detached supervisor that
                                              restarts llama-server on exit
  llamactl keep-alive stop                    Signal the supervisor to exit
  llamactl keep-alive status                  Show supervisor + state snapshot
  llamactl lmstudio scan [--root=<dir>]       List GGUFs in LM Studio's tree
  llamactl lmstudio import [--apply] [--no-link]
                                              Plan or apply a custom-catalog
                                              import of LM Studio models

Remote node management (Kubernetes-style):
  llamactl agent init [--host=<h>] [--port=<n>] [--name=<n>] [--san=...]
                                              Provision the local node as an
                                              agent; prints a bootstrap line
  llamactl agent serve [--bind=<h>] [--port=<n>]
                                              Run the node agent (long-running)
  llamactl agent status                       Print the agent's config
  llamactl node ls [--json]                   List nodes in the current context
  llamactl node add <name> --bootstrap <blob>
                                              Register a node from a bootstrap
                                              blob emitted by 'agent init'
  llamactl node add <name> --server <url>
      --fingerprint <sha256:...> --token <tok>
                                              Register a node explicitly
  llamactl node add-cloud <name>              Register a gateway/cloud node
      --provider <sirius|openai|...>          (sirius, embersynth, openai,
      --base-url <url> [--api-key-ref <r>]     anthropic, openai-compatible).
      [--display-name <n>] [--force]          --force skips the probe.
  llamactl node rm <name>                     Remove a node (not 'local')
  llamactl node test <name>                   Call nodeFacts() against a node
  llamactl ctx current                        Print the current-context name
  llamactl ctx use <name>                     Switch current-context
  llamactl ctx get                            Print the kubeconfig YAML
  llamactl ctx nodes                          Alias for 'node ls'

Declarative workloads (Kubernetes-style):
  llamactl apply -f <manifest.yaml>           Apply a ModelRun: start the
                                              server on the target node,
                                              restart it if config changed,
                                              leave untouched on match.
  llamactl get workloads [--json]             List workloads + live phase
  llamactl describe workload <name>           Show manifest + live status
  llamactl delete workload <name>             Stop the server and remove
      [--keep-running]                        the manifest (or just remove
                                              with --keep-running).
  llamactl enable <workload>                  Flip spec.enabled=true and
                                              re-apply the manifest.
  llamactl disable <workload>                 Flip spec.enabled=false and
                                              re-apply the manifest.
  llamactl controller serve                   Reconcile every manifest on
      [--interval=<s>] [--once]               a timer; restarts servers
                                              that drift from the spec.
  llamactl composite apply -f <file.yaml>     Apply a Composite manifest
      [--dry-run]                             (services, workloads, rag
                                              nodes, gateways) with DAG
                                              ordering and rollback.
  llamactl composite destroy <name>           Reverse-topo teardown of
      [--dry-run] [--purge-volumes]           a composite; --purge-volumes
                                              also removes backing docker
                                              volumes.
  llamactl composite list                     List persisted composites
                                              with phase + component count.
  llamactl composite get <name>               Print the stored composite
                                              manifest as YAML.
  llamactl composite status <name>            Stream live CompositeApplyEvents
                                              for an apply-in-flight or the
                                              last known result.
  llamactl doctor [--verbose]                 Probe agent + docker + k8s +
      [--timeout=<s>]                          keychain readiness and print
                                              an actionable status table.
  llamactl init [--yes] [--runtime=auto]      First-run wizard: pick a
      [--template=<k>] [--name=<n>]            runtime, seed a quickstart
      [--no-apply] [--force]                   composite, optionally apply.
  llamactl expose <target> [--node <n>]       Deploy a model as a workload
      [--name <w>] [--extra-args="..."]       and print the OpenAI URL
      [--timeout=<s>] [--json]                external clients should use.
  llamactl sirius export                       Emit LLAMACTL_NODES config for
      [--format json|yaml|env]                 a sirius-gateway deployment.
      [--token-inline]
  llamactl rag ask <question>                  Retrieve top-k passages from a
      --kb <rag-node> --via <node>              RAG node and route a chat
      --model <id> [--top-k=<N>]                completion through the named
      [--collection=<n>] [--max-tokens=<N>]     gateway/cloud/agent node.
      [--temperature=<f>] [--system-prompt=<s>] --cite prints passages; --json
      [--cite] [--json]                         emits a structured doc.
  llamactl rag pipeline <subcommand>           Apply + run declarative RAG
      apply | run | list | get | rm | logs     ingestion pipelines.
  llamactl project <subcommand>                Register a local filesystem
      add | apply | list | get | rm            project with optional RAG
      index | route                            target + task-kind → routing
                                               policy. \`index\` auto-wires
                                               a RagPipeline; \`route\`
                                               shows the resolved target.

Agentic operations:
  llamactl runbook list                       Enumerate operator runbooks
  llamactl runbook run <name>                 Chain MCP tools end-to-end
      [--dry-run] [--params <json>]           (see llamactl runbook --help)
  llamactl heal [--once] [--interval=<s>]     Observe fleet health + journal
      [--quiet] [--journal=<path>]            state transitions
  llamactl cost-guardian tick                 Evaluate spend vs budget +
      [--config=<path>] [--skip-journal]       emit tiered intent
  llamactl plan run "<goal>" [--stub]         LLM-backed planner — emit a
      [--auto] [--json] [--model=<id>]         validated MCP-tool plan
      [--base-url=<url>] [--api-key-env=<v>]
  llamactl deploy-node <name>                 Mint a bootstrap token for a
      [--central-url=<url>] [--ttl=<m>]       new node + print the
                                              curl-pipe-sh one-liner
      [--list | --prune]                      List or prune outstanding
  llamactl artifacts build-agent              Build a llamactl-agent
      [--target=<platform>]                   binary for central to
      [--src=<path>] [--dir=<path>]           serve from /artifacts
  llamactl artifacts fetch                    Download a published release
      [--version=<v>] [--target=<p>]          from GitHub (sha-verified)
      [--repo=<owner/repo>] [--dir=<path>]
  llamactl artifacts list                     Show built agent binaries
  llamactl artifacts show-path                Print the absolute path
      [--target=<platform>]                   where /artifacts expects
  llamactl eval run|report|leaderboard        Evaluate a model, render a report,
                                              or print the leaderboard table
  llamactl infra list                         List installed infra on a node
      [--node <n>]
  llamactl infra install <pkg>                Install a pkg version from a
      --version=<v> --tarball-url=<url>       SHA-verified tarball, flip
      --sha256=<hex> [--node <n>]             the current symlink on success
      [--no-activate] [--force]
  llamactl infra activate <pkg>               Point the current symlink at
      --version=<v> [--node <n>]              a specific installed version
  llamactl infra uninstall <pkg>              Remove a version (or the whole
      [--version=<v>] [--node <n>]            package when --version omitted)
  llamactl tunnel pin-central                 Capture the central agent's TLS
      [--context=<name>] [--url=<url>]        cert + fingerprint and pin the
                                              /tunnel-relay POST against it.
  llamactl fleet snapshot [--all]             Show local or cluster fleet snapshots
  llamactl fleet status                       Show one-line fleet pressure summary per node

More commands will land as the TypeScript core library absorbs the
historical zsh surface. See https://github.com/frozename/llamactl.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "env":
      return await runEnv(rest);
    case "catalog":
      return await runCatalog(rest);
    case "bench":
      return await runBench(rest);
    case "recommendations":
      return await runRecommendations(rest);
    case "discover":
      return await runDiscover(rest);
    case "uninstall":
      return await runUninstall(rest);
    case "pull":
      return await runPull(rest);
    case "candidate":
      return await runCandidate(rest);
    case "server":
      return await runServer(rest);
    case "keep-alive":
      return await runKeepAlive(rest);
    case "lmstudio":
      return await runLMStudio(rest);
    case "agent":
      return await runAgent(rest);
    case "node":
      return await runNode(rest);
    case "rag":
      return await runRag(rest);
    case "ctx":
      return await runCtx(rest);
    case "apply":
      return await runApply(rest);
    case "get":
      return await runGet(rest);
    case "describe":
      return await runDescribe(rest);
    case "delete":
      return await runDelete(rest);
    case "enable":
      return await runEnable(rest);
    case "disable":
      return await runDisable(rest);
    case "composite":
      return await runComposite(rest);
    case "doctor":
      return await runDoctor(rest);
    case "init":
      return await runInit(rest);
    case "controller":
      return await runController(rest);
    case "expose":
      return await runExpose(rest);
    case "sirius":
      return await runSirius(rest);
    case "embersynth":
      return await runEmbersynth(rest);
    case "runbook":
      return await runRunbookCmd(rest);
    // Alias: canonical form is 'llamactl agent heal'.
    case "heal":
      return await runHeal(rest);
    case "supervisor":
      process.exit(await runSupervisor(rest));
    // eslint-disable-next-line no-fallthrough -- Preserve existing CLI/test semantics while clearing strict lint debt.
    case "admit":
      process.exit(await runAdmit(rest));
    // eslint-disable-next-line no-fallthrough -- Preserve existing CLI/test semantics while clearing strict lint debt.
    case "cost-guardian":
      return await runCostGuardian(rest);
    case "plan":
      return await runPlan(rest);
    case "deploy-node":
      return await runDeployNode(rest);
    case "artifacts":
      return await runArtifacts(rest);
    case "eval":
      return await runEval(rest);
    case "infra":
      return await runInfra(rest);
    case "project":
      return await runProject(rest);
    case "tunnel":
      return await runTunnel(rest);
    case "fleet":
      return await runFleet(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

let parsedArgv: string[];
try {
  const { globals, rest } = extractGlobalFlags(process.argv.slice(2));
  setGlobals(globals);
  parsedArgv = rest;
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
const code = await main(parsedArgv);
process.exit(code);
