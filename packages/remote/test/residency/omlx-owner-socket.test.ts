import { expect, test } from "bun:test";

import { connectOmlxOwnerSocket } from "../../src/residency/omlx-owner-socket.js";

const OWNED_LISTENER = String.raw`
import select
import socket
import sys

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    print(listener.getsockname()[1], flush=True)
    if not select.select([listener], [], [], 3)[0]:
        sys.exit(2)
    print("queued", flush=True)
    if sys.stdin.read(1) != "a":
        sys.exit(3)
    peer, _ = listener.accept()
    with peer:
        sys.stdin.read(1)
`;

test("an established connection waits for the exact process to accept its peer", async () => {
  const child = Bun.spawn(["python3", "-u", "-c", OWNED_LISTENER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = child.stdout.getReader();
  const decode = new TextDecoder();
  try {
    const port = Number(decode.decode((await stdout.read()).value).trim());
    expect(port).toBeGreaterThan(0);
    const connect = connectOmlxOwnerSocket({ host: "127.0.0.1", port }, child.pid, () => true);
    const proof = connect(AbortSignal.timeout(2000)).then(
      (socket) => ({ outcome: "verified" as const, socket }),
      () => ({ outcome: "refused" as const }),
    );
    expect(decode.decode((await stdout.read()).value).trim()).toBe("queued");
    const beforeAccept = await Promise.race([
      proof.then(({ outcome }) => outcome),
      Bun.sleep(90).then(() => "pending"),
    ]);
    await child.stdin.write("a");
    await child.stdin.flush();
    const result = await proof;
    if (result.outcome === "verified") result.socket.destroy();
    expect(beforeAccept).toBe("pending");
    expect(result.outcome).toBe("verified");
  } finally {
    if (child.exitCode === null) await child.stdin.end();
    child.kill();
    await child.exited;
    stdout.releaseLock();
  }
});
