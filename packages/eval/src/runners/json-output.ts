import promptsRaw from '../fixtures/prompts-json-output.json' with { type: 'json' };
import { buildCompletionRequest, completeChat } from '../client.js';

type JsonSchema =
  | { type: 'object'; required?: readonly string[]; properties?: Record<string, JsonSchema>; enum?: never }
  | { type: 'array'; items: JsonSchema; required?: never; properties?: never; enum?: never }
  | { type: 'string'; required?: never; properties?: never; items?: never; enum?: never }
  | { type: 'number'; required?: never; properties?: never; items?: never; enum?: never }
  | { type: 'integer'; required?: never; properties?: never; items?: never; enum?: never }
  | { enum: readonly string[]; required?: never; properties?: never; items?: never; type?: never };

export function extractJsonPayload(text: string): unknown | null {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i) ?? text.match(/```\s*([\s\S]*?)\s*```/);
  const candidates = fenced ? [fenced[1] ?? ''] : [text, ...(text.match(/\{[\s\S]*\}/g) ?? [])];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export function validateJsonAgainstSchema(value: unknown, schema: JsonSchema): boolean {
  if ('enum' in schema) return typeof value === 'string' && !!schema.enum && schema.enum.includes(value);
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'array') return Array.isArray(value) && value.every((item) => validateJsonAgainstSchema(item, schema.items));
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) return false;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record && !validateJsonAgainstSchema(record[key], child)) return false;
    }
    return true;
  }
  return false;
}

export interface JsonOutputFixture {
  name: string;
  prompt: string;
  schema: JsonSchema;
}

export interface JsonOutputResult {
  prompts: Array<JsonOutputFixture & { valid: boolean; text: string; parsed: unknown | null }>;
  json_score: number;
}

export async function runJsonOutput(url: string): Promise<JsonOutputResult> {
  const prompts = promptsRaw as unknown as JsonOutputFixture[];
  const scored: Array<JsonOutputFixture & { valid: boolean }> = [];
  for (const prompt of prompts) {
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: prompt.prompt }],
      maxTokens: 256,
    });
    const { resp } = await completeChat(url, req);
    const text = resp.choices[0]?.message.content ?? '';
    const parsed = extractJsonPayload(text);
    const valid = parsed !== null && validateJsonAgainstSchema(parsed, prompt.schema);
    scored.push({ ...prompt, valid, text, parsed });
  }
  return {
    prompts: scored,
    json_score: scored.reduce((sum, item) => sum + Number(item.valid), 0) / scored.length,
  };
}
