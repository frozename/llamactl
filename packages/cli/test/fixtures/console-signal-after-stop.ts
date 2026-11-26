import { runConsole } from "../../src/commands/console.js";

type SignalIgnoreConsoleDeps = NonNullable<Parameters<typeof runConsole>[1]> & {
  ignoreSignalsAfterStop: true;
};

const dist = process.argv[2];
if (dist === undefined) {
  process.stderr.write("console-signal-after-stop: missing dist directory\n");
  process.exit(2);
}

const base = process.listenerCount("SIGTERM");
const deps: SignalIgnoreConsoleDeps = { ignoreSignalsAfterStop: true };
const run = runConsole(["--port", "0", "--no-open", "--dist", dist], deps);
const deadline = Date.now() + 10_000;
while (process.listenerCount("SIGTERM") <= base && Date.now() < deadline) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 15);
  });
}
if (process.listenerCount("SIGTERM") <= base) {
  process.stderr.write("console-signal-after-stop: SIGTERM listener was not installed\n");
  process.exit(3);
}

process.emit("SIGTERM");
const code = await run;
process.stdout.write(`RETURNED ${String(code)}\n`);
const reader = Bun.stdin.stream().getReader();
await reader.read();
process.exit(code);
