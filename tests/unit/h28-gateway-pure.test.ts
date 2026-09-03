/**
 * H28A — the gateway's pure laws: price arithmetic rounds up per category and
 * never invents a rate; the budget decision follows the documented order; the
 * OpenAI and Anthropic adapters translate the one gateway shape faithfully,
 * map every failure class and never leak a key; the deterministic provider
 * drives failure paths without a network.
 */
import { describe, expect, it } from "vitest";
import {
  buildAnthropicBody,
  anthropicAdapter,
  parseAnthropicResponse,
} from "@/platform/ai/adapters/anthropic";
import { buildOpenAiBody, openaiAdapter, parseOpenAiResponse } from "@/platform/ai/adapters/openai";
import { deterministicAdapter } from "@/platform/ai/adapters/deterministic";
import { AdapterError, renderBlocks, type GatewayRequest } from "@/platform/ai/adapters/types";
import {
  decideBudget,
  DEFAULT_POLICY,
  type AllowanceStatus,
  type BudgetFacts,
} from "@/platform/ai/budget";
import { creditsForUsdMicros, estimateCostMicros, type PriceRow } from "@/platform/ai/pricebook";
import {
  AI_MODELS,
  AI_PROVIDERS,
  AI_MODEL_KEYS,
  isAiModelKey,
  TASK_TIER,
} from "@/platform/ai/registry";

const price: PriceRow = {
  id: "p1",
  providerKey: "openai",
  modelKey: "openai:gpt-5-nano",
  effectiveFrom: "2026-09-03",
  effectiveTo: null,
  currency: "USD",
  inputPerMtokMicros: 50_000n,
  outputPerMtokMicros: 400_000n,
  cacheReadPerMtokMicros: 5_000n,
  cacheWritePerMtokMicros: null,
  reasoningPerMtokMicros: null,
  version: 1,
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
};

