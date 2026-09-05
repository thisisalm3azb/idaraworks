/**
 * H33 Pilot Lab — deterministic identity.
 *
 * Every row the lab writes has an id derived from (seed version, company,
 * family, ordinal). Run the seed twice and the second run computes the same ids,
 * so `ON CONFLICT DO NOTHING` makes idempotency a property of the data rather
 * than of bookkeeping — and a manifest can name every record family without
 * storing a single id.
 */
import { uuidv5 } from "../simulation/rng";
import { SEED_VERSION } from "./marker";

/** A namespace of our own, so lab ids can never collide with the demo factory's. */
export const H33_NAMESPACE = "3d1c0b2a-7e5f-5a94-8c6d-2f1e0a9b8c7d";

/** `id("gulfbuild", "customer", 17)` → the same uuid every time. */
export function id(company: string, family: string, ...ordinal: Array<string | number>): string {
  return uuidv5(`h33:${SEED_VERSION}:${company}:${family}:${ordinal.join(":")}`, H33_NAMESPACE);
}

/** Stable, readable references such as INV-000123 for documents that carry one. */
export function ref(prefix: string, n: number, pad = 6): string {
  return `${prefix}-${String(n).padStart(pad, "0")}`;
}
