/**
 * H26 Document Studio — the closed vocabulary of the authored document.
 *
 * A document body is a list of BLOCKS. Blocks carry text per language, data
 * bindings that resolve at read time while drafting and freeze into the
 * issued snapshot, form fields whose values live in `variables`, conditional
 * sections, line-item tables, signature fields and page furniture. Everything
 * here is validated with zod at every write; nothing tenant-authored extends
 * the vocabulary.
 */
import { z } from "zod";

export const DOC_CATEGORIES = [
  "contract",
  "agreement",
  "letter",
  "proposal",
  "policy",
  "form",
  "certificate",
  "other",
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const DOC_LANGUAGES = ["en", "ar", "bilingual"] as const;
export type DocLanguage = (typeof DOC_LANGUAGES)[number];

export const DOC_STATUSES = [
  "draft",
  "review",
  "approval",
  "signature",
  "active",
  "expired",
  "terminated",
  "superseded",
  "archived",
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/** Statuses in which the working revision may still change. */
export const EDITABLE_STATUSES: readonly DocStatus[] = ["draft"];
/** Statuses that carry an issued snapshot. */
export const ISSUED_STATUSES: readonly DocStatus[] = [
  "signature",
  "active",
  "expired",
  "terminated",
  "superseded",
];

export const COUNTERPARTY_KINDS = ["customer", "supplier", "employee", "other"] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/** Records a document may belong to (validated against the owning module). */
export const LINKABLE_RECORDS = [
  "job",
  "quote",
  "invoice",
  "purchase_order",
  "lead",
  "opportunity",
  "customer",
  "supplier",
  "employee",
] as const;
export type LinkableRecord = (typeof LINKABLE_RECORDS)[number];

// ── error vocabulary ──────────────────────────────────────────────────────────
export type DocErrorCode =
  | "not_found"
  | "forbidden"
  | "state"
  | "conflict"
  | "validation"
  | "immutable"
  | "unavailable"
  | "expired";

export class DocError extends Error {
  readonly code: DocErrorCode;
  constructor(message: string, code: DocErrorCode) {
    super(message);
    this.name = "DocError";
    this.code = code;
  }
}

// ── text ──────────────────────────────────────────────────────────────────────
const bounded = (max: number) => z.string().max(max);

/** Text per language. A single-language document may omit the other. */
export const LocaleText = z
  .object({ en: bounded(20_000).optional(), ar: bounded(20_000).optional() })
  .strict()
  .refine((t) => (t.en ?? "").length > 0 || (t.ar ?? "").length > 0, {
    message: "text is required in at least one language",
  });
export type LocaleText = z.infer<typeof LocaleText>;

const optionalLocaleText = z
  .object({ en: bounded(2_000).optional(), ar: bounded(2_000).optional() })
  .strict()
  .optional();

export const BLOCK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const blockId = z.string().regex(BLOCK_ID);
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const fieldKey = z.string().regex(FIELD_KEY);

// ── conditions ────────────────────────────────────────────────────────────────
export const CONDITION_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "empty",
  "not_empty",
  "truthy",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * A condition over document facts. `key` is a form-field key, a binding path
 * (`customer.country`), or a document fact (`document.amount`,
 * `document.category`, `document.language`, `document.counterparty_kind`).
 */
export type Condition =
  | { key: string; op: ConditionOp; value?: string | number | boolean | Array<string | number> }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const Leaf = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_.:]{0,79}$/),
    op: z.enum(CONDITION_OPS),
    value: z
      .union([
        z.string().max(500),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string().max(200), z.number()])).max(50),
      ])
      .optional(),
  })
  .strict();

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    Leaf,
    z.object({ all: z.array(ConditionSchema).min(1).max(20) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(20) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
);

// ── bindings ──────────────────────────────────────────────────────────────────
/**
 * Binding paths resolve against the document's counterparty, linked record,
 * issuer identity and the document itself. The service refuses any path
 * outside this registry; a record the actor may not read resolves to a
 * refusal marker, never to a value (ADR-19: binding never widens access).
 */
export const BINDING_PATHS = [
  "document.reference",
  "document.title",
  "document.issued_at",
  "document.effective_from",
  "document.expires_at",
  "issuer.trading_name",
  "issuer.legal_name",
  "issuer.trn",
  "issuer.license_no",
  "issuer.address",
  "issuer.phone",
  "issuer.email",
  "issuer.website",
  "issuer.signatory_name",
  "issuer.signatory_title",
  "counterparty.name",
  "counterparty.address",
  "counterparty.trn",
  "counterparty.email",
  "counterparty.phone",
  "counterparty.contact",
  "employee.name",
  "employee.employee_no",
  "employee.position",
  "employee.department",
  "employee.hire_date",
  "employee.nationality",
  "record.reference",
  "record.title",
  "record.total",
  "record.currency",
  "record.date",
  "today",
] as const;
export type BindingPath = (typeof BINDING_PATHS)[number];

// ── blocks ────────────────────────────────────────────────────────────────────
export const FIELD_KINDS = [
  "text",
  "textarea",
  "number",
  "money",
  "date",
  "choice",
  "checkbox",
  "email",
  "phone",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const SIGNATURE_PARTS = ["signature", "name", "title", "date", "initials"] as const;
export type SignaturePart = (typeof SIGNATURE_PARTS)[number];

const base = { id: blockId, condition: ConditionSchema.optional() };

export const HeadingBlock = z
  .object({
    ...base,
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: LocaleText,
  })
  .strict();
export const ParagraphBlock = z
  .object({ ...base, type: z.literal("paragraph"), text: LocaleText })
  .strict();
export const ClauseBlock = z
  .object({ ...base, type: z.literal("clause"), title: optionalLocaleText, text: LocaleText })
  .strict();
export const ListBlock = z
  .object({
    ...base,
    type: z.literal("list"),
    style: z.enum(["bullet", "number"]),
    items: z.array(LocaleText).min(1).max(100),
  })
  .strict();
export const TableBlock = z
  .object({
    ...base,
    type: z.literal("table"),
    columns: z.array(LocaleText).min(1).max(12),
    rows: z.array(z.array(LocaleText).max(12)).max(500),
  })
  .strict();
export const LineItem = z
  .object({
    description: LocaleText,
    qty: z.number().finite().min(0).max(1_000_000_000),
    unit: bounded(40).optional(),
    unitPriceMinor: z.number().int().min(0).max(1_000_000_000_000),
    vatRate: z.number().min(0).max(100).default(0),
  })
  .strict();
export type LineItem = z.infer<typeof LineItem>;
export const LineItemsBlock = z
  .object({
    ...base,
    type: z.literal("line_items"),
    /** manual rows, or the linked quote / invoice lines resolved at read time. */
    source: z.enum(["manual", "quote", "invoice"]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    items: z.array(LineItem).max(500).default([]),
    showVat: z.boolean().default(true),
    showTotals: z.boolean().default(true),
  })
  .strict();
export const FieldBlock = z
  .object({
    ...base,
    type: z.literal("field"),
    key: fieldKey,
    kind: z.enum(FIELD_KINDS),
    label: LocaleText,
    help: optionalLocaleText,
    required: z.boolean().default(false),
    options: z.array(LocaleText).max(50).optional(),
    /** Money fields carry a currency; number fields may carry bounds. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: bounded(200).optional(),
    /** A calculated field: a safe arithmetic expression over other keys. */
    computed: bounded(500).optional(),
    /** Who fills it: the author while drafting, or a named signing party. */
    filledBy: z.enum(["author", "party"]).default("author"),
    party: bounded(40).optional(),
  })
  .strict();
export const BindingBlock = z
  .object({
    ...base,
    type: z.literal("binding"),
    path: z.enum(BINDING_PATHS),
    label: optionalLocaleText,
    format: z.enum(["text", "money", "date"]).default("text"),
  })
  .strict();
export const SignatureBlock = z
  .object({
    ...base,
    type: z.literal("signature"),
    /** The signing party this block belongs to (matched to signers by label). */
    party: z.string().regex(/^[A-Za-z0-9_ -]{1,40}$/),
    label: LocaleText,
    parts: z.array(z.enum(SIGNATURE_PARTS)).min(1).max(5).default(["signature", "name", "date"]),
  })
  .strict();
export const ImageBlock = z
  .object({
    ...base,
    type: z.literal("image"),
    /** "logo" = the organisation logo from branding; otherwise an attached file id. */
    source: z.union([z.literal("logo"), z.string().uuid()]),
    caption: optionalLocaleText,
    widthPct: z.number().int().min(10).max(100).default(40),
    align: z.enum(["start", "center", "end"]).default("start"),
  })
  .strict();
export const PageBreakBlock = z.object({ ...base, type: z.literal("page_break") }).strict();
export const NoteBlock = z
  .object({
    ...base,
    type: z.literal("note"),
    tone: z.enum(["info", "warning"]).default("info"),
    text: LocaleText,
  })
  .strict();

const LeafBlock = z.discriminatedUnion("type", [
  HeadingBlock,
  ParagraphBlock,
  ClauseBlock,
  ListBlock,
  TableBlock,
  LineItemsBlock,
  FieldBlock,
  BindingBlock,
  SignatureBlock,
  ImageBlock,
  PageBreakBlock,
  NoteBlock,
]);
export type LeafBlock = z.infer<typeof LeafBlock>;

/** A conditional section: one level of nesting, shown only when its condition holds. */
export const SectionBlock = z
  .object({
    ...base,
    type: z.literal("section"),
    title: optionalLocaleText,
    blocks: z.array(LeafBlock).max(200),
  })
  .strict();
export type SectionBlock = z.infer<typeof SectionBlock>;

export const Block = z.union([LeafBlock, SectionBlock]);
export type Block = z.infer<typeof Block>;
export type BlockType = Block["type"];
export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "clause",
  "list",
  "table",
  "line_items",
  "field",
  "binding",
  "signature",
  "image",
  "page_break",
  "note",
  "section",
] as const satisfies readonly BlockType[];

export const DocBody = z
  .object({ blocks: z.array(Block).max(500) })
  .strict()
  .superRefine((body, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    const visit = (b: Block, path: (string | number)[]) => {
      if (ids.has(b.id))
        ctx.addIssue({ code: "custom", message: `duplicate block id ${b.id}`, path });
      ids.add(b.id);
      if (b.type === "field") {
        if (keys.has(b.key))
          ctx.addIssue({ code: "custom", message: `duplicate field key ${b.key}`, path });
        keys.add(b.key);
        if (b.kind === "choice" && (!b.options || b.options.length === 0))
          ctx.addIssue({ code: "custom", message: "a choice field needs options", path });
        if (b.filledBy === "party" && !b.party)
          ctx.addIssue({ code: "custom", message: "a party-filled field names its party", path });
      }
      if (b.type === "section") b.blocks.forEach((c, i) => visit(c, [...path, "blocks", i]));
    };
    body.blocks.forEach((b, i) => visit(b, ["blocks", i]));
  });
export type DocBody = z.infer<typeof DocBody>;

// ── settings ──────────────────────────────────────────────────────────────────
export const DOC_WATERMARKS = ["none", "draft", "sample", "confidential"] as const;
export const DocSettings = z
  .object({
    header: z
      .object({
        showLogo: z.boolean().default(true),
        showIssuer: z.boolean().default(true),
        showReference: z.boolean().default(true),
      })
      .strict()
      .default({ showLogo: true, showIssuer: true, showReference: true }),
    footer: z
      .object({ text: optionalLocaleText, showPageNumbers: z.boolean().default(true) })
      .strict()
      .default({ showPageNumbers: true }),
    watermark: z.enum(DOC_WATERMARKS).default("none"),
    numberClauses: z.boolean().default(true),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type DocSettings = z.infer<typeof DocSettings>;
export const DEFAULT_SETTINGS: DocSettings = DocSettings.parse({});

/** Form and calculated field values keyed by field key. */
export const DocVariables = z.record(
  fieldKey,
  z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]),
);
export type DocVariables = z.infer<typeof DocVariables>;

// ── helpers ───────────────────────────────────────────────────────────────────
/** Every leaf block in document order (sections flattened, section itself included first). */
export function flattenBlocks(body: DocBody): Block[] {
  const out: Block[] = [];
  for (const b of body.blocks) {
    out.push(b);
    if (b.type === "section") for (const c of b.blocks) out.push(c);
  }
  return out;
}

export function fieldBlocks(body: DocBody): Array<z.infer<typeof FieldBlock>> {
  return flattenBlocks(body).filter((b): b is z.infer<typeof FieldBlock> => b.type === "field");
}

export function signatureParties(body: DocBody): string[] {
  const parties: string[] = [];
  for (const b of flattenBlocks(body)) {
    if (b.type === "signature" && !parties.includes(b.party)) parties.push(b.party);
  }
  return parties;
}

/** Plain text of a body for search and diffs (both languages, document order). */
export function bodyPlainText(body: DocBody): string {
  const parts: string[] = [];
  const lt = (t: LocaleText | undefined) => {
    if (!t) return;
    if (t.en) parts.push(t.en);
    if (t.ar) parts.push(t.ar);
  };
  for (const b of flattenBlocks(body)) {
    switch (b.type) {
      case "heading":
      case "paragraph":
      case "note":
        lt(b.text);
        break;
      case "clause":
        lt(b.title);
        lt(b.text);
        break;
      case "list":
        b.items.forEach(lt);
        break;
      case "table":
        b.columns.forEach(lt);
        b.rows.forEach((r) => r.forEach(lt));
        break;
      case "line_items":
        b.items.forEach((i) => lt(i.description));
        break;
      case "field":
        lt(b.label);
        break;
      case "section":
        lt(b.title);
        break;
      case "signature":
        lt(b.label);
        break;
      default:
        break;
    }
  }
  return parts.join("\n").slice(0, 200_000);
}
