/**
 * H28 — OpenAI adapter over the Responses API (fetch only, no SDK).
 *
 * Facts used (docs/H28-TRUTH-MAP.md C.2/C.3, fetched 2026-09-03): function
 * tools with strict JSON schema, `text.format = json_schema`, usage fields
 * `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`,
 * `output_tokens_details.reasoning_tokens`, request id header `x-request-id`,
 * optional client header `X-Client-Request-Id`. The adapter only ever talks
 * to api.openai.com. It is contract-tested with a fake fetch and is unverified
 * against the live endpoint until credentials exist.
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

const HOST = AI_PROVIDERS.openai.host!;
const URL_RESPONSES = `https://${HOST}/v1/responses`;

type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export function buildOpenAiBody(req: GatewayRequest): Record<string, unknown> {
  const input: ResponsesInputItem[] = [];
  const context = renderBlocks(req.blocks);
  if (context) input.push({ role: "user", content: context });
  for (const m of req.messages) {
    if (m.role === "user") input.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input ?? {}),
        });
      }
    } else input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  const body: Record<string, unknown> = {
    model: req.model.providerModelId,
    instructions: req.system,
    input,
    max_output_tokens: req.maxOutputTokens,
    store: false,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: true,
    }));
  }
  if (req.responseSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: req.responseSchema.name,
        schema: req.responseSchema.schema,
        strict: true,
      },
    };
  }
  return body;
}

export function parseOpenAiResponse(
  json: unknown,
  requestId: string | null,
  wantJson: boolean,
): GatewayResponse {
  const r = json as {
    id?: string;
    model?: string;
    status?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens?: number;
      output_tokens_details?: { reasoning_tokens?: number };
    };
    incomplete_details?: { reason?: string };
  };
  if (!r || !Array.isArray(r.output))
    throw new AdapterError("invalid_response", "malformed provider response", {
      retryable: false,
      providerRequestId: requestId,
    });
  const content: GatewayContent[] = [];
  let sawToolCall = false;
  for (const item of r.output) {
    if (item.type === "message") {
      const text = (item.content ?? [])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("");
      if (text) {
        if (wantJson) {
          try {
            content.push({ kind: "json", value: JSON.parse(text) });
          } catch {
            throw new AdapterError(
              "invalid_response",
              "provider returned non-JSON for a JSON schema request",
              { retryable: false, providerRequestId: requestId },
            );
          }
        } else content.push({ kind: "text", text });
      }
    } else if (item.type === "function_call") {
      sawToolCall = true;
      let input: unknown = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        throw new AdapterError("invalid_response", "malformed tool arguments", {
          retryable: false,
          providerRequestId: requestId,
        });
      }
      content.push({
        kind: "tool_call",
        id: item.call_id ?? `call_${content.length}`,
        name: item.name ?? "",
        input,
      });
    }
  }
  const u = r.usage ?? {};
  return {
    content,
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
    providerRequestId: requestId ?? r.id ?? null,
    modelVersion: r.model ?? null,
    finishReason: sawToolCall
      ? "tool_calls"
      : r.status === "incomplete"
        ? "length"
        : r.status === "completed"
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

export const openaiAdapter: AiAdapter = {
  key: "openai",
  complete: async (req: GatewayRequest, opts: AdapterCallOptions): Promise<GatewayResponse> => {
    if (!opts.apiKey)
      throw new AdapterError("auth", "no OpenAI credential configured", { retryable: false });
    const fetchImpl = opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    };
    if (opts.clientRequestId) headers["x-client-request-id"] = opts.clientRequestId.slice(0, 512);
    let res: Response;
    try {
      res = await fetchImpl(URL_RESPONSES, {
        method: "POST",
        headers,
        body: JSON.stringify(buildOpenAiBody(req)),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal.aborted) throw new AdapterError("timeout", "request aborted");
      throw new AdapterError("network", (e as Error).message);
    }
    const requestId = res.headers.get("x-request-id");
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
    if (res.status >= 500)
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
    return parseOpenAiResponse(json, requestId, Boolean(req.responseSchema));
  },
};
