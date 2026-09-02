/**
 * H26 — canonical serialisation, content hashes and the evidence chain.
 *
 * Pure functions: no I/O, no clock, no randomness. The same snapshot always
 * produces the same hash, on any machine, so a receipt printed today can be
 * verified against the row years later.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The content hash of a revision or snapshot: sha256 of its canonical JSON. */
export function contentHash(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

/** The genesis hash of a document's chain: 64 zero hex digits. */
export const GENESIS_HASH = "0".repeat(64);

export type ChainEventInput = {
  documentId: string;
  seq: number;
  kind: string;
  actorUserId: string | null;
  actorLabel: string | null;
  payload: unknown;
  at: string;
};

/** event_hash = sha256(prev_hash + "\n" + canonical(event)). */
export function eventHash(prevHash: string, event: ChainEventInput): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(event)}`);
}

export type ChainRow = ChainEventInput & { prevHash: string; eventHash: string };

/**
 * Recompute a whole chain and report the first break, if any. Used by the
 * verification screen and by the tests that pin tamper evidence.
 */
export function verifyChain(
  rows: readonly ChainRow[],
): { ok: true } | { ok: false; atSeq: number; reason: string } {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) return { ok: false, atSeq: row.seq, reason: "sequence gap" };
    if (row.prevHash !== prev)
      return { ok: false, atSeq: row.seq, reason: "previous hash mismatch" };
    const { prevHash: _p, eventHash: _e, ...event } = row;
    void _p;
    void _e;
    const computed = eventHash(prev, event);
    if (!safeEqualHex(computed, row.eventHash))
      return { ok: false, atSeq: row.seq, reason: "event hash mismatch" };
    prev = row.eventHash;
    expectedSeq += 1;
  }
  return { ok: true };
}

/** Constant-time comparison of two hex digests (tokens, hashes). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
