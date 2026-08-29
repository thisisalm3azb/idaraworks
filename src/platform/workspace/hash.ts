/**
 * Blueprint content hashing (H14 Part E). A revision's hash protects against
 * stale approval: approval binds to the EXACT content hash, and application
 * verifies the stored content still hashes to the approved value. Canonical
 * JSON (recursively sorted object keys) makes the hash independent of
 * property insertion order.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON form. */
export function blueprintHash(blueprint: unknown): string {
  return createHash("sha256").update(canonicalJson(blueprint), "utf8").digest("hex");
}
