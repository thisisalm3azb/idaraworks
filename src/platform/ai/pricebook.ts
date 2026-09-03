/**
 * H28 — the effective-dated price book and cost estimation (ADR-51/52).
 *
 * Prices are never inferred: a model without an effective row cannot be
 * routed. Estimates are exact integer arithmetic in micro-units of the row's
 * currency per token, rounded up per category so partial tokens never round to
 * free. Credits follow the effective credit policy: one credit is one US cent
 * of estimated cost at the policy's ratio (ADR-54).
 */
import { sql, type TenantTx } from "@/platform/tenancy";
import type { GatewayUsage } from "./adapters/types";

export type PriceRow = {
  id: string;
  providerKey: string;
  modelKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  inputPerMtokMicros: bigint;
  outputPerMtokMicros: bigint;
  cacheReadPerMtokMicros: bigint | null;
  cacheWritePerMtokMicros: bigint | null;
  reasoningPerMtokMicros: bigint | null;
  version: number;
  sourceUrl: string | null;
};

type RawPrice = Record<string, unknown>;

function rowOf(r: RawPrice): PriceRow {
  const big = (v: unknown): bigint | null =>
    v === null || v === undefined ? null : BigInt(String(v));
  return {
    id: String(r.id),
    providerKey: String(r.provider_key),
    modelKey: String(r.model_key),
    effectiveFrom: String(r.effective_from),
    effectiveTo:
      r.effective_to === null || r.effective_to === undefined ? null : String(r.effective_to),
    currency: String(r.currency),
    inputPerMtokMicros: big(r.input_per_mtok_micros)!,
    outputPerMtokMicros: big(r.output_per_mtok_micros)!,
    cacheReadPerMtokMicros: big(r.cache_read_per_mtok_micros),
    cacheWritePerMtokMicros: big(r.cache_write_per_mtok_micros),
    reasoningPerMtokMicros: big(r.reasoning_per_mtok_micros),
    version: Number(r.version),
    sourceUrl: r.source_url === null || r.source_url === undefined ? null : String(r.source_url),
  };
}

/** The price row in force for a model at a moment (null when unpriced: routing refuses). */
export async function effectivePrice(
  tx: TenantTx,
  modelKey: string,
  at: Date = new Date(),
): Promise<PriceRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id, provider_key, model_key, effective_from::text as effective_from,
           effective_to::text as effective_to, currency, input_per_mtok_micros::text as input_per_mtok_micros,
           output_per_mtok_micros::text as output_per_mtok_micros,
           cache_read_per_mtok_micros::text as cache_read_per_mtok_micros,
           cache_write_per_mtok_micros::text as cache_write_per_mtok_micros,
           reasoning_per_mtok_micros::text as reasoning_per_mtok_micros, version, source_url
    from public.ai_price_book
    where model_key = ${modelKey} and effective_from <= ${at.toISOString()}::timestamptz
      and (effective_to is null or effective_to > ${at.toISOString()}::timestamptz)
    order by effective_from desc, version desc
    limit 1`)) as unknown as RawPrice[];
  return rows[0] ? rowOf(rows[0]) : null;
}

/** Every price row for a model, newest first (history for the operator centre). */
export async function priceHistory(tx: TenantTx, modelKey: string): Promise<PriceRow[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, provider_key, model_key, effective_from::text as effective_from,
           effective_to::text as effective_to, currency, input_per_mtok_micros::text as input_per_mtok_micros,
           output_per_mtok_micros::text as output_per_mtok_micros,
           cache_read_per_mtok_micros::text as cache_read_per_mtok_micros,
           cache_write_per_mtok_micros::text as cache_write_per_mtok_micros,
           reasoning_per_mtok_micros::text as reasoning_per_mtok_micros, version, source_url
    from public.ai_price_book where model_key = ${modelKey}
    order by effective_from desc, version desc limit 100`)) as unknown as RawPrice[];
  return rows.map(rowOf);
}

const MTOK = 1_000_000n;

function ceilDiv(n: bigint, d: bigint): bigint {
  return n <= 0n ? 0n : (n + d - 1n) / d;
}

/** Estimated cost in micro-units of the price row's currency; every category rounds up. */
export function estimateCostMicros(price: PriceRow, usage: GatewayUsage): bigint {
  const input = ceilDiv(BigInt(Math.max(0, usage.input)) * price.inputPerMtokMicros, MTOK);
  const output = ceilDiv(BigInt(Math.max(0, usage.output)) * price.outputPerMtokMicros, MTOK);
  const cacheRead = ceilDiv(
    BigInt(Math.max(0, usage.cacheRead)) *
      (price.cacheReadPerMtokMicros ?? price.inputPerMtokMicros),
    MTOK,
  );
  const cacheWrite = ceilDiv(
    BigInt(Math.max(0, usage.cacheWrite)) *
      (price.cacheWritePerMtokMicros ?? price.inputPerMtokMicros),
    MTOK,
  );
  const reasoning = ceilDiv(
    BigInt(Math.max(0, usage.reasoning)) *
      (price.reasoningPerMtokMicros ?? price.outputPerMtokMicros),
    MTOK,
  );
  return input + output + cacheRead + cacheWrite + reasoning;
}

/** A conservative pre-call estimate from the approximate input size and the requested output ceiling. */
export function estimateUpperBoundMicros(
  price: PriceRow,
  approxInputTokens: number,
  maxOutputTokens: number,
): bigint {
  return estimateCostMicros(price, {
    input: approxInputTokens,
    output: maxOutputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
}

export type CreditPolicy = { id: string; effectiveFrom: string; creditsPerUsdCent: number };

export async function effectiveCreditPolicy(
  tx: TenantTx,
  at: Date = new Date(),
): Promise<CreditPolicy | null> {
  const rows = (await tx.execute(sql`
    select id::text as id, effective_from::text as effective_from, credits_per_usd_cent::text as ratio
    from public.ai_credit_policy where effective_from <= ${at.toISOString()}::timestamptz
    order by effective_from desc limit 1`)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    effectiveFrom: String(r.effective_from),
    creditsPerUsdCent: Number(r.ratio),
  };
}

const MICROS_PER_CENT = 10_000n;

/** Credits for a USD cost in micros: cents rounded up, times the policy ratio, rounded up. Non-USD costs
 * are never converted here (no invented exchange rate): the caller passes USD only. */
export function creditsForUsdMicros(costMicros: bigint, policy: CreditPolicy): number {
  const cents = ceilDiv(costMicros, MICROS_PER_CENT);
  return Math.ceil(Number(cents) * policy.creditsPerUsdCent);
}
