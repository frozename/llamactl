// A stand-in for /usr/bin/systemd-run used by the #806 phase 3 ModelRun scope
// tests. It is only ever passed as the literal launcher's `systemdRunPath`, so
// PATH is never consulted. The first invocation re-execs bash with argv0
// `systemd-run`, so the real pid-identity resolvers match the wrapper
// expectation without a processCommand stub.

import { dirname, join } from "node:path";

import { writeFileSync } from "../../src/safe-fs.js";

export type FakeSystemdRunMode = "ok" | "collision" | "hang" | "term-exit-1";

const BODY: Record<FakeSystemdRunMode, string> = {
  ok: 'echo "Running scope as unit: ${unit}.scope" >&2\nexec "$@"\n',
  collision:
    'echo "Failed to start transient scope unit: Unit ${unit}.scope was already loaded or has a fragment file." >&2\nexit 1\n',
  hang: "while :; do sleep 0.05; done\n",
  "term-exit-1": "trap 'exit 1' TERM\nwhile :; do sleep 0.05; done\n",
};

export function writeFakeSystemdRun(dir: string, mode: FakeSystemdRunMode): string {
  const script = [
    "#!/bin/bash",
    'if [ -z "$__FAKE_SDRUN" ]; then export __FAKE_SDRUN=1; exec -a systemd-run /bin/bash "$0" "$@"; fi',
    "unset __FAKE_SDRUN",
    'unit=""; while [ $# -gt 0 ]; do case "$1" in --unit=*) unit="${1#--unit=}";; --) shift; break;; esac; shift; done',
    BODY[mode],
  ].join("\n");
  const path = join(dir, `fake-systemd-run-${mode}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  return dirname(path) === dir ? path : join(process.cwd(), path);
}
