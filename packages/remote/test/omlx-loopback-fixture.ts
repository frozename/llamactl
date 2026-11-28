const LISTENER = String.raw`
import { connect, createServer } from "node:net";

const server = createServer((peer) => {
  const upstream = connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
  peer.on("error", () => upstream.destroy());
  upstream.on("error", () => peer.destroy());
  peer.pipe(upstream).pipe(peer);
});
server.listen({ host: "127.0.0.1", port: 0 }, () => {
  console.log(server.address().port);
});
`;

type OwnedListener = {
  endpoint: { host: "127.0.0.1"; port: number };
  pid: number;
  [Symbol.asyncDispose](): Promise<void>;
};

// Keep accepted sockets in an engine process while the fixture inspects owner state.
export async function ownedOmlxListener(upstreamPort: number): Promise<OwnedListener> {
  const child = Bun.spawn([process.execPath, "-e", LISTENER, String(upstreamPort)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  async function dispose(): Promise<void> {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  try {
    const reply = await Promise.race([reader.read(), Bun.sleep(3000).then(() => undefined)]);
    const port = Number(new TextDecoder().decode(reply?.value).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("oMLX fixture listener did not report a port");
    }
    return {
      endpoint: { host: "127.0.0.1", port },
      pid: child.pid,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
