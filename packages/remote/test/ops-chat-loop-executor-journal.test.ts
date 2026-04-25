import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoopExecutor } from '../src/ops-chat/loop-executor';
import { readJournal } from '../src/ops-chat/sessions/journal';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';

describe('loop-executor → journal + bus', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-loop-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes session_started and done to journal when planner returns no work', async () => {
    let capturedSessionId = '';
    const stream = runLoopExecutor({
      goal: 'do nothing',
      executor: {
        async generate() { 
          return { 
            ok: true,
            rawPlan: { steps: [], reasoning: 'no work needed', requiresConfirmation: false }
          }; 
        },
      } as any,
      tools: [],
      allowlist: () => true,
    });
    for await (const e of stream) {
      if (e.type === 'plan_proposed') capturedSessionId = e.sessionId;
      if (e.type === 'done') capturedSessionId ||= '';
    }
    // capture sessionId from the directory we just wrote
    const root = join(tmp, 'ops-chat', 'sessions');
    const fs = await import('node:fs/promises');
    const dirs = await fs.readdir(root);
    expect(dirs.length).toBe(1);
    const events = await readJournal(dirs[0]!);
    if (events[1]?.type === 'refusal') {
      console.log('REFUSAL:', events[1]);
    }
    expect(events.map((e) => e.type)).toEqual(['session_started', 'done']);
    expect(sessionEventBus.hasChannel(dirs[0]!)).toBe(false);
  });
});