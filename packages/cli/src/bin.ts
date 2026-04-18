#!/usr/bin/env bun
import { runEnv } from './commands/env.js';
import { runCatalog } from './commands/catalog.js';
import { runBench } from './commands/bench.js';
import { runCandidate } from './commands/candidate.js';
import { runServer } from './commands/server.js';
import { runKeepAlive } from './commands/keepAlive.js';
import { runLMStudio } from './commands/lmstudio.js';
import { runRecommendations } from './commands/recommendations.js';
import { runDiscover } from './commands/discover.js';
import { runPull } from './commands/pull.js';
import { runUninstall } from './commands/uninstall.js';

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

More commands will land as the TypeScript core library absorbs the
historical zsh surface. See https://github.com/frozename/llamactl.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'env':
      return runEnv(rest);
    case 'catalog':
      return runCatalog(rest);
    case 'bench':
      return runBench(rest);
    case 'recommendations':
      return runRecommendations(rest);
    case 'discover':
      return runDiscover(rest);
    case 'uninstall':
      return runUninstall(rest);
    case 'pull':
      return runPull(rest);
    case 'candidate':
      return runCandidate(rest);
    case 'server':
      return runServer(rest);
    case 'keep-alive':
      return runKeepAlive(rest);
    case 'lmstudio':
      return runLMStudio(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
