/**
 * Rate-limiting seam (doc 10 #32). Upstash REST when configured; otherwise an
 * in-memory sliding window (dev/CI — single process, resets on deploy; the
 * hosted app MUST have Upstash configured before pilots, tracked in OA-4).
 */
import { fetchWithPolicy } from "./fetchWithPolicy";
import { logger } from "@/platform/logger";

export type RateLimitResult = { allowed: boolean; remaining: number };

type Rule = { limit: number; windowSeconds: number };

export const RATE_RULES = {
  login: { limit: 10, windowSeconds: 300 },
  signup: { limit: 5, windowSeconds: 3600 },
  otp_send: { limit: 5, windowSeconds: 600 },
  invite_send: { limit: 20, windowSeconds: 3600 },
  invite_accept: { limit: 10, windowSeconds: 600 },
  // Phase I review fix: /api/health fans out to DB + storage per call and is
  // unauthenticated — bound it. Generous enough for smoke suites + monitors.
  health: { limit: 30, windowSeconds: 60 },
  // S7: the PUBLIC customer-share page (doc 10 item 14). Unauthenticated + token-bearer;
  // bound per-IP to blunt token enumeration / scraping. Upstash is the real store (OA-4).
  share: { limit: 30, windowSeconds: 60 },
  // S10: the unauthenticated billing webhook — bound per-IP so an attacker can't hammer the
  // signature-verify + org-resolve path. Generous for a real provider's legitimate burst.
  webhook: { limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, Rule>;

export type RateScope = keyof typeof RATE_RULES;

const memory = new Map<string, number[]>();

function memoryLimit(key: string, rule: Rule): RateLimitResult {
  const now = Date.now();
  const windowStart = now - rule.windowSeconds * 1000;
  const hits = (memory.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= rule.limit) {
    memory.set(key, hits);
    return { allowed: false, remaining: 0 };
  }
  hits.push(now);
  memory.set(key, hits);
  if (memory.size > 10_000) memory.clear(); // crude bound; Upstash is the real store
  return { allowed: true, remaining: rule.limit - hits.length };
}

async function upstashLimit(key: string, rule: Rule): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  // Fixed-window via INCR + EXPIRE (single pipeline round trip).
  const res = await fetchWithPolicy(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", `rl:${key}`],
      ["EXPIRE", `rl:${key}`, String(rule.windowSeconds), "NX"],
    ]),
  });
  const data = (await res.json()) as Array<{ result: number }>;
  const count = data[0]?.result ?? 0;
  return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count) };
}

export async function rateLimit(scope: RateScope, identifier: string): Promise<RateLimitResult> {
  const rule = RATE_RULES[scope];
  const key = `${scope}:${identifier}`;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      return await upstashLimit(key, rule);
    } catch (err) {
      // Fail-open to memory limiter, loudly — availability over lockout for MVP auth.
      logger.warn({ scope, err: (err as Error).message }, "upstash rate limit unavailable");
    }
  }
  return memoryLimit(key, rule);
}
