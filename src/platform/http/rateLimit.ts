/**
 * Rate-limiting seam (doc 10 #32; security review 2026-09-20).
 *
 * Three stores, chosen by `selectRateLimitStore()`:
 *
 *  - "upstash"  when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set:
 *               one fixed-window INCR+EXPIRE pipeline per call.
 *  - "db"       the SHARED store that needs no new vendor: `app.rate_limit_hit`
 *               (migration 0143) keeps one fixed-window bucket per key in an
 *               unlogged table, so every serverless instance and every worker
 *               process counts against the same budget. This is the default on
 *               a deployed environment (APP_ENV prod/preview); set
 *               RATE_LIMIT_STORE=db to force it locally, RATE_LIMIT_STORE=memory
 *               to opt out.
 *  - "memory"   an in-process sliding window. It bounds ONE process only — a
 *               `next start` runs several workers and Vercel runs many
 *               instances, each with its own map — so it is a development and
 *               unit-test store, never protection for a deployed app.
 *
 * Failure behaviour is deliberate and loud: when the shared store cannot answer
 * (network error, timeout, missing migration) the call FAILS OPEN to the memory
 * store and logs at error level, because a store outage must not lock every
 * user out of login. The memory fallback still bounds the calling process.
 *
 * `retryAfterSeconds` is the time until the fixed window rolls over, for a
 * `retry-after` header and for copy that tells a person when to try again.
 */
import { fetchWithPolicy } from "./fetchWithPolicy";
import { logger } from "@/platform/logger";
import { isDeployed } from "@/platform/env";
import { createAppDb, sql, type AppDb } from "@/platform/tenancy";

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

type Rule = { limit: number; windowSeconds: number };

export const RATE_RULES = {
  login: { limit: 10, windowSeconds: 300 },
  signup: { limit: 5, windowSeconds: 3600 },
  // U1 follow-up: the forgot-password action — same budget as signup (it also
  // sends an email per call and must not become an enumeration/spam vector).
  password_reset: { limit: 5, windowSeconds: 3600 },
  otp_send: { limit: 5, windowSeconds: 600 },
  invite_send: { limit: 20, windowSeconds: 3600 },
  invite_accept: { limit: 10, windowSeconds: 600 },
  // Security review 2026-09-20 (F-30): the token-hash confirmation route and
  // the OAuth/PKCE callback verify against the auth provider on every call and
  // were unbounded. A person confirms once or twice; thirty per address per ten
  // minutes leaves room for a mail scanner and a retry, and caps guessing at a
  // few thousand attempts a day per address against a token that expires.
  confirm: { limit: 30, windowSeconds: 600 },
  // Phase I review fix: /api/health fans out to DB + storage per call and is
  // unauthenticated — bound it. Generous enough for smoke suites + monitors.
  health: { limit: 30, windowSeconds: 60 },
  // S7: the PUBLIC customer-share page (doc 10 item 14). Unauthenticated + token-bearer;
  // bound per-IP to blunt token enumeration / scraping.
  share: { limit: 30, windowSeconds: 60 },
  // H22.0: the PDF a public share link can download. Far tighter than viewing
  // the page, because every call starts a headless browser. Six a minute is
  // more than a recipient ever needs and bounds what a leaked token can cost.
  share_pdf: { limit: 6, windowSeconds: 60 },
  // Security review 2026-09-20 (F-24): the AUTHENTICATED PDF routes start the
  // same headless browser. Per member, not per address: twenty a minute is
  // more than anybody prints by hand and bounds what one account can cost.
  pdf: { limit: 20, windowSeconds: 60 },
  // Security review 2026-09-20 (F-23): a CSV export reads every row of an
  // entity. Ten per member per ten minutes covers exporting every entity once.
  export: { limit: 10, windowSeconds: 600 },
  // S10: the unauthenticated billing webhook — bound per-IP so an attacker can't hammer the
  // signature-verify + org-resolve path. Generous for a real provider's legitimate burst.
  webhook: { limit: 120, windowSeconds: 60 },
  // Security review 2026-09-20: the unauthenticated per-company manifest and
  // icon endpoints each open a database connection (and the icon may render).
  // An install fetches one manifest and up to four icons; sixty a minute per
  // address is generous for people and a ceiling for a script.
  identity: { limit: 60, windowSeconds: 60 },
  // The CSP violation report sink is unauthenticated and writes a log line per
  // call; a browser sends a handful per page at most.
  csp_report: { limit: 20, windowSeconds: 60 },
} as const satisfies Record<string, Rule>;

