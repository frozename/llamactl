import { buildCompletionRequest, completeChat } from "../client.js";
import promptsRaw from "../fixtures/prompts-json-output.json" with { type: "json" };

export type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type JsonSchema =
  | {
      type: "object";
      required?: readonly string[];
      properties?: Record<string, JsonSchema>;
    }
  | { type: "array"; items: JsonSchema; required?: never; properties?: never; enum?: never }
  | { type: "string"; required?: never; properties?: never; items?: never; enum?: never }
  | { type: "number"; required?: never; properties?: never; items?: never; enum?: never }
  | { type: "integer"; required?: never; properties?: never; items?: never; enum?: never }
  | { enum: readonly string[]; required?: never; properties?: never; items?: never; type?: never };

function isJsonPayload(value: unknown): value is JsonPayload {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonPayload);
  if (kind !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonPayload);
}

export function extractJsonPayload(text: string): JsonPayload {
  const fenceStart = text.indexOf("```");
  const fenceEnd = fenceStart >= 0 ? text.indexOf("```", fenceStart + 3) : -1;
  const fenced =
    fenceStart >= 0 && fenceEnd > fenceStart ? text.slice(fenceStart + 3, fenceEnd).trim() : null;
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  const objectCandidate =
    jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : null;
  const candidates =
    fenced !== null
      ? [fenced.toLowerCase().startsWith("json") ? fenced.slice(4).trim() : fenced]
      : [text, ...(objectCandidate === null ? [] : [objectCandidate])];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isJsonPayload(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

export function validateJsonAgainstSchema(value: unknown, schema: JsonSchema): boolean {
  if ("enum" in schema) {
    const enumValues = (schema as { enum: readonly string[] }).enum;
    return typeof value === "string" && enumValues.includes(value);
  }
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (schema.type === "array")
    return (
      Array.isArray(value) && value.every((item) => validateJsonAgainstSchema(item, schema.items))
    );
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of schema.required ?? []) if (!(key in record)) return false;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key in record && !validateJsonAgainstSchema(record[key], child)) return false;
  }
  return true;
}

export interface JsonOutputFixture {
  name: string;
  prompt: string;
  schema: JsonSchema;
}

export interface JsonOutputResult {
  prompts: (JsonOutputFixture & { valid: boolean; text: string; parsed: JsonPayload })[];
  json_score: number;
}

export async function runJsonOutput(url: string): Promise<JsonOutputResult> {
  const prompts = promptsRaw as unknown as JsonOutputFixture[];
  const scored: (JsonOutputFixture & { valid: boolean; text: string; parsed: JsonPayload })[] = [];
  for (const prompt of prompts) {
    const req = buildCompletionRequest({
      messages: [{ role: "user", content: prompt.prompt }],
      maxTokens: 256,
      enableThinking: false,
    });
    const { resp } = await completeChat(url, req);
    const msg = resp.choices[0]?.message;
    const text =
      msg?.content && msg.content.length > 0 ? msg.content : (msg?.reasoning_content ?? "");
    const parsed = extractJsonPayload(text);
    const valid = parsed !== null && validateJsonAgainstSchema(parsed, prompt.schema);
    scored.push({ ...prompt, valid, text, parsed });
  }
  return {
    prompts: scored,
    json_score: scored.reduce((sum, item) => sum + Number(item.valid), 0) / scored.length,
  };
}
