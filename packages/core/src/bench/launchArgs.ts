/**
 * Server-side launch arguments emitted by the tuned-profile chooser.
 * Mirrors `_llama_server_profile_args` in the shell library. The tuned
 * records store only the winning profile name (default / throughput /
 * conservative); this map is what llama-server is then invoked with.
 */
export function serverProfileArgs(profile: string): string {
  switch (profile) {
    case 'throughput':
      return '-fa on -b 4096 -ub 1024';
    case 'conservative':
      return '-fa off -b 1024 -ub 256';
    case 'default':
    default:
      return '-fa on -b 2048 -ub 512';
  }
}

/**
 * Bench-side launch arguments used by `llama-bench` during the actual
 * tuning sweep. Slightly different flag shape than the server side
 * because llama-bench takes `-fa 1/0` rather than `on/off`.
 */
export function benchProfileArgs(profile: string): string {
  switch (profile) {
    case 'throughput':
      return '-fa 1 -b 4096 -ub 1024';
    case 'conservative':
      return '-fa 0 -b 1024 -ub 256';
    case 'default':
    default:
      return '-fa 1 -b 2048 -ub 512';
  }
}
