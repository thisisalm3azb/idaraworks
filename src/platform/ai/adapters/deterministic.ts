/**
 * H28 — the deterministic test provider (non-production only, ADR-50/63).
 *
 * Scripted responses computed inside the platform. It never makes a network
 * call and its answers are labelled as test output by the callers. Behaviour
 * markers inside the LAST user message let tests and evaluations drive
 * failure paths without any real provider:
 *
 *   [[fail:timeout]]     the call hangs until aborted
 *   [[fail:rate_limit]]  a retryable 429-style error
 *   [[fail:server]]      a retryable 500-style error
 *   [[fail:auth]]        a non-retryable auth error
 *   [[fail:invalid]]     malformed output (validators must catch it)
 *   [[fabricate]]        a citation to a record that was never consulted
 *   [[call:<tool>:<json>]] a tool call with the given input
 *   [[no_evidence]]      the honest "not enough evidence" answer
 *
 * Tests may also install a script with setDeterministicScript().
 */
import {
  AdapterError,
  type AiAdapter,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayUsage,
} from "./types";

export type DeterministicScript = (
  req: GatewayRequest,
) => GatewayResponse | Promise<GatewayResponse>;

let installed: DeterministicScript | null = null;

export function setDeterministicScript(script: DeterministicScript | null): void {
  installed = script;
}

function lastUserText(req: GatewayRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === "user") return m.content;
  }
  return "";
}

export function deterministicUsage(req: GatewayRequest, outputChars: number): GatewayUsage {
  const inputChars =
    req.system.length +
    req.blocks.reduce((n, b) => n + b.content.length, 0) +
    req.messages.reduce((n, m) => n + m.content.length, 0);
  return {
    input: Math.ceil(inputChars / 4),
    output: Math.ceil(outputChars / 4),
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

function defaultAnswer(req: GatewayRequest): GatewayResponse {
  const text = lastUserText(req);
  const first = req.blocks[0]?.records[0] ?? null;
  const call = /\[\[call:([a-z0-9_.]+):(\{.*?\})\]\]/i.exec(text);
  if (call) {
    let input: unknown = {};
    try {
      input = JSON.parse(call[2]!);
    } catch {
      input = {};
    }
    const out = { id: `call_${Math.random().toString(36).slice(2, 10)}`, name: call[1]!, input };
    return {
      content: [{ kind: "tool_call", ...out }],
      usage: deterministicUsage(req, 40),
      providerRequestId: `det_${req.correlationId.slice(0, 8)}`,
      modelVersion: req.model.providerModelId,
      finishReason: "tool_calls",
    };
  }
  if (req.responseSchema) {
    const value: Record<string, unknown> = {
      facts: first ? [`Consulted ${first.type} ${first.id}.`] : [],
      calculations: [],
      assumptions: [],
      suggestions: text.includes("[[no_evidence]]")
        ? []
        : ["Review the cited records before acting."],
      citations: first ? [{ type: first.type, id: first.id }] : [],
      confidence: first ? "medium" : "low",
      uncertainty: first
        ? "Test provider: the answer is scripted."
        : "Not enough evidence in the consulted records.",
      proposedActions: [],
      kind: "answer",
    };
    if (text.includes("[[fabricate]]"))
      value.citations = [{ type: "invoice", id: "00000000-0000-0000-0000-000000000000" }];
    if (text.includes("[[fail:invalid]]")) return jsonResponse(req, { nonsense: true });
    return jsonResponse(req, value);
  }
  const answer = text.includes("[[no_evidence]]")
    ? "I do not have enough evidence in the consulted records to answer that."
    : `Deterministic test answer${first ? ` grounded in ${first.type} ${first.id}` : ""}.`;
  return {
    content: [{ kind: "text", text: answer }],
    usage: deterministicUsage(req, answer.length),
    providerRequestId: `det_${req.correlationId.slice(0, 8)}`,
    modelVersion: req.model.providerModelId,
    finishReason: "stop",
  };
}

function jsonResponse(req: GatewayRequest, value: unknown): GatewayResponse {
  const encoded = JSON.stringify(value);
  return {
    content: [{ kind: "json", value }],
    usage: deterministicUsage(req, encoded.length),
    providerRequestId: `det_${req.correlationId.slice(0, 8)}`,
    modelVersion: req.model.providerModelId,
    finishReason: "stop",
  };
}

export const deterministicAdapter: AiAdapter = {
  key: "deterministic",
  complete: async (req, opts) => {
    const text = lastUserText(req);
    if (text.includes("[[fail:timeout]]")) {
      await new Promise<never>((_, reject) => {
        opts.signal.addEventListener(
          "abort",
          () => reject(new AdapterError("timeout", "aborted")),
          { once: true },
        );
      });
    }
    if (text.includes("[[fail:rate_limit]]"))
      throw new AdapterError("rate_limit", "rate limited", { status: 429 });
    if (text.includes("[[fail:server]]"))
      throw new AdapterError("server", "server error", { status: 500 });
    if (text.includes("[[fail:auth]]"))
      throw new AdapterError("auth", "unauthorised", { status: 401, retryable: false });
    if (installed) return installed(req);
    return defaultAnswer(req);
  },
};
