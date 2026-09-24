/**
 * Feature-capability contracts for the unified router (P0.2, design §4.1–4.2).
 * A route advertises what it can do; a request derives what it needs; the
 * pure check produces typed rejection reasons. Pure module — no I/O.
 */
import { z } from "zod";

export const InferenceOperationSchema = z.enum(["generate", "embed", "count-tokens"]);
export type InferenceOperation = z.infer<typeof InferenceOperationSchema>;

export const IngressProtocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
]);
export type IngressProtocol = z.infer<typeof IngressProtocolSchema>;

export const StreamingModeSchema = z.enum(["none", "buffered", "sse"]);
export type StreamingMode = z.infer<typeof StreamingModeSchema>;

export const ModalitySchema = z.enum(["text", "image", "audio", "document"]);
export type Modality = z.infer<typeof ModalitySchema>;

export const RouteCapabilitiesSchema = z.object({
  operations: z.array(InferenceOperationSchema).min(1),
  protocols: z.array(IngressProtocolSchema).min(1),
  streaming: StreamingModeSchema,
  modalities: z.array(ModalitySchema).min(1),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
  tokenCounting: z.boolean(),
  cancellation: z.boolean(),
  sessions: z.boolean(),
});
export type RouteCapabilities = z.infer<typeof RouteCapabilitiesSchema>;

export const RequiredFeaturesSchema = z.object({
  operation: InferenceOperationSchema,
  protocol: IngressProtocolSchema,
  stream: z.boolean(),
  modalities: z.array(ModalitySchema),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
  session: z.boolean(),
  cancellation: z.boolean(),
});
export type RequiredFeatures = z.infer<typeof RequiredFeaturesSchema>;

export const CapabilityRejectionSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("unsupported-operation"), operation: InferenceOperationSchema }),
  z.object({ reason: z.literal("unsupported-protocol"), protocol: IngressProtocolSchema }),
  z.object({
    reason: z.literal("unsupported-streaming"),
    requested: z.literal("sse"),
    offered: StreamingModeSchema,
  }),
  z.object({ reason: z.literal("unsupported-modality"), modality: ModalitySchema }),
  z.object({ reason: z.literal("unsupported-tools") }),
  z.object({ reason: z.literal("unsupported-structured-output") }),
  z.object({ reason: z.literal("unsupported-token-counting") }),
  z.object({ reason: z.literal("unsupported-cancellation") }),
  z.object({ reason: z.literal("unsupported-session") }),
]);
export type CapabilityRejection = z.infer<typeof CapabilityRejectionSchema>;

/**
 * What the legacy forwarding path will attempt today. The proxy forwards
 * OpenAI/Anthropic/Responses bodies verbatim (translating the latter two),
 * streams SSE, cancels on client disconnect, and carries oMLX session
 * handles — so a legacy-derived advertisement may admit all of it.
 */
function freezeCapabilities<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeCapabilities(nested);
    Object.freeze(value);
  }
  return value;
}

export const LEGACY_PROXY_CAPABILITIES: RouteCapabilities = freezeCapabilities({
  operations: ["generate", "embed", "count-tokens"],
  protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
  streaming: "sse",
  modalities: ["text", "image", "audio", "document"],
  tools: true,
  structuredOutput: true,
  tokenCounting: true,
  cancellation: true,
  sessions: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PART_MODALITY: Record<string, Modality> = {
  image_url: "image",
  image: "image",
  input_image: "image",
  input_audio: "audio",
  audio: "audio",
  input_file: "document",
  document: "document",
  file: "document",
};

const TOOL_PART_TYPES = new Set([
  "tool_use",
  "tool_result",
  "function_call",
  "function_call_output",
]);

function scanForModalities(root: unknown, found: Set<Modality>): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      stack.push(...(item as unknown[]));
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = record["type"];
    const modality = typeof type === "string" ? PART_MODALITY[type] : undefined;
    if (modality !== undefined) found.add(modality);
    stack.push(...Object.values(record));
  }
}

function scanForToolParts(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      stack.push(...(item as unknown[]));
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = record["type"];
    if (typeof type === "string" && TOOL_PART_TYPES.has(type)) return true;
    stack.push(...Object.values(record));
  }
  return false;
}

function modalitiesFromBody(body: Record<string, unknown>): Set<Modality> {
  const found = new Set<Modality>(["text"]);
  scanForModalities(body["messages"], found);
  // Responses API carries its content parts under `input` instead of
  // `messages`; Anthropic shares the `messages` key already scanned above.
  scanForModalities(body["input"], found);
  const declared = body["modalities"];
  if (Array.isArray(declared)) {
    for (const m of declared as unknown[]) {
      const modality = ModalitySchema.safeParse(m);
      if (modality.success && modality.data !== "text") found.add(modality.data);
    }
  }
  return found;
}

