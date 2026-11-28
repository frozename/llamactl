import { formatHostForUrl } from "@llamactl/core/engines";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";

export type ConnectOmlxOwnerSocket = (signal?: AbortSignal | null) => Promise<Socket>;

const exec = promisify(execFile);

async function hasAcceptedPeer(
  socket: Socket,
  pid: number,
  signal?: AbortSignal | null,
): Promise<boolean> {
  const { remoteAddress, remotePort, localAddress, localPort } = socket;
  if (
    remoteAddress === undefined ||
    localAddress === undefined ||
    remotePort === undefined ||
    localPort === undefined
  )
    return false;

  const lsof = Bun.which("lsof", { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
  if (lsof === null) return false;
  const server = `${formatHostForUrl(remoteAddress)}:${String(remotePort)}`;
  const client = `${formatHostForUrl(localAddress)}:${String(localPort)}`;
  try {
    const { stdout } = await exec(
      lsof,
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-F", "n"],
      { encoding: "utf8", maxBuffer: 65536, timeout: 500, ...(signal ? { signal } : {}) },
    );
    return stdout.split("\n").includes(`n${server}->${client}`);
  } catch {
    return false;
  }
}

async function waitForAcceptedPeer(
  socket: Socket,
  pid: number,
  current: () => boolean,
  signal?: AbortSignal | null,
): Promise<boolean> {
  // The TCP handshake can finish before the engine accepts the peer.
  const deadline = AbortSignal.timeout(350);
  const proofSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const canProvePeer = (): boolean => !proofSignal.aborted && !socket.destroyed && current();
  while (canProvePeer()) {
    if (await hasAcceptedPeer(socket, pid, proofSignal)) return canProvePeer();
    await Bun.sleep(10);
  }
  return false;
}

export function connectOmlxOwnerSocket(
  endpoint: Readonly<{ host: string; port: number }>,
  pid: number,
  current: () => boolean,
): ConnectOmlxOwnerSocket {
  return async (signal): Promise<Socket> => {
    signal?.throwIfAborted();
    if (!current()) throw new Error("oMLX engine generation changed");
    const socket = createConnection({ ...endpoint, ...(signal ? { signal } : {}) });
    // A socket can close while the child process verifies its peer.
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect", signal ? { signal } : {});
      const proved = await waitForAcceptedPeer(socket, pid, current, signal);
      signal?.throwIfAborted();
      if (!proved || socket.destroyed || !current()) {
        throw new Error("oMLX connection has no verified engine peer");
      }
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}
