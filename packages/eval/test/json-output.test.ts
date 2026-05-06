import { describe, expect, test } from 'bun:test';
import { extractJsonPayload, validateJsonAgainstSchema } from '../src/runners/json-output.js';

const schema = {
  type: 'object',
  required: ['name', 'count'],
  properties: {
    name: { type: 'string' },
    count: { type: 'integer' },
  },
} as const;

describe('extractJsonPayload', () => {
  test('parses bare JSON', () => {
    expect(extractJsonPayload('{"name":"ok","count":2}')).toEqual({ name: 'ok', count: 2 });
  });

  test('parses JSON in a code fence', () => {
    expect(extractJsonPayload('```json\n{"name":"ok","count":2}\n```')).toEqual({ name: 'ok', count: 2 });
  });

  test('parses JSON embedded in prose', () => {
    expect(extractJsonPayload('Here you go: {"name":"ok","count":2}.')).toEqual({ name: 'ok', count: 2 });
  });

  test('returns null for malformed JSON', () => {
    expect(extractJsonPayload('{"name":')).toBeNull();
  });
});

describe('validateJsonAgainstSchema', () => {
  test('accepts matching objects', () => {
    expect(validateJsonAgainstSchema({ name: 'ok', count: 2 }, schema)).toBe(true);
  });

  test('rejects mismatched types', () => {
    expect(validateJsonAgainstSchema({ name: 'ok', count: 'two' }, schema)).toBe(false);
  });
});
