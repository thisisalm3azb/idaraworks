/**
 * H26 — revision comparison (ADR-31). Block-level, then word-level inside a
 * changed text block. Pure; the screens render the result side by side or
 * inline.
 */
import { flattenBlocks, type Block, type DocBody, type LocaleText } from "./types";

export type BlockChange =
  | { kind: "unchanged"; id: string; type: Block["type"] }
  | { kind: "added"; id: string; type: Block["type"]; after: Block }
  | { kind: "removed"; id: string; type: Block["type"]; before: Block }
  | {
      kind: "changed";
      id: string;
      type: Block["type"];
      before: Block;
      after: Block;
      words?: WordDiff;
    }
  | { kind: "moved"; id: string; type: Block["type"]; from: number; to: number };

export type WordDiff = { en?: WordOp[]; ar?: WordOp[] };
export type WordOp = { op: "eq" | "ins" | "del"; text: string };

export type RevisionDiff = {
  changes: BlockChange[];
  summary: { added: number; removed: number; changed: number; moved: number; unchanged: number };
};

function textOf(b: Block): LocaleText | null {
  switch (b.type) {
    case "heading":
    case "paragraph":
    case "note":
      return b.text;
    case "clause":
      return b.text;
    default:
      return null;
  }
}

function stable(b: Block): string {
  // Everything but the id, so a moved block compares equal to itself.
  const { id: _id, ...rest } = b as Block & { id: string };
  void _id;
  return JSON.stringify(rest);
}

export function diffRevisions(before: DocBody, after: DocBody): RevisionDiff {
  const a = flattenBlocks(before);
  const b = flattenBlocks(after);
  const aIndex = new Map(a.map((x, i) => [x.id, i]));
  const bIndex = new Map(b.map((x, i) => [x.id, i]));
  const changes: BlockChange[] = [];
  const summary = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 };

  for (const [i, blk] of a.entries()) {
    const j = bIndex.get(blk.id);
    if (j === undefined) {
      changes.push({ kind: "removed", id: blk.id, type: blk.type, before: blk });
      summary.removed += 1;
      continue;
    }
    const nb = b[j]!;
    if (stable(blk) !== stable(nb)) {
      const wa = textOf(blk);
      const wb = textOf(nb);
      const words: WordDiff | undefined =
        wa && wb
          ? {
              ...(wa.en !== undefined || wb.en !== undefined
                ? { en: wordDiff(wa.en ?? "", wb.en ?? "") }
                : {}),
              ...(wa.ar !== undefined || wb.ar !== undefined
                ? { ar: wordDiff(wa.ar ?? "", wb.ar ?? "") }
                : {}),
            }
          : undefined;
      changes.push({ kind: "changed", id: blk.id, type: blk.type, before: blk, after: nb, words });
      summary.changed += 1;
    } else if (relativeOrderChanged(i, j, a, b, aIndex, bIndex)) {
      changes.push({ kind: "moved", id: blk.id, type: blk.type, from: i, to: j });
      summary.moved += 1;
    } else {
      changes.push({ kind: "unchanged", id: blk.id, type: blk.type });
      summary.unchanged += 1;
    }
  }
  for (const [j, blk] of b.entries()) {
    if (!aIndex.has(blk.id)) {
      // Insert in document order of the new revision.
      const at = changes.findIndex((c) => {
        const idx = bIndex.get(c.id);
        return idx !== undefined && idx > j;
      });
      const change: BlockChange = { kind: "added", id: blk.id, type: blk.type, after: blk };
      if (at === -1) changes.push(change);
      else changes.splice(at, 0, change);
      summary.added += 1;
    }
  }
  return { changes, summary };
}

function relativeOrderChanged(
  i: number,
  j: number,
  a: Block[],
  b: Block[],
  aIndex: Map<string, number>,
  bIndex: Map<string, number>,
): boolean {
  // Compare the previous surviving neighbour in each revision.
  const prevA = [...a.slice(0, i)].reverse().find((x) => bIndex.has(x.id))?.id ?? null;
  const prevB = [...b.slice(0, j)].reverse().find((x) => aIndex.has(x.id))?.id ?? null;
  return prevA !== prevB;
}

/** Word-level LCS diff (small inputs; text blocks are bounded). */
export function wordDiff(before: string, after: string): WordOp[] {
  const a = before.split(/(\s+)/).filter((w) => w.length > 0);
  const b = after.split(/(\s+)/).filter((w) => w.length > 0);
  const CAP = 1500;
  if (a.length > CAP || b.length > CAP) {
    return [
      { op: "del", text: before },
      { op: "ins", text: after },
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: WordOp[] = [];
  let i = 0;
  let j = 0;
  const push = (op: WordOp["op"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]!);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push("del", a[i]!);
      i += 1;
    } else {
      push("ins", b[j]!);
      j += 1;
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("ins", b[j++]!);
  return ops;
}
