process.on("exit", (code) => {
  process.stderr.write(
    `EXIT_LISTENERS ${String(process.listenerCount("SIGTERM"))} ${String(process.listenerCount("SIGINT"))} code=${String(code)}\n`,
  );
});
