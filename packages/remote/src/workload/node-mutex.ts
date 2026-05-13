const locks = new Map<string, Promise<unknown>>();

export async function withNodeLock<T>(nodeName: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(nodeName) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => next);
  locks.set(nodeName, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(nodeName) === chained) locks.delete(nodeName);
  }
}
