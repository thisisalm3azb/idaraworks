/**
 * Deterministic primitives for the business-simulation factory (micro-step 006A).
 *
 * Everything the factory generates must be reproducible from a fixed seed so the
 * generator is idempotent and unit-testable without a database: same scenario +
 * same as-of date ⇒ byte-identical plan. This module provides a small seeded PRNG
 * and RFC-4122 v5 (namespaced, SHA-1) UUIDs so every row gets a STABLE id derived
 * from its logical name — re-running the seed upserts the same rows instead of
 * duplicating them. No randomness from Date.now()/Math.random() ever enters here.
 */
import { createHash } from "node:crypto";

/** A fixed namespace UUID for all simulation ids (arbitrary, constant). */
export const SIM_NAMESPACE = "6d3f9c14-8a2b-5e77-b1c9-0f2a4e6d8b10";

/** 32-bit FNV-1a hash of a string → seed for the PRNG. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, well-distributed deterministic PRNG. */
export class Rng {
  private state: number;
  constructor(seed: string) {
    this.state = hash32(seed) || 1;
  }
  /** next float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** float in [min, max) rounded to `decimals`. */
  float(min: number, max: number, decimals = 2): number {
    const v = min + this.next() * (max - min);
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  }
  /** pick one element. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick on empty array");
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  /** true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const HEX = "0123456789abcdef";
function bytesToUuid(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += HEX[b[i]! >> 4]! + HEX[b[i]! & 0x0f]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * RFC-4122 v5 UUID (namespace + name, SHA-1). Deterministic: the same name in the
 * same namespace always yields the same id. We derive one id per logical entity
 * (e.g. `${orgKey}:customer:3`) so a re-seed targets the exact same rows.
 */
export function uuidv5(name: string, namespace = SIM_NAMESPACE): string {
  const ns = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, "utf8");
  const h = createHash("sha1")
    .update(Buffer.concat([Buffer.from(ns), nameBytes]))
    .digest();
  const b = new Uint8Array(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  return bytesToUuid(b);
}
