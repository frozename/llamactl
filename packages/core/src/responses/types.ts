/**
 * Type definitions for the OpenAI Responses API (/v1/responses).
 * The Responses API is OpenAI's newer chat interface used by codex-* seats.
 * These types cover the subset we translate to/from chat-completions.
 */

export interface ResponsesInputText {
  type: "input_text";
  text: string;
}

export interface ResponsesOutputText {
  type: "output_text";
  text: string;
}

export type ResponsesContentPart = ResponsesInputText | ResponsesOutputText;

export interface ResponsesInputMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesContentPart[];
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesToolFunction {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesTool = ResponsesToolFunction;

export type ResponsesToolChoice = "auto" | "required" | "none" | { type: "function"; name: string };

export interface ResponsesApiRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  previous_response_id?: string;
  stop?: string[];
  seed?: number;
}

export interface ResponsesOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: ResponsesOutputText[];
}

export interface ResponsesFunctionCallOutput {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCallOutput;

export interface ResponsesApiResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress";
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export class ResponsesTranslationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ResponsesTranslationError";
    this.statusCode = statusCode;
  }
}