export type RateScope = keyof typeof RATE_RULES;

export type RateLimitStore = "upstash" | "db" | "memory";

/** Which store answers, from the environment alone (pure; unit-tested). */
export function selectRateLimitStore(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return "upstash";
  const forced = env.RATE_LIMIT_STORE;
  if (forced === "db" || forced === "memory") return forced;
  if (forced === "upstash") return "memory"; // asked for upstash without its credentials
  return isDeployed() ? "db" : "memory";
}

const memory = new Map<string, number[]>();

function memoryLimit(key: string, rule: Rule): RateLimitResult {
  const now = Date.now();
  const windowStart = now - rule.windowSeconds * 1000;
  const hits = (memory.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= rule.limit) {
    memory.set(key, hits);
    const oldest = hits[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowSeconds * 1000 - now) / 1000)),
    };
  }
  hits.push(now);
  memory.set(key, hits);
  if (memory.size > 10_000) memory.clear(); // crude bound; a shared store is the real one
  return { allowed: true, remaining: rule.limit - hits.length, retryAfterSeconds: 0 };
}

async function upstashLimit(key: string, rule: Rule): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  // Fixed-window via INCR + EXPIRE (single pipeline round trip). The TTL is
  // read back so a refusal can say when the window rolls over.
  const res = await fetchWithPolicy(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", `rl:${key}`],
      ["EXPIRE", `rl:${key}`, String(rule.windowSeconds), "NX"],
      ["TTL", `rl:${key}`],
    ]),
  });
  const data = (await res.json()) as Array<{ result: number }>;
  const count = data[0]?.result ?? 0;
  const ttl = data[2]?.result ?? rule.windowSeconds;
  const allowed = count <= rule.limit;
  return {
    allowed,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, ttl > 0 ? ttl : rule.windowSeconds),
  };
}

/** The one round trip the shared store makes. Injectable for unit tests. */
export type HitRunner = (
  key: string,
  limit: number,
  windowSeconds: number,
) => Promise<{ allowed: boolean; remaining: number; retry_after: number }>;

let limiterDb: { db: AppDb; end: () => Promise<void> } | undefined;

/** A dedicated, tiny pool — the shared app pool is for tenant transactions only. */
function limiterPool(): AppDb {
  limiterDb ??= createAppDb({ max: 2 });
  return limiterDb.db;
}

const DB_TIMEOUT_MS = 2_000;

const dbHit: HitRunner = async (key, limit, windowSeconds) => {
  const query = limiterPool().transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select allowed, remaining, retry_after
      from app.rate_limit_hit(${key}, ${limit}, ${windowSeconds})
    `)) as unknown as Array<{ allowed: boolean; remaining: number; retry_after: number }>;
    const r = rows[0];
    if (!r) throw new Error("rate_limit_hit returned no row");
    return r;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rate_limit_hit timed out")), DB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

async function dbLimit(key: string, rule: Rule, run: HitRunner): Promise<RateLimitResult> {
  const r = await run(key, rule.limit, rule.windowSeconds);
  return {
    allowed: r.allowed,
    remaining: Math.max(0, Number(r.remaining)),
    retryAfterSeconds: r.allowed ? 0 : Math.max(1, Number(r.retry_after)),
  };
}

/**
 * Count one hit for `identifier` under `scope` and say whether it is within
 * budget. `options.run` exists for unit tests of the shared-store path; the
 * store itself is chosen from the environment.
 */
export async function rateLimit(
  scope: RateScope,
  identifier: string,
  options: { run?: HitRunner; store?: RateLimitStore } = {},
): Promise<RateLimitResult> {
  const rule = RATE_RULES[scope];
  const key = `${scope}:${identifier}`;
  const store = options.store ?? selectRateLimitStore();
  if (store === "upstash") {
    try {
      return await upstashLimit(key, rule);
    } catch (err) {
      // Fail-open to the memory store, loudly — availability over lockout.
      logger.error({ scope, err: (err as Error).message }, "upstash rate limit unavailable");
    }
  } else if (store === "db") {
    try {
      return await dbLimit(key, rule, options.run ?? dbHit);
    } catch (err) {
      // Same rule: a store outage bounds the calling process only, and says so.
      logger.error(
        { scope, err: (err as Error).message },
        "shared rate limit store unavailable — falling back to the per-process store",
      );
    }
  }
  return memoryLimit(key, rule);
}

/** Test/shutdown hook. */
export async function closeRateLimitStore(): Promise<void> {
  if (limiterDb) {
    await limiterDb.end();
    limiterDb = undefined;
  }
}
