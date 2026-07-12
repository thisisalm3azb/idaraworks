/**
 * Structural config diff (v1 §14 step 5: "the preview is a diff against
 * current configuration"). Pure; walks two JSON values and reports leaf-level
 * additions/removals/changes with dotted paths — the UI renders these entries,
 * and tests assert on them.
 */
export type DiffEntry = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(path: string, before: unknown, after: unknown, out: DiffEntry[]): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    out.push({ path, kind: "added", after });
    return;
  }
  if (after === undefined) {
    out.push({ path, kind: "removed", before });
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walk(path ? `${path}.${key}` : key, before[key], after[key], out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      walk(`${path}[${i}]`, before[i], after[i], out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, kind: "changed", before, after });
  }
}

export function diffConfig(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk("", before ?? undefined, after ?? undefined, out);
  return out;
}
