// packages/remote/src/ops-chat/sessions/delete.ts
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defaultSessionDir } from '../paths.js';
import { sessionEventBus } from './event-bus.js';

export async function deleteSession(sessionId: string): Promise<void> {
  if (sessionEventBus.hasChannel(sessionId)) {
    throw new Error(`cannot delete in-flight session ${sessionId}`);
  }
  const dir = defaultSessionDir(process.env, sessionId);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
}