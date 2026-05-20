import { describe, expect, test } from 'bun:test';
import { buildCompletionRequest, type ResponseFormat } from '../src/client.js';

describe('buildCompletionRequest', () => {
  test('builds OpenAI-compat request without tools', () => {
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 192,
      seed: 42,
    });
    expect(req.body.model).toBe('local');
    expect(req.body.temperature).toBe(0);
    expect(req.body.max_tokens).toBe(192);
    expect(req.body.seed).toBe(42);
    expect(req.body.stream).toBe(false);
    expect(req.body.tools).toBeUndefined();
  });

  test('attaches tools when provided', () => {
    const tools = [{ type: 'function' as const, function: { name: 'x', description: '', parameters: {} } }];
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: 'use the tool' }],
      maxTokens: 192,
      tools,
    });
    expect(req.body.tools).toEqual(tools);
    expect(req.body.tool_choice).toBe('auto');
  });

  test('attaches response_format when provided', () => {
    const response_format: ResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'memory_efficacy_4way',
        schema: {
          type: 'object',
          properties: {
            classification: { type: 'string', enum: ['missed_registration'] },
            reason: { type: 'string' },
          },
          required: ['classification', 'reason'],
        },
      },
    };
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: 'classify' }],
      maxTokens: 192,
      response_format,
    });
    expect(req.body.response_format).toEqual(response_format);
  });
});
