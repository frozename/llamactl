import { describe, expect, test } from 'bun:test';
import {
  encodeTunnelMessage,
  parseTunnelMessage,
  TunnelMessageSchema,
  type TunnelMessage,
  type TunnelStreamCancel,
  type TunnelStreamDone,
  type TunnelStreamEvent,
} from '../src/tunnel/messages.js';

/**
 * Wire-schema round-trip coverage for the streaming variants added in
 * Slice B. The three new frames ride inside the existing
 * discriminated-union `TunnelMessageSchema`, so parseTunnelMessage
 * must recognise them the same way as the six req/res frames.
 */
describe('tunnel message: streaming variants', () => {
  test('stream-event round-trips through parse/encode', () => {
    const msg: TunnelStreamEvent = {
      type: 'stream-event',
      id: 'sub-123',
      index: 0,
      data: { progress: 42, file: 'q4_k_m.gguf' },
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = parseTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  test('stream-event permits arbitrary data shapes', () => {
    const cases: unknown[] = [
      null,
      0,
      'string',
      { nested: { deeply: { value: true } } },
      [1, 2, 3],
    ];
    for (const data of cases) {
      const msg: TunnelStreamEvent = {
        type: 'stream-event',
        id: 'sub-x',
        index: 7,
        data,
      };
      const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
      expect(decoded).toEqual(msg);
    }
  });

  test('stream-event rejects negative index', () => {
    const bad = {
      type: 'stream-event',
      id: 'sub',
      index: -1,
      data: {},
    };
    const parsed = parseTunnelMessage(JSON.stringify(bad));
    expect(parsed).toBeNull();
  });

  test('stream-event rejects empty id', () => {
    const bad = {
      type: 'stream-event',
      id: '',
      index: 0,
      data: {},
    };
    const parsed = parseTunnelMessage(JSON.stringify(bad));
    expect(parsed).toBeNull();
  });

  test('stream-done with ok:true round-trips', () => {
    const msg: TunnelStreamDone = {
      type: 'stream-done',
      id: 'sub-456',
      ok: true,
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test('stream-done with ok:false + error round-trips', () => {
    const msg: TunnelStreamDone = {
      type: 'stream-done',
      id: 'sub-789',
      ok: false,
      error: { code: 'TIMEOUT', message: 'subscription timed out' },
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test('stream-cancel round-trips', () => {
    const msg: TunnelStreamCancel = {
      type: 'stream-cancel',
      id: 'sub-cancel',
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test('discriminated union narrows type in TypeScript', () => {
    const parsed = parseTunnelMessage(
      encodeTunnelMessage({
        type: 'stream-event',
        id: 'sub',
        index: 0,
        data: 'payload',
      }),
    );
    expect(parsed).not.toBeNull();
    const narrow: TunnelMessage = parsed!;
    if (narrow.type === 'stream-event') {
      // Accessing index + data compile-time-safe via discrimination.
      expect(narrow.index).toBe(0);
      expect(narrow.data).toBe('payload');
    } else {
      throw new Error('discriminated union did not narrow');
    }
  });

  test('schema parses all three new frames in list', () => {
    const frames: TunnelMessage[] = [
      { type: 'stream-event', id: 'a', index: 0, data: 1 },
      { type: 'stream-event', id: 'a', index: 1, data: 2 },
      { type: 'stream-done', id: 'a', ok: true },
      { type: 'stream-cancel', id: 'b' },
    ];
    for (const f of frames) {
      expect(TunnelMessageSchema.safeParse(f).success).toBe(true);
    }
  });
});
