/**
 * H28 — Anthropic adapter over the Messages API (fetch only, no SDK).
 *
 * Facts used (docs/H28-TRUTH-MAP.md C.2/C.3, fetched 2026-09-03): tools with
 * `input_schema`, `output_config.format = json_schema`, usage fields
 * `input_tokens` (after the last cache breakpoint), `output_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`, request id header
 * `request-id`. The adapter only ever talks to api.anthropic.com. It is
 * contract-tested with a fake fetch and is unverified against the live
 * endpoint until credentials exist.
 */
import { AI_PROVIDERS } from "../registry";
import {
  AdapterError,
  renderBlocks,
  type AdapterCallOptions,
  type AiAdapter,
  type GatewayContent,
  type GatewayRequest,
  type GatewayResponse,
} from "./types";

const HOST = AI_PROVIDERS.anthropic.host!;
const URL_MESSAGES = `https://${HOST}/v1/messages`;
const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export function buildAnthropicBody(req: GatewayRequest): Record<string, unknown> {
  const messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const push = (role: "user" | "assistant", block: AnthropicBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  const context = renderBlocks(req.blocks);
  if (context) push("user", { type: "text", text: context });
  for (const m of req.messages) {
    if (m.role === "user") push("user", { type: "text", text: m.content });
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? [])
        push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
    } else push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
  }
  if (messages.length === 0 || messages[0]!.role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(no input)" }] });
  }
  const body: Record<string, unknown> = {
    model: req.model.providerModelId,
    system: req.system,
    messages,
    max_tokens: req.maxOutputTokens,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      strict: true,
    }));
  }
  if (req.responseSchema) {
    body.output_config = { format: { type: "json_schema", schema: req.responseSchema.schema } };
  }
  return body;
}

export function parseAnthropicResponse(
  json: unknown,
  requestId: string | null,
  wantJson: boolean,
): GatewayResponse {
  const r = json as {
    id?: string;
    model?: string;
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  if (!r || !Array.isArray(r.content))
    throw new AdapterError("invalid_response", "malformed provider response", {
      retryable: false,
      providerRequestId: requestId,
    });
  const content: GatewayContent[] = [];
  let sawToolCall = false;
  let text = "";
  for (const item of r.content) {
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    else if (item.type === "tool_use") {
      sawToolCall = true;
      content.push({
        kind: "tool_call",
        id: item.id ?? `toolu_${content.length}`,
        name: item.name ?? "",
        input: item.input ?? {},
      });
    }
  }
  if (text) {
    if (wantJson) {
      try {
        content.unshift({ kind: "json", value: JSON.parse(text) });
      } catch {
        throw new AdapterError(
          "invalid_response",
          "provider returned non-JSON for a JSON schema request",
          { retryable: false, providerRequestId: requestId },
        );
      }
    } else content.unshift({ kind: "text", text });
  }
  const u = r.usage ?? {};
  return {
    content,
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      reasoning: 0,
    },
    providerRequestId: requestId ?? r.id ?? null,
    modelVersion: r.model ?? null,
    finishReason:
      sawToolCall || r.stop_reason === "tool_use"
        ? "tool_calls"
        : r.stop_reason === "max_tokens"
          ? "length"
          : r.stop_reason === "end_turn"
            ? "stop"
            : "other",
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const anthropicAdapter: AiAdapter = {
  key: "anthropic",
  complete: async (req: GatewayRequest, opts: AdapterCallOptions): Promise<GatewayResponse> => {
    if (!opts.apiKey)
      throw new AdapterError("auth", "no Anthropic credential configured", { retryable: false });
    const fetchImpl = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(URL_MESSAGES, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildAnthropicBody(req)),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal.aborted) throw new AdapterError("timeout", "request aborted");
      throw new AdapterError("network", (e as Error).message);
    }
    const requestId = res.headers.get("request-id");
    if (res.status === 401 || res.status === 403)
      throw new AdapterError("auth", await readError(res), {
        status: res.status,
        retryable: false,
        providerRequestId: requestId,
      });
    if (res.status === 429)
      throw new AdapterError("rate_limit", await readError(res), {
        status: 429,
        providerRequestId: requestId,
      });
    if (res.status === 413)
      throw new AdapterError("content_too_large", await readError(res), {
        status: 413,
        retryable: false,
        providerRequestId: requestId,
      });
    if (res.status === 529 || res.status >= 500)
      throw new AdapterError("server", await readError(res), {
        status: res.status,
        providerRequestId: requestId,
      });
    if (!res.ok)
      throw new AdapterError("invalid_response", await readError(res), {
        status: res.status,
        retryable: false,
        providerRequestId: requestId,
      });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError("invalid_response", "non-JSON provider response", {
        retryable: false,
        providerRequestId: requestId,
      });
    }
    return parseAnthropicResponse(json, requestId, Boolean(req.responseSchema));
  },
};
