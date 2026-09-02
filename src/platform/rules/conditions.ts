/**
 * Pure rule evaluation shared by the Document Studio (server) and its public
 * pages (browser): conditional sections and workflow rules use one evaluator.
 *
 * A condition reads document facts (`document.amount`), bindings
 * (`counterparty.country`) and form fields by key. Comparisons are numeric
 * when both sides parse as numbers, otherwise case-insensitive strings.
 */
/** A condition tree: a leaf comparison, or all/any/not combinators. */
export type ConditionOp =
  "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "empty" | "not_empty" | "truthy";
export type Condition =
  | { key: string; op: ConditionOp; value?: string | number | boolean | Array<string | number> }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type ConditionValues = {
  bindings: Record<string, string | null>;
  variables: Record<string, string | number | boolean | null | undefined>;
};

export function lookupValue(
  key: string,
  values: ConditionValues,
): string | number | boolean | null {
  if (key in values.variables) {
    const v = values.variables[key];
    return v === undefined ? null : v;
  }
  if (key in values.bindings) return values.bindings[key] ?? null;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function norm(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

export function evaluateConditions(cond: Condition, values: ConditionValues): boolean {
  if ("all" in cond) return cond.all.every((c) => evaluateConditions(c, values));
  if ("any" in cond) return cond.any.some((c) => evaluateConditions(c, values));
  if ("not" in cond) return !evaluateConditions(cond.not, values);
  const actual = lookupValue(cond.key, values);
  const expected = cond.value;
  switch (cond.op) {
    case "empty":
      return actual === null || actual === "" || actual === false;
    case "not_empty":
      return !(actual === null || actual === "" || actual === false);
    case "truthy":
      return (
        actual === true ||
        (typeof actual === "string" && norm(actual) === "true") ||
        asNumber(actual) === 1
      );
    case "in": {
      const list = Array.isArray(expected) ? expected : expected === undefined ? [] : [expected];
      return list.some((x) => norm(x) === norm(actual));
    }
    case "eq":
    case "ne": {
      const an = asNumber(actual);
      const en = asNumber(expected);
      const equal = an !== null && en !== null ? an === en : norm(actual) === norm(expected);
      return cond.op === "eq" ? equal : !equal;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const an = asNumber(actual);
      const en = asNumber(expected);
      if (an === null || en === null) return false;
      if (cond.op === "gt") return an > en;
      if (cond.op === "gte") return an >= en;
      if (cond.op === "lt") return an < en;
      return an <= en;
    }
    default:
      return false;
  }
}
