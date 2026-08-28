/**
 * The ONE provider seam (H12 / A1). Every future model call passes through
 * AgentProvider.complete via callProvider — feature code never talks to a
 * model SDK directly (no SDK exists in this repository; adding one lands
 * HERE, behind this interface, in a later micro-step).
 *
 * A1 ships no external provider and no API key. getAgentProvider() returns
 * the DisabledAgentProvider, which fails closed. DeterministicTestProvider
 * exists for the security harness only.
 *
 * callProvider adds the safety envelope the contract requires: a hard
 * timeout, cooperative cancellation (AbortSignal), the correlation ID, and
 * error mapping that never leaks internals.
 */
import type { AgentId, AgentToolId } from "./registry";

/** A block of UNTRUSTED business data. Content inside it is data, never
 * instructions — the assembly in context.ts wraps and labels it. */
export type UntrustedBlock = {
  source: AgentToolId;
  /** Record references consulted by the tool (citation ground truth). */
  records: readonly { type: string; id: string }[];
  /** Sanitized, boundary-labelled content. */
  content: string;
};

export type ProviderRequest = {
  agentId: AgentId;
  correlationId: string;
  locale: "en" | "ar";
  /** Trusted, secret-free system contract (built by context.ts). */
  system: string;
  /** Untrusted business data blocks. */
  context: readonly UntrustedBlock[];
  /** The user's request text (untrusted). */
  input: string;
  /** Informational: which tools ran. The provider CANNOT request tools —
   * A1 has no model-directed tool channel at all. */
  consultedToolIds: readonly AgentToolId[];
};

export type ProviderResponse = { output: unknown };

export interface AgentProvider {
  readonly name: string;
  complete(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResponse>;
}

export class AgentProviderDisabledError extends Error {
  constructor() {
    super("agent provider disabled: no production model provider is configured");
  }
}
export class AgentProviderTimeoutError extends Error {
  constructor(ms: number) {
    super(`agent provider timed out after ${ms}ms`);
  }
}

/** The default: fails closed. No key, no network, no model. */
export const DisabledAgentProvider: AgentProvider = {
  name: "disabled",
  complete: async () => {
    throw new AgentProviderDisabledError();
  },
};

/** Test-only deterministic provider: returns what the harness scripts. */
export function DeterministicTestProvider(
  fn: (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
): AgentProvider {
  return { name: "deterministic-test", complete: async (req) => fn(req) };
}

/** The single production accessor. A later micro-step may return a real
 * provider here — behind the entitlement gate and this same envelope. */
export function getAgentProvider(): AgentProvider {
  return DisabledAgentProvider;
}

export const PROVIDER_TIMEOUT_MS = 30_000;

/** The one call site: timeout + cancellation + safe error mapping. */
export async function callProvider(
  provider: AgentProvider,
  req: ProviderRequest,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ProviderResponse> {
  const timeoutMs = opts?.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await Promise.race([
      provider.complete(req, { signal: ac.signal }),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener(
          "abort",
          () => reject(new AgentProviderTimeoutError(timeoutMs)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onOuterAbort);
  }
}
