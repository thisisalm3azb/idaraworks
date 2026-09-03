/**
 * H28 — layered injection defence helpers (ADR-56).
 *
 * Deterministic, outside the model:
 *  - a bilingual suspicious-instruction detector over untrusted content
 *    (records, documents, imported text, the person's own input); a hit is
 *    logged as a `flag` step and forces the confirmation path for any
 *    proposed action in that run — it never blocks reading;
 *  - minimisation: secrets, personal identifiers and unnecessary fields are
 *    masked before a block leaves the platform;
 *  - provenance-labelled, JSON-encoded blocks (the model receives data, not
 *    instructions).
 */
import type { GatewayBlock } from "@/platform/ai";
import type { RecordRef } from "./types";

const SUSPICIOUS: Array<{ code: string; re: RegExp }> = [
  {
    code: "ignore_instructions",
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?)\b/i,
  },
  {
    code: "ignore_instructions_ar",
    re: /(تجاهل|انس|انسَ|اهمل)[^.\n]{0,40}(التعليمات|الأوامر|القواعد)/,
  },
  {
    code: "reveal_system",
    re: /\b(reveal|print|show|output|repeat)\b[^.\n]{0,40}\b(system prompt|instructions|api key|secret|password|token|credentials?)\b/i,
  },
  {
    code: "reveal_system_ar",
    re: /(اكشف|اطبع|أظهر|اعرض)[^.\n]{0,40}(التعليمات|المفتاح|كلمة المرور|السر|الرمز)/,
  },
  {
    code: "transfer_money",
    re: /\b(transfer|wire|send|pay out|release)\b[^.\n]{0,40}\b(money|funds|payment|\$|usd|aed|sar)\b/i,
  },
  { code: "transfer_money_ar", re: /(حوّل|حول|ادفع|أرسل)[^.\n]{0,40}(المال|الأموال|مبلغ|دفعة)/ },
  {
    code: "role_override",
    re: /\b(you are now|act as|pretend to be|new role)\b[^.\n]{0,60}\b(admin|administrator|owner|developer|system|root)\b/i,
  },
  {
    code: "grant_access",
    re: /\b(grant|give|elevate)\b[^.\n]{0,40}\b(access|permission|privileges?|admin)\b/i,
  },
  {
    code: "delete_history",
    re: /\b(delete|erase|wipe|purge)\b[^.\n]{0,40}\b(all|every|history|records|audit|logs?)\b/i,
  },
  {
    code: "approve_self",
    re: /\b(approve|sign|submit|finali[sz]e)\b[^.\n]{0,30}\b(this|it|now|immediately|without)\b/i,
  },
  { code: "hidden_markup", re: /<\s*(script|iframe|object)\b|\bjavascript:|\bdata:text\/html/i },
];

export type InjectionFlag = { code: string; sample: string; source: string };

/** Scan a text for instruction-shaped content. Returns flags (never throws). */
export function detectSuspicious(text: string, source: string): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  if (!text) return out;
  const t = text.length > 50_000 ? text.slice(0, 50_000) : text;
  for (const s of SUSPICIOUS) {
    const m = s.re.exec(t);
    if (m) out.push({ code: s.code, sample: m[0].slice(0, 120), source });
  }
  return out;
}

// ── minimisation ────────────────────────────────────────────────────────────

const SECRET_SHAPES: RegExp[] = [
  /\b(sk|ak|pk|rk)[-_](live|test|prod)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /postgres(ql)?:\/\/[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const PERSONAL_SHAPES: Array<{ re: RegExp; mask: string }> = [
  { re: /\b784-?\d{4}-?\d{7}-?\d\b/g, mask: "[national-id]" }, // UAE Emirates ID shape
  { re: /\b[12]\d{9}\b/g, mask: "[national-id]" }, // KSA national/iqama shape (10 digits, leading 1 or 2)
  { re: /\b[A-Z]{1,2}\d{6,9}\b/g, mask: "[passport]" },
  {
    re: /\bAE\d{2}\s?(\d{4}\s?){4}\d{3}\b|\bSA\d{2}\s?(\d{4}\s?){5}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    mask: "[iban]",
  },
  { re: /\b(?:\d[ -]?){13,19}\b/g, mask: "[card-number]" },
];

export type RedactionOptions = {
  /** Keep contact details (emails, phones) when the tool needs them (e.g. drafting a follow-up). */
  keepContacts?: boolean;
};

/** Mask secrets and personal identifiers; contact details only when the tool asked to keep them. */
export function redactForModel(text: string, opts: RedactionOptions = {}): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(re, "[secret]");
  for (const p of PERSONAL_SHAPES) out = out.replace(p.re, p.mask);
  if (!opts.keepContacts) {
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
    out = out.replace(/(?:\+|00)\d{1,3}[\s-]?(?:\d[\s-]?){7,12}\b/g, "[phone]");
  }
  return out;
}

/** JSON-encode a redacted, size-bounded value for a block. */
export function encodeForBlock(
  value: unknown,
  opts: RedactionOptions = {},
  maxChars = 20_000,
): string {
  let json: string;
  try {
    json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    json = String(value);
  }
  const redacted = redactForModel(json, opts);
  return redacted.length > maxChars ? redacted.slice(0, maxChars) + "…[truncated]" : redacted;
}

export function makeBlock(
  source: string,
  records: readonly RecordRef[],
  value: unknown,
  opts: RedactionOptions = {},
): GatewayBlock {
  return {
    source,
    records: records.map((r) => ({ type: r.type, id: r.id })),
    retrievedAt: new Date().toISOString(),
    content: encodeForBlock(value, opts),
  };
}