describe("H28A — price book arithmetic", () => {
  it("prices exactly at 1M tokens and rounds every category up, never to free", () => {
    expect(
      estimateCostMicros(price, {
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ).toBe(50_000n);
    expect(
      estimateCostMicros(price, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    ).toBe(1n);
    expect(
      estimateCostMicros(price, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    ).toBe(1n);
    expect(
      estimateCostMicros(price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    ).toBe(0n);
  });
  it("uses the input price for cache writes and the output price for reasoning when unpriced", () => {
    expect(
      estimateCostMicros(price, {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ).toBe(5_000n);
    expect(
      estimateCostMicros(price, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1_000_000,
        reasoning: 0,
      }),
    ).toBe(50_000n);
    expect(
      estimateCostMicros(price, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 1_000_000,
      }),
    ).toBe(400_000n);
  });
  it("credits: one credit per cent at ratio 1, cents rounded up, ratio applied", () => {
    const policy = { id: "c", effectiveFrom: "2026-09-03", creditsPerUsdCent: 1 };
    expect(creditsForUsdMicros(0n, policy)).toBe(0);
    expect(creditsForUsdMicros(1n, policy)).toBe(1);
    expect(creditsForUsdMicros(10_000n, policy)).toBe(1);
    expect(creditsForUsdMicros(10_001n, policy)).toBe(2);
    expect(creditsForUsdMicros(1_000_000n, { ...policy, creditsPerUsdCent: 2.5 })).toBe(250);
  });
  it("the registry seeds only priced models as routable facts: every model has a provider, tier and source rule", () => {
    for (const key of AI_MODEL_KEYS) {
      const m = AI_MODELS[key];
      expect(isAiModelKey(m.key)).toBe(true);
      expect(AI_PROVIDERS[m.provider]).toBeDefined();
      expect(m.contextTokens).toBeGreaterThan(m.maxOutputTokens);
      if (AI_PROVIDERS[m.provider].kind === "external") expect(m.sourceUrl).toMatch(/^https:\/\//);
    }
    expect(TASK_TIER.analyse).toBe("strong");
    expect(TASK_TIER.classify).toBe("small");
  });
});

const allowance: AllowanceStatus = {
  periodKey: "2026-09",
  planCredits: 100,
  ledgerCredits: 0,
  allowance: 100,
  consumed: 10,
  remaining: 90,
  usedPct: 10,
  todayOrg: 5,
  todayUser: 2,
  monthByAgent: { finance: 8 },
};

function facts(over: Partial<BudgetFacts> = {}): BudgetFacts {
  return {
    switches: {
      globalStop: false,
      orgStop: false,
      agentStop: false,
      providerStop: false,
      modelStop: false,
    },
    providerEnabled: true,
    modelEnabled: true,
    breakerOpen: false,
    policy: { ...DEFAULT_POLICY, mode: "included" },
    agentEnabled: true,
    agentDomain: "finance",
    modelKey: "openai:gpt-5-nano",
    allowance,
    agentId: "finance",
    estimatedCredits: 3,
    platformDailySpendMicros: 0n,
    platformDailyCapMicros: 1_000_000n,
    ...over,
  };
}

describe("H28A — budget decision order", () => {
  it("allows a normal request", () => {
    expect(decideBudget(facts())).toEqual({ decision: "allow", reason: "ok" });
  });
  it("the global stop wins over everything", () => {
    expect(
      decideBudget(
        facts({
          switches: {
            globalStop: true,
            orgStop: true,
            agentStop: true,
            providerStop: true,
            modelStop: true,
          },
        }),
      ).reason,
    ).toBe("global_stop");
  });
  it("switches precede provider state, provider state precedes the breaker, the breaker precedes policy", () => {
    expect(
      decideBudget(
        facts({ switches: { ...facts().switches, providerStop: true }, providerEnabled: false }),
      ).reason,
    ).toBe("provider_stop");
    expect(decideBudget(facts({ providerEnabled: false, breakerOpen: true })).reason).toBe(
      "provider_disabled",
    );
    expect(decideBudget(facts({ breakerOpen: true, policy: { ...DEFAULT_POLICY } })).reason).toBe(
      "breaker_open",
    );
    expect(decideBudget(facts({ policy: { ...DEFAULT_POLICY } })).reason).toBe("org_mode_disabled");
    expect(
      decideBudget(
        facts({ policy: { ...DEFAULT_POLICY, mode: "included", aiEnabledByOrg: false } }),
      ).reason,
    ).toBe("org_ai_disabled");
  });
  it("agent, domain, model and per-request caps", () => {
    expect(decideBudget(facts({ agentEnabled: false })).reason).toBe("agent_disabled");
    expect(
      decideBudget(facts({ policy: { ...facts().policy, restrictedDomains: ["finance"] } })).reason,
    ).toBe("domain_restricted");
    expect(
      decideBudget(
        facts({ policy: { ...facts().policy, modelAllow: ["anthropic:claude-haiku-4-5"] } }),
      ).reason,
    ).toBe("model_not_allowed");
    expect(
      decideBudget(facts({ policy: { ...facts().policy, maxCostPerRequestCredits: 2 } })).reason,
    ).toBe("request_cost_cap");
  });
  it("daily, per-user and per-agent limits count the estimate", () => {
    expect(decideBudget(facts({ policy: { ...facts().policy, dailyCreditLimit: 7 } })).reason).toBe(
      "daily_limit",
    );
    expect(
      decideBudget(facts({ policy: { ...facts().policy, dailyCreditLimit: 8 } })).decision,
    ).toBe("allow");
    expect(
      decideBudget(facts({ policy: { ...facts().policy, perUserDailyCredits: 4 } })).reason,
    ).toBe("user_daily_limit");
    expect(
      decideBudget(facts({ policy: { ...facts().policy, perAgentLimits: { finance: 10 } } }))
        .reason,
    ).toBe("agent_limit");
  });
  it("allowance: soft warning at the threshold, hard stop when exhausted unless overage is allowed", () => {
    expect(decideBudget(facts({ allowance: { ...allowance, consumed: 78 } })).reason).toBe(
      "soft_warning",
    );
    expect(decideBudget(facts({ allowance: { ...allowance, consumed: 98 } })).reason).toBe(
      "allowance_exhausted",
    );
    expect(decideBudget(facts({ allowance: { ...allowance, consumed: 98 } })).decision).toBe(
      "deny",
    );
    expect(
      decideBudget(
        facts({
          allowance: { ...allowance, consumed: 98 },
          policy: { ...facts().policy, overageAllowed: true },
        }),
      ).decision,
    ).toBe("warn");
    expect(
      decideBudget(
        facts({ allowance: { ...allowance, allowance: null, remaining: null, usedPct: null } }),
      ).decision,
    ).toBe("allow");
  });
  it("the platform daily breaker stops paid calls", () => {
    expect(decideBudget(facts({ platformDailySpendMicros: 1_000_000n })).reason).toBe(
      "platform_breaker",
    );
  });
});

const baseRequest: GatewayRequest = {
  correlationId: "corr-1",
  model: AI_MODELS["openai:gpt-5-nano"],
  system: "You are a test.",
  blocks: [
    {
      source: "read.customer",
      records: [{ type: "customer", id: "c1" }],
      retrievedAt: "2026-09-03T00:00:00Z",
      content: JSON.stringify({ name: "ACME" }),
    },
  ],
  messages: [{ role: "user", content: "Summarise ACME" }],
  tools: [
    {
      name: "read_customer",
      description: "read",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ],
  responseSchema: {
    name: "answer",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  maxOutputTokens: 500,
};

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fn, calls };
}

describe("H28A — OpenAI adapter contract", () => {
  it("builds a Responses body with strict tools, a JSON schema format and labelled untrusted context", () => {
    const body = buildOpenAiBody(baseRequest) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5-nano");
    expect(body.instructions).toBe("You are a test.");
    expect(body.store).toBe(false);
    const input = body.input as Array<Record<string, unknown>>;
    expect(String(input[0]!.content)).toContain("<<UNTRUSTED-DATA source=read.customer");
    expect(input[1]).toEqual({ role: "user", content: "Summarise ACME" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "function", name: "read_customer", strict: true });
    expect((body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
  });
  it("round-trips tool calls and tool results in the input items", () => {
    const req: GatewayRequest = {
      ...baseRequest,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_customer", input: { id: "c1" } }],
        },
        { role: "tool", toolCallId: "call_1", name: "read_customer", content: '{"ok":true}' },
      ],
    };
    const input = (buildOpenAiBody(req) as { input: Array<Record<string, unknown>> }).input;
    expect(input.some((i) => i.type === "function_call" && i.call_id === "call_1")).toBe(true);
    expect(input.some((i) => i.type === "function_call_output" && i.call_id === "call_1")).toBe(
      true,
    );
  });
  it("parses usage categories, request ids, JSON output and tool calls", () => {
    const r = parseOpenAiResponse(
      {
        id: "resp_1",
        model: "gpt-5-nano-2026",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: '{"text":"hi"}' }] },
          {
            type: "function_call",
            call_id: "call_9",
            name: "read_customer",
            arguments: '{"id":"c1"}',
          },
        ],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
      "req_abc",
      true,
    );
    expect(r.usage).toEqual({ input: 120, output: 30, cacheRead: 20, cacheWrite: 0, reasoning: 5 });
    expect(r.providerRequestId).toBe("req_abc");
    expect(r.modelVersion).toBe("gpt-5-nano-2026");
    expect(r.content[0]).toEqual({ kind: "json", value: { text: "hi" } });
    expect(r.content[1]).toMatchObject({
      kind: "tool_call",
      id: "call_9",
      name: "read_customer",
      input: { id: "c1" },
    });
    expect(r.finishReason).toBe("tool_calls");
  });
  it("maps 401 to a non-retryable auth error, 429 and 5xx to retryable errors, and never sends without a key", async () => {
    await expect(
      openaiAdapter.complete(baseRequest, { signal: new AbortController().signal, apiKey: null }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    for (const [status, kind, retryable] of [
      [401, "auth", false],
      [429, "rate_limit", true],
      [500, "server", true],
      [503, "server", true],
      [413, "content_too_large", false],
    ] as const) {
      const f = fakeFetch(status, { error: { message: "x" } }, { "x-request-id": "rq" });
      const err = await openaiAdapter
        .complete(baseRequest, {
          signal: new AbortController().signal,
          apiKey: "sk-test",
          fetchImpl: f.fn,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect(err.kind).toBe(kind);
      expect(err.retryable).toBe(retryable);
      expect(err.providerRequestId).toBe("rq");
    }
  });
  it("talks only to api.openai.com, sends the bearer key in a header and the client request id, and treats malformed JSON as invalid", async () => {
    const f = fakeFetch(200, { output: "nope" });
    await expect(
      openaiAdapter.complete(baseRequest, {
        signal: new AbortController().signal,
        apiKey: "sk-test",
        fetchImpl: f.fn,
        clientRequestId: "idem-1",
      }),
    ).rejects.toMatchObject({ kind: "invalid_response", retryable: false });
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["x-client-request-id"]).toBe("idem-1");
    expect(String(f.calls[0]!.init.body)).not.toContain("sk-test");
  });
});

describe("H28A — Anthropic adapter contract", () => {
  it("builds a Messages body with tools, output_config json_schema, system and alternating roles", () => {
    const body = buildAnthropicBody({
      ...baseRequest,
      model: AI_MODELS["anthropic:claude-haiku-4-5"],
    }) as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0]!.role).toBe("user");
    expect(String(messages[0]!.content[0]!.text)).toContain("<<UNTRUSTED-DATA");
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "read_customer",
      strict: true,
    });
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(body.max_tokens).toBe(500);
  });
  it("parses cache categories, tool use and stop reasons", () => {
    const r = parseAnthropicResponse(
      {
        id: "msg_1",
        model: "claude-haiku-4-5-20251001",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: '{"text":"ok"}' },
          { type: "tool_use", id: "toolu_1", name: "read_customer", input: { id: "c1" } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 3,
        },
      },
      "req-1",
      true,
    );
    expect(r.usage).toEqual({ input: 10, output: 4, cacheRead: 3, cacheWrite: 7, reasoning: 0 });
    expect(r.content[0]).toEqual({ kind: "json", value: { text: "ok" } });
    expect(r.content[1]).toMatchObject({ kind: "tool_call", id: "toolu_1" });
    expect(r.finishReason).toBe("tool_calls");
    expect(
      parseAnthropicResponse(
        { content: [{ type: "text", text: "hi" }], stop_reason: "max_tokens", usage: {} },
        null,
        false,
      ).finishReason,
    ).toBe("length");
  });
  it("maps errors, sends the key only as x-api-key, and only to api.anthropic.com", async () => {
    const f = fakeFetch(529, { error: { message: "overloaded" } }, { "request-id": "r529" });
    const err = await anthropicAdapter
      .complete(baseRequest, {
        signal: new AbortController().signal,
        apiKey: "ak-test",
        fetchImpl: f.fn,
      })
      .catch((e) => e);
    expect(err.kind).toBe("server");
    expect(err.retryable).toBe(true);
    expect(err.providerRequestId).toBe("r529");
    expect(f.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(String(f.calls[0]!.init.body)).not.toContain("ak-test");
    await expect(
      anthropicAdapter.complete(baseRequest, {
        signal: new AbortController().signal,
        apiKey: null,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("H28A — deterministic provider markers", () => {
  const req = (text: string): GatewayRequest => ({
    ...baseRequest,
    model: AI_MODELS["deterministic:fast"],
    messages: [{ role: "user", content: text }],
  });
  it("answers with a citation to a consulted record by default and admits missing evidence", async () => {
    const r = await deterministicAdapter.complete(req("hello"), {
      signal: new AbortController().signal,
      apiKey: null,
    });
    expect(r.content[0]!.kind).toBe("json");
    const v = (r.content[0] as { value: { citations: Array<{ id: string }> } }).value;
    expect(v.citations[0]!.id).toBe("c1");
    const none = await deterministicAdapter.complete(
      { ...req("[[no_evidence]]"), responseSchema: undefined },
      { signal: new AbortController().signal, apiKey: null },
    );
    expect((none.content[0] as { text: string }).text).toMatch(/not have enough evidence/);
  });
  it("drives failure classes and tool calls", async () => {
    const opts = { signal: new AbortController().signal, apiKey: null };
    await expect(
      deterministicAdapter.complete(req("[[fail:rate_limit]]"), opts),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    await expect(deterministicAdapter.complete(req("[[fail:auth]]"), opts)).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
    });
    const call = await deterministicAdapter.complete(
      req('[[call:read_customer:{"id":"c1"}]]'),
      opts,
    );
    expect(call.content[0]).toMatchObject({
      kind: "tool_call",
      name: "read_customer",
      input: { id: "c1" },
    });
    const ac = new AbortController();
    const hang = deterministicAdapter.complete(req("[[fail:timeout]]"), {
      signal: ac.signal,
      apiKey: null,
    });
    ac.abort();
    await expect(hang).rejects.toMatchObject({ kind: "timeout" });
  });
  it("renders blocks with boundaries and counts", () => {
    const text = renderBlocks(baseRequest.blocks);
    expect(text).toContain("records=1");
    expect(text).toContain("<<END-UNTRUSTED-DATA>>");
  });
});