function bodyRequestsTools(body: Record<string, unknown>): boolean {
  const tools = body["tools"];
  if (Array.isArray(tools) && tools.length > 0) return true;
  const functions = body["functions"];
  if (Array.isArray(functions) && functions.length > 0) return true;
  const toolChoice = body["tool_choice"];
  if (
    toolChoice !== undefined &&
    toolChoice !== "none" &&
    !(isRecord(toolChoice) && toolChoice["type"] === "none")
  ) {
    return true;
  }
  return scanForToolParts(body["messages"]) || scanForToolParts(body["input"]);
}

function bodyRequestsStructuredOutput(body: Record<string, unknown>): boolean {
  const format = body["response_format"];
  if (isRecord(format)) {
    const type = format["type"];
    if (typeof type === "string" && type !== "text") return true;
  }
  // Responses API nests the format under text.format.
  const text = body["text"];
  if (isRecord(text) && isRecord(text["format"])) {
    const type = text["format"]["type"];
    if (typeof type === "string" && type !== "text") return true;
  }
  return false;
}

function bodyRequestsSession(body: Record<string, unknown>): boolean {
  return typeof body["session_id"] === "string" || typeof body["sessionId"] === "string";
}

export function deriveRequestFeatures(input: {
  operation: InferenceOperation;
  ingressProtocol: IngressProtocol;
  stream: boolean;
  hasSession?: boolean;
  nativeBody?: unknown;
}): RequiredFeatures {
  const body = isRecord(input.nativeBody) ? input.nativeBody : {};
  return {
    operation: input.operation,
    protocol: input.ingressProtocol,
    stream: input.stream,
    modalities: [...modalitiesFromBody(body)],
    tools: bodyRequestsTools(body),
    structuredOutput: bodyRequestsStructuredOutput(body),
    session: input.hasSession ?? bodyRequestsSession(body),
    cancellation: true,
  };
}

const FLAG_REJECTIONS: {
  req: "tools" | "structuredOutput" | "session" | "cancellation";
  cap: "tools" | "structuredOutput" | "sessions" | "cancellation";
  rejection: CapabilityRejection;
}[] = [
  { req: "tools", cap: "tools", rejection: { reason: "unsupported-tools" } },
  {
    req: "structuredOutput",
    cap: "structuredOutput",
    rejection: { reason: "unsupported-structured-output" },
  },
  { req: "session", cap: "sessions", rejection: { reason: "unsupported-session" } },
  { req: "cancellation", cap: "cancellation", rejection: { reason: "unsupported-cancellation" } },
];

function checkShapeCapabilities(
  required: RequiredFeatures,
  capabilities: RouteCapabilities,
): CapabilityRejection | null {
  if (!capabilities.operations.includes(required.operation)) {
    return { reason: "unsupported-operation", operation: required.operation };
  }
  if (required.operation === "count-tokens" && !capabilities.tokenCounting) {
    return { reason: "unsupported-token-counting" };
  }
  if (!capabilities.protocols.includes(required.protocol)) {
    return { reason: "unsupported-protocol", protocol: required.protocol };
  }
  if (required.stream && capabilities.streaming === "none") {
    return { reason: "unsupported-streaming", requested: "sse", offered: capabilities.streaming };
  }
  for (const modality of required.modalities) {
    if (!capabilities.modalities.includes(modality)) {
      return { reason: "unsupported-modality", modality };
    }
  }
  return null;
}

export function checkRouteCapabilities(
  required: RequiredFeatures,
  capabilities: RouteCapabilities,
): CapabilityRejection | null {
  const shape = checkShapeCapabilities(required, capabilities);
  if (shape !== null) return shape;
  for (const flag of FLAG_REJECTIONS) {
    if (required[flag.req] && !capabilities[flag.cap]) return flag.rejection;
  }
  return null;
}

export function filterCandidatesByCapabilities<C>(
  required: RequiredFeatures,
  candidates: readonly C[],
  capabilities: (candidate: C) => RouteCapabilities,
): {
  eligible: C[];
  rejected: { candidate: C; rejection: CapabilityRejection }[];
} {
  const eligible: C[] = [];
  const rejected: { candidate: C; rejection: CapabilityRejection }[] = [];
  for (const candidate of candidates) {
    const rejection = checkRouteCapabilities(required, capabilities(candidate));
    if (rejection === null) eligible.push(candidate);
    else rejected.push({ candidate, rejection });
  }
  return { eligible, rejected };
}
