/**
 * H28 — the ONE gateway request and response shape every adapter speaks
 * (ADR-50). Domain code never sees a provider format.
 */
import type { AiModelDef, AiProviderKey } from "../registry";

/** A provenance-labelled block of UNTRUSTED business data (JSON-encoded by the caller). */
export type GatewayBlock = {
  source: string;
  records: readonly { type: string; id: string }[];
  retrievedAt: string;
  content: string;
};

export type GatewayToolDef = {
  name: string;
  description: string;
  /** JSON schema for the tool input (strict: additionalProperties false). */
  inputSchema: Record<string, unknown>;
};

export type GatewayMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: readonly { id: string; name: string; input: unknown }[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type GatewayRequest = {
  correlationId: string;
  model: AiModelDef;
  /** Trusted, secret-free system contract. */
  system: string;
  blocks: readonly GatewayBlock[];
  messages: readonly GatewayMessage[];
  tools?: readonly GatewayToolDef[];
  /** When set the adapter asks for a schema-constrained JSON answer. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  temperature?: number;
  /** Purpose label for scripted test providers and logs (never sent to real providers). */
  purpose?: string;
};

export type GatewayContent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "json"; value: unknown };

export type GatewayUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export const ZERO_USAGE: GatewayUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

export type GatewayResponse = {
  content: GatewayContent[];
  usage: GatewayUsage;
  providerRequestId: string | null;
  modelVersion: string | null;
  finishReason: "stop" | "tool_calls" | "length" | "other";
};

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: GatewayUsage }
  | { type: "done"; response: GatewayResponse }
  | { type: "error"; message: string };

export type AdapterErrorKind =
  | "disabled"
  | "auth"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "invalid_response"
  | "content_too_large";

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly providerRequestId: string | null;
  constructor(
    kind: AdapterErrorKind,
    message: string,
    opts: { retryable?: boolean; status?: number | null; providerRequestId?: string | null } = {},
  ) {
    super(message);
    this.kind = kind;
    this.retryable =
      opts.retryable ??
      (kind === "rate_limit" || kind === "server" || kind === "network" || kind === "timeout");
    this.status = opts.status ?? null;
    this.providerRequestId = opts.providerRequestId ?? null;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AdapterCallOptions = {
  signal: AbortSignal;
  apiKey: string | null;
  /** Injected in tests; production uses global fetch restricted to the provider host. */
  fetchImpl?: FetchLike;
  /** Forwarded as the client request id where the provider supports one. */
  clientRequestId?: string;
};

export interface AiAdapter {
  readonly key: AiProviderKey;
  complete(req: GatewayRequest, opts: AdapterCallOptions): Promise<GatewayResponse>;
  stream?(req: GatewayRequest, opts: AdapterCallOptions): AsyncIterable<StreamEvent>;
}

/** Text rendering of the untrusted blocks: boundary-labelled, JSON-encoded, never instructions. */
export function renderBlocks(blocks: readonly GatewayBlock[]): string {
  if (blocks.length === 0) return "";
  return blocks
    .map(
      (b) =>
        `<<UNTRUSTED-DATA source=${b.source} retrieved=${b.retrievedAt} records=${b.records.length}>>\n${b.content}\n<<END-UNTRUSTED-DATA>>`,
    )
    .join("\n\n");
}

/** Approximate token count used only for size limits (4 characters per token). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
