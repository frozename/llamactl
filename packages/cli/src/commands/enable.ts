import { setWorkloadEnabled } from './setEnabled.js';

const USAGE = `Usage: llamactl enable <workload>

Set spec.enabled = true on the workload manifest and re-apply so the
server starts.
`;

export async function runEnable(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE);
    return args.length === 0 ? 1 : 0;
  }
  const name = args[0]!;
  const result = await setWorkloadEnabled(name, true);
  if (result.message) {
    (result.code === 0 ? process.stdout : process.stderr).write(result.message);
  }
  return result.code;
}
