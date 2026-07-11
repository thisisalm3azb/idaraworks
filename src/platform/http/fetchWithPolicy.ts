/**
 * Outbound HTTP policy wrapper (BUILD_BIBLE §8.10):
 * every external call (LLM, e-invoice, SMS, billing) goes through this —
 * timeout + bounded retry with backoff for idempotent requests + a simple
 * per-host circuit breaker. Never hand-rolled per call site.
 */
import { logger } from "@/platform/logger";

export class ExternalCallError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExternalCallError";
  }
}

type Policy = {
  timeoutMs?: number; // default 10s
  retries?: number; // default 2 (idempotent methods only)
  backoffMs?: number; // base backoff, default 300ms (exponential)
};

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

type BreakerState = { failures: number; openUntil: number };
const breakers = new Map<string, BreakerState>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;

function breaker(host: string): BreakerState {
  let s = breakers.get(host);
  if (!s) {
    s = { failures: 0, openUntil: 0 };
    breakers.set(host, s);
  }
  return s;
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  policy: Policy = {},
): Promise<Response> {
  const url = new URL(input);
  const host = url.host;
  const method = (init.method ?? "GET").toUpperCase();
  const timeoutMs = policy.timeoutMs ?? 10_000;
  const maxRetries = IDEMPOTENT.has(method) ? (policy.retries ?? 2) : 0;
  const backoffMs = policy.backoffMs ?? 300;

  const state = breaker(host);
  if (Date.now() < state.openUntil) {
    throw new ExternalCallError(`Circuit open for ${host}`, host);
  }

  const recordFailure = () => {
    state.failures += 1;
    if (state.failures >= BREAKER_THRESHOLD) {
      state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      state.failures = 0;
      logger.warn({ host }, "circuit breaker opened");
    }
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          lastError = new ExternalCallError(`Upstream ${res.status}`, host, res.status);
        } else {
          // Terminal 5xx: the caller decides what to do with the response,
          // but the breaker must count it (review finding #5 — a persistent
          // 5xx on POSTs previously RESET the breaker instead of tripping it).
          recordFailure();
          return res;
        }
      } else {
        state.failures = 0;
        return res;
      }
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }

  recordFailure();
  throw new ExternalCallError(`External call to ${host} failed`, host, undefined, lastError);
}
