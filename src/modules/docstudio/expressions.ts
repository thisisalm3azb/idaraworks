/**
 * H26 — a small, safe arithmetic evaluator for calculated fields.
 *
 * Grammar: numbers, identifiers (field keys), + - * /, parentheses, unary
 * minus, and the functions min(), max(), round(), abs(), sum(a, b, …). No
 * property access, no strings, no assignment, no host access: this is a
 * parser and a tree walk, never `eval`.
 */
export type Scope = Readonly<Record<string, number | string | boolean | null | undefined>>;

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" | "," };

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  round: (a) => (a.length > 1 ? Number(a[0]!.toFixed(a[1])) : Math.round(a[0]!)),
  abs: (a) => Math.abs(a[0]!),
  sum: (a) => a.reduce((s, x) => s + x, 0),
};

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new ExpressionError(`bad number at ${i}`);
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      let j = i;
      while (j < src.length && /[a-z0-9_]/i.test(src[j]!)) j += 1;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      out.push({ t: "op", v: c as Tok extends { t: "op"; v: infer V } ? V : never });
      i += 1;
      continue;
    }
    throw new ExpressionError(`unexpected character "${c}" at ${i}`);
  }
  return out;
}

/** Evaluate `src` against `scope`. Missing or non-numeric identifiers count as 0. */
export function evaluateExpression(src: string, scope: Scope): number {
  if (src.length > 500) throw new ExpressionError("expression too long");
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const take = () => toks[pos++];
  const num = (id: string): number => {
    const v = scope[id];
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    return 0;
  };

  function expr(): number {
    let left = term();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        take();
        const right = term();
        left = t.v === "+" ? left + right : left - right;
      } else return left;
    }
  }
  function term(): number {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        take();
        const right = unary();
        left = t.v === "*" ? left * right : right === 0 ? 0 : left / right;
      } else return left;
    }
  }
  function unary(): number {
    const t = peek();
    if (t && t.t === "op" && t.v === "-") {
      take();
      return -unary();
    }
    return primary();
  }
  function primary(): number {
    const t = take();
    if (!t) throw new ExpressionError("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      const next = peek();
      if (next && next.t === "op" && next.v === "(") {
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new ExpressionError(`unknown function ${t.v}`);
        take();
        const args: number[] = [];
        if (!(peek() && peek()!.t === "op" && (peek() as { v: string }).v === ")")) {
          args.push(expr());
          while (peek() && peek()!.t === "op" && (peek() as { v: string }).v === ",") {
            take();
            args.push(expr());
          }
        }
        const close = take();
        if (!close || close.t !== "op" || close.v !== ")") throw new ExpressionError("expected )");
        if (args.length === 0) throw new ExpressionError(`${t.v}() needs arguments`);
        return fn(args);
      }
      return num(t.v);
    }
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      const close = take();
      if (!close || close.t !== "op" || close.v !== ")") throw new ExpressionError("expected )");
      return v;
    }
    throw new ExpressionError(`unexpected token ${t.v}`);
  }

  const value = expr();
  if (pos !== toks.length) throw new ExpressionError("trailing input");
  if (!Number.isFinite(value)) throw new ExpressionError("not a finite number");
  return value;
}

/** Identifiers an expression reads (for dependency ordering). */
export function expressionIdentifiers(src: string): string[] {
  try {
    return tokenize(src)
      .filter((t): t is { t: "id"; v: string } => t.t === "id" && !(t.v in FUNCTIONS))
      .map((t) => t.v);
  } catch {
    return [];
  }
}
