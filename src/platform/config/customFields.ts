/**
 * Custom-field VALUE validation (doc-09 #6; S2). Definitions are config
 * (FieldDefinitionSet artifacts); values are DATA in the host entity's
 * custom_values jsonb (job, customer — F-13). This validator is the single
 * gate between the two: typed per the definition, unknown keys rejected,
 * required enforced, retired fields read-only (existing values persist —
 * D-9.2 history — but cannot be set anew).
 */
import type { FieldDefinition, FieldDefinitionSet } from "./schemas/artifacts";

export class CustomValueError extends Error {
  constructor(
    public readonly fieldKey: string,
    message: string,
  ) {
    super(`custom field "${fieldKey}": ${message}`);
    this.name = "CustomValueError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkValue(def: FieldDefinition, value: unknown): void {
  switch (def.type) {
    case "text":
      if (typeof value !== "string" || value.length < 1 || value.length > 500) {
        throw new CustomValueError(def.field_key, "expected text (1–500 chars)");
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CustomValueError(def.field_key, "expected a finite number");
      }
      return;
    case "money":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new CustomValueError(def.field_key, "expected minor units (non-negative integer)");
      }
      return;
    case "date":
      if (typeof value !== "string" || !ISO_DATE.test(value)) {
        throw new CustomValueError(def.field_key, "expected an ISO date (YYYY-MM-DD)");
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new CustomValueError(def.field_key, "expected boolean");
      return;
    case "photo":
      if (typeof value !== "string" || !UUID.test(value)) {
        throw new CustomValueError(def.field_key, "expected a file id");
      }
      return;
    case "select": {
      const keys = new Set((def.options ?? []).map((o) => o.key));
      if (typeof value !== "string" || !keys.has(value)) {
        throw new CustomValueError(def.field_key, "expected one of the defined options");
      }
      return;
    }
    case "multiselect": {
      const keys = new Set((def.options ?? []).map((o) => o.key));
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !keys.has(v))) {
        throw new CustomValueError(def.field_key, "expected a subset of the defined options");
      }
      return;
    }
  }
}

/**
 * Validate an incoming custom_values patch against the entity's definitions.
 * Returns the MERGED value blob (existing values for retired/omitted keys are
 * preserved — history never breaks). null/"" clears a non-required field.
 */
export function mergeCustomValues(
  defs: FieldDefinitionSet | null,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const fields = defs?.fields ?? [];
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, raw] of Object.entries(patch)) {
    const def = byKey.get(key);
    if (!def) throw new CustomValueError(key, "unknown field");
    if (def.retired) throw new CustomValueError(key, "field is retired (read-only)");
    if (raw === null || raw === "" || raw === undefined) {
      if (def.required) throw new CustomValueError(key, "required");
      delete merged[key];
      continue;
    }
    checkValue(def, raw);
    merged[key] = raw;
  }
  // Required fields must be present after the merge.
  for (const f of fields) {
    if (f.required && !f.retired && merged[f.field_key] === undefined) {
      throw new CustomValueError(f.field_key, "required");
    }
  }
  return merged;
}
