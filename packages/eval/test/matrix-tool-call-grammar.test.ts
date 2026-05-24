import { describe, expect, test } from 'bun:test';
import { __signature, toolCallGrammarWorkload } from '../src/matrix/workloads/tool-call-grammar.js';

describe('tool-call-grammar workload', () => {
  test('signature for an empty-args tool call', () => {
    expect(__signature([{ function: { name: 'ha_pulse', arguments: '{}' } }])).toBe(
      JSON.stringify([['ha_pulse', []]]),
    );
  });

  test('signature sorts argument keys', () => {
    expect(__signature([{ function: { name: 'foo', arguments: '{"a":1,"b":2}' } }])).toBe(
      JSON.stringify([['foo', ['a', 'b']]]),
    );
  });

  test('text-only gold maps to no-tool-call', () => {
    expect(__signature(undefined)).toBe('__no_tool_call__');
  });

  test('bad tool-call JSON maps to parse error', () => {
    expect(__signature([{ function: { name: 'foo', arguments: '{' } }])).toBe('__parse_error__');
  });

  test('scorer exact_match reflects signature equality', async () => {
    const row = {
      messages: [
        { role: 'user', content: 'call the tool' },
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'ha_pulse', arguments: '{}' },
            },
          ],
        },
      ],
    };

    expect((await toolCallGrammarWorkload.scorer(row, '', {
      tool_calls: [{ type: 'function', function: { name: 'ha_pulse', arguments: '{}' } }],
    })).metrics.exact_match).toBe(1);

    expect((await toolCallGrammarWorkload.scorer(row, '', {
      tool_calls: [{ type: 'function', function: { name: 'different_tool', arguments: '{}' } }],
    })).metrics.exact_match).toBe(0);
  });
});
