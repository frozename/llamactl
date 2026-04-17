import { uninstall } from '@llamactl/core';

const USAGE = `Usage: llamactl uninstall <rel> [--force]

Removes a pulled model file plus its mmproj sibling when no other
GGUF remains in the repo directory, prunes matching rows from the
bench profile / history / vision files, and clears the custom-catalog
entry. Non-candidate scopes and promotion overrides require --force.
`;

export async function runUninstall(args: string[]): Promise<number> {
  let rel = '';
  let force = false;
  for (const arg of args) {
    switch (arg) {
      case '-f':
      case '--force':
        force = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return 0;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`Unknown flag: ${arg}\n`);
          return 1;
        }
        if (rel) {
          process.stderr.write(`Unexpected extra argument: ${arg}\n`);
          return 1;
        }
        rel = arg;
        break;
    }
  }

  if (!rel) {
    process.stdout.write(USAGE);
    return 1;
  }

  const report = uninstall.uninstall({ rel, force });
  if (report.error) {
    process.stderr.write(`${report.error}\n`);
    return report.code;
  }
  for (const line of report.actions) {
    process.stdout.write(`${line}\n`);
  }
  return report.code;
}
