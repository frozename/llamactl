#!/usr/bin/env bun
import { runEnv } from './commands/env.js';
import { runCatalog } from './commands/catalog.js';
import { runBench } from './commands/bench.js';
import { runRecommendations } from './commands/recommendations.js';

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
