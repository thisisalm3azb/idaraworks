/**
 * H33 Pilot Lab — family `docstudio`: the document lifecycle, end to end.
 *
 * Templates and their versions, documents in every status the schema allows,
 * revisions (working and frozen), issued snapshots, the tamper-evident event
 * chain, approval workflow runs and their steps, signature rooms with member
 * and external signers, review comments, contract obligations with real due
 * dates either side of the as-of, public form links and the submissions that
 * came back through them, and the saved views a team actually keeps.
 *
 * ── Two things this family refuses to fake ─────────────────────────────────
 * The evidence chain and the content hashes are computed with the SAME code
 * the product uses (`eventHash`, `contentHash`, `GENESIS_HASH` from
 * `@/modules/docstudio/snapshot`), so the Verify screen recomputes them and
 * agrees. A lab whose integrity check reads "chain broken" would be worse than
 * no lab at all. Every document body is parsed through the real `DocBody`
 * schema before it is written, so a body the editor could not open cannot be
 * seeded — the family throws instead.
 *
 * Nothing here is sent anywhere: a signer's invitation is recorded as having
 * been delivered in-app, external signer addresses are `.invalid`, and the
 * form links carry token hashes of ids rather than usable tokens.
 */
import { createHash } from "node:crypto";
import {
  contentHash,
  eventHash,
  GENESIS_HASH,
  type ChainEventInput,
} from "@/modules/docstudio/snapshot";
import { DocBody, DEFAULT_SETTINGS, bodyPlainText } from "@/modules/docstudio/types";
import { captureIssuerSnapshot } from "@/platform/documents/issuer";
import type { Check, Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import { issuerFor } from "./work";
import { paragraph, sentence } from "./_shared";

type Row = Record<string, unknown>;

export const DOCSTUDIO_TABLES = [
  "doc_workflow",
  "doc_template",
  "doc_template_version",
  "doc_document",
  "doc_revision",
  "doc_snapshot",
  "doc_event",
  "doc_workflow_run",
  "doc_workflow_step_run",
  "doc_signature_request",
  "doc_signer",
  "doc_comment",
  "doc_obligation",
  "doc_form_link",
  "doc_form_submission",
  "doc_saved_view",
  "reference_sequence",
] as const;
export type DocstudioTable = (typeof DOCSTUDIO_TABLES)[number];

/**
 * Switches the one part of seed() that needs a database beyond ctx.insert: the
 * update that points each document at its working revision and issued
 * snapshot. The unit test turns it off.
 */
export const docstudioRuntime = { live: true };

const SEQ_CONFLICT =
  "on conflict (org_id, scope_key) do update set next_value = greatest(reference_sequence.next_value, excluded.next_value)";

/** Statuses in lifecycle order; a document at index i has been through 0..i. */
export const DOC_STATUS_ORDER = [
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
export type DocStatusKey = (typeof DOC_STATUS_ORDER)[number];

/** How a company's documents are spread across the lifecycle. Sums to 100. */
export const STATUS_MIX: Record<DocStatusKey, number> = {
  draft: 12,
  review: 8,
  approval: 8,
  signature: 7,
  active: 43,
  expired: 7,
  terminated: 4,
  superseded: 7,
  archived: 4,
};

/** Statuses at which a document has been issued (and so has a snapshot). */
const ISSUED_STATUSES: ReadonlySet<string> = new Set([
  "signature",
  "active",
  "expired",
  "terminated",
  "superseded",
  "archived",
]);

// ── the template library ────────────────────────────────────────────────────

type TemplateSpec = {
  key: string;
  en: string;
  ar: string;
  category: "contract" | "agreement" | "letter" | "proposal" | "policy" | "form" | "certificate";
  counterparty: "customer" | "supplier" | "employee" | null;
  /** Parties that sign; empty means the document is issued straight to active. */
  parties: string[];
  workflow: "contract" | "policy" | null;
  /** Obligations are only meaningful on things with a term. */
  term: boolean;
  versions: number;
};

export const TEMPLATE_SPECS: TemplateSpec[] = [
  {
    key: "service_agreement",
    en: "Service agreement",
    ar: "اتفاقية خدمات",
    category: "agreement",
    counterparty: "customer",
    parties: ["Company", "Client"],
    workflow: "contract",
    term: true,
    versions: 2,
  },
  {
    key: "supply_contract",
    en: "Supply contract",
    ar: "عقد توريد",
    category: "contract",
    counterparty: "supplier",
    parties: ["Company", "Supplier"],
    workflow: "contract",
    term: true,
    versions: 2,
  },
  {
    key: "employment_offer",
    en: "Employment offer",
    ar: "عرض عمل",
    category: "letter",
    counterparty: "employee",
    parties: ["Company", "Candidate"],
    workflow: "contract",
    term: false,
    versions: 1,
  },
  {
    key: "nda",
    en: "Non-disclosure agreement",
    ar: "اتفاقية عدم إفشاء",
    category: "agreement",
    counterparty: "customer",
    parties: ["Company", "Counterparty"],
    workflow: null,
    term: true,
    versions: 1,
  },
  {
    key: "engagement_letter",
    en: "Engagement letter",
    ar: "خطاب ارتباط",
    category: "proposal",
    counterparty: "customer",
    parties: [],
    workflow: null,
    term: false,
    versions: 1,
  },
  {
    key: "site_access_form",
    en: "Site access request",
    ar: "طلب دخول الموقع",
    category: "form",
    counterparty: null,
    parties: [],
    workflow: null,
    term: false,
    versions: 1,
  },
  {
    key: "hse_policy",
    en: "Health and safety policy",
    ar: "سياسة الصحة والسلامة",
    category: "policy",
    counterparty: null,
    parties: [],
    workflow: "policy",
    term: true,
    versions: 2,
  },
  {
    key: "completion_certificate",
    en: "Completion certificate",
    ar: "شهادة إنجاز",
    category: "certificate",
    counterparty: "customer",
    parties: [],
    workflow: null,
    term: false,
    versions: 1,
  },
];

const WORKFLOW_SPECS = {
  contract: {
    name: "Contract approval",
    steps: [
      { id: "review", kind: "review" as const, archetype: "manager" as const },
      { id: "approval", kind: "approval" as const, archetype: "owner" as const },
      { id: "signature", kind: "signature" as const, archetype: null },
    ],
  },
  policy: {
    name: "Policy review",
    steps: [
      { id: "review", kind: "review" as const, archetype: "manager" as const },
      { id: "approval", kind: "approval" as const, archetype: "admin" as const },
    ],
  },
} as const;
type WorkflowKey = keyof typeof WORKFLOW_SPECS;

// ── bodies ──────────────────────────────────────────────────────────────────

type Body = { blocks: unknown[] };

/**
 * A body for a template. Parsed through the product's own `DocBody` schema by
 * `checkedBody` before anything is written.
 */
function templateBody(spec: TemplateSpec, company: Company): Body {
  const blocks: unknown[] = [
    { id: "h1", type: "heading", level: 1, text: { en: spec.en, ar: spec.ar } },
    {
      id: "parties",
      type: "paragraph",
      text: {
        en: `This ${spec.en.toLowerCase()} is made between {{issuer.legal_name}} and the counterparty named below.`,
        ar: `حُررت هذه الوثيقة بين ${company.legalNameEn} والطرف المذكور أدناه.`,
      },
    },
    { id: "bind_cp", type: "binding", path: "counterparty.name", format: "text" },
    { id: "bind_ref", type: "binding", path: "record.reference", format: "text" },
  ];
  blocks.push({
    id: "c_scope",
    type: "clause",
    title: { en: "Scope", ar: "النطاق" },
    text: {
      en: "The scope of work, the deliverables and the acceptance criteria are as set out in the schedule attached to this document.",
      ar: "نطاق العمل والمخرجات ومعايير القبول مبينة في الجدول المرفق بهذه الوثيقة.",
    },
  });
  if (spec.term) {
    blocks.push({
      id: "c_term",
      type: "clause",
      title: { en: "Term and renewal", ar: "المدة والتجديد" },
      text: {
        en: "This document takes effect on the effective date and continues for twelve months, renewing for successive twelve-month terms unless either party gives sixty days' written notice.",
        ar: "تسري هذه الوثيقة من تاريخ النفاذ ولمدة اثني عشر شهرًا، وتتجدد لمدد مماثلة ما لم يخطر أحد الطرفين الآخر كتابةً قبل ستين يومًا.",
      },
    });
    blocks.push({
      id: "c_payment",
      type: "clause",
      title: { en: "Payment", ar: "الدفع" },
      text: {
        en: "Invoices are payable within thirty days of issue. Amounts are exclusive of value added tax unless stated otherwise.",
        ar: "تُسدد الفواتير خلال ثلاثين يومًا من تاريخ إصدارها، والمبالغ غير شاملة لضريبة القيمة المضافة ما لم يُذكر خلاف ذلك.",
      },
    });
  }
  blocks.push({
    id: "f_ref",
    type: "field",
    key: "counterparty_reference",
    kind: "text",
    label: { en: "Counterparty reference", ar: "مرجع الطرف الآخر" },
    required: false,
    filledBy: "author",
  });
  if (spec.category === "form") {
    blocks.push(
      {
        id: "f_name",
        type: "field",
        key: "visitor_name",
        kind: "text",
        label: { en: "Visitor name", ar: "اسم الزائر" },
        required: true,
        filledBy: "author",
      },
      {
        id: "f_date",
        type: "field",
        key: "visit_date",
        kind: "date",
        label: { en: "Date of visit", ar: "تاريخ الزيارة" },
        required: true,
        filledBy: "author",
      },
      {
        id: "f_reason",
        type: "field",
        key: "visit_reason",
        kind: "choice",
        label: { en: "Reason", ar: "السبب" },
        options: [
          { en: "Delivery", ar: "توصيل" },
          { en: "Inspection", ar: "تفتيش" },
          { en: "Maintenance", ar: "صيانة" },
        ],
        required: true,
        filledBy: "author",
      },
      {
        id: "f_induction",
        type: "field",
        key: "induction_done",
        kind: "checkbox",
        label: { en: "Safety induction completed", ar: "تم استكمال التعريف بالسلامة" },
        required: true,
        filledBy: "author",
      },
    );
  }
  blocks.push({
    id: "notes",
    type: "note",
    tone: "info",
    text: {
      en: "Pilot Lab document. Every party, address and amount in it is fictional.",
      ar: "وثيقة مختبر تجريبي. جميع الأطراف والعناوين والمبالغ الواردة فيها خيالية.",
    },
  });
  for (const [i, party] of spec.parties.entries()) {
    blocks.push({
      id: `sig_${i}`,
      type: "signature",
      party,
      label: { en: `Signed for ${party}`, ar: `التوقيع عن ${party}` },
      parts: ["signature", "name", "title", "date"],
    });
  }
  return { blocks };
}

/** Parse through the product's schema; a body the editor could not open throws. */
function checkedBody(body: Body, where: string): Body {
  const parsed = DocBody.safeParse(body);
  if (!parsed.success) throw new Error(`${where}: invalid document body — ${parsed.error.message}`);
  return parsed.data as unknown as Body;
}

// ── the model ───────────────────────────────────────────────────────────────

type Doc = {
  id: string;
  reference: string;
  spec: TemplateSpec;
  templateId: string;
  templateVersionId: string;
  workflowId: string | null;
  status: DocStatusKey;
  language: "en" | "ar" | "bilingual";
  title: string;
  folderId: string | null;
  counterpartyKind: string | null;
  counterpartyId: string | null;
  counterpartyLabel: string | null;
  recordType: string | null;
  recordId: string | null;
  ownerUserId: string;
  createdAgo: number;
  issuedAgo: number | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  /** Revision 1, always. Frozen once the document has been issued. */
  rev1Id: string;
  /** An amendment opened after issue; null when there is none. */
  rev2Id: string | null;
  snapshotId: string | null;
  contentHash: string | null;
  body: Body;
  bodyText: string;
  supersedesId: string | null;
  supersededById: string | null;
};

export type DocstudioModel = {
  workflows: Record<WorkflowKey, string>;
  templates: Array<{ spec: TemplateSpec; id: string; versionIds: string[] }>;
  docs: Doc[];
  rows: Record<DocstudioTable, Row[]>;
  notes: string[];
  tableCounts: Record<DocstudioTable, number>;
};

const MODELS = new WeakMap<object, DocstudioModel>();

function readHandoff<T>(ctx: LabContext, family: string): T {
  try {
    return (ctx.handoff<T>(family) ?? ({} as T)) as T;
  } catch {
    return {} as T;
  }
}

/** Largest-remainder allocation, so the mix is exact and stable at any size. */
export function allocateStatuses(total: number): DocStatusKey[] {
  const keys = DOC_STATUS_ORDER;
  const raw = keys.map((k) => (total * STATUS_MIX[k]) / 100);
  const base = raw.map((v) => Math.floor(v));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i]! += 1;
    left -= 1;
  }
  // Below ~30 documents the rare statuses round to nothing; a pilot still has
  // to be able to open one of each, so borrow from the largest bucket.
  const biggest = base.indexOf(Math.max(...base));
  for (let i = 0; i < base.length && total >= keys.length; i++) {
    if (base[i] === 0 && base[biggest]! > 1) {
      base[i] = 1;
      base[biggest]! -= 1;
    }
  }
  const out: DocStatusKey[] = [];
  for (const [i, k] of keys.entries()) for (let n = 0; n < base[i]!; n++) out.push(k);
  return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function buildDocstudio(ctx: LabContext): DocstudioModel {
  const memoKey = ctx as unknown as object;
  const memo = MODELS.get(memoKey);
  if (memo) return memo;

  const { company, clock, rng, users, orgId } = ctx;
  const notes: string[] = [];
  const setup = readHandoff<{ folders?: Record<string, string> }>(ctx, "setup");
  const masters = readHandoff<{ customerIds?: string[]; supplierIds?: string[] }>(ctx, "masters");
  const people = readHandoff<{ activeEmployeeIds?: string[]; managers?: string[] }>(ctx, "people");
  const work = readHandoff<{ jobs?: Array<{ id: string; reference: string }> }>(ctx, "work");

  const folderIds = Object.values(setup.folders ?? {});
  const customers = masters.customerIds ?? [];
  const suppliers = masters.supplierIds ?? [];
  const employees = people.activeEmployeeIds ?? [];
  const jobs = work.jobs ?? [];
  if (!customers.length) notes.push("no customers in the masters handoff — documents are unlinked");

  const rows = Object.fromEntries(DOCSTUDIO_TABLES.map((t) => [t, [] as Row[]])) as Record<
    DocstudioTable,
    Row[]
  >;
  const push = (t: DocstudioTable, r: Row) => rows[t].push(r);
  const ts = (agoDays: number, hour = 10, minute = 0) => clock.tsAgo(agoDays, hour, minute);
  const ar = company.languages[0] === "ar";

  // ── workflows ─────────────────────────────────────────────────────────────
  const workflows = {} as Record<WorkflowKey, string>;
  for (const key of Object.keys(WORKFLOW_SPECS) as WorkflowKey[]) {
    const spec = WORKFLOW_SPECS[key];
    const id = ctx.id("doc_workflow", key);
    workflows[key] = id;
    push("doc_workflow", {
      id,
      org_id: orgId,
      name: spec.name,
      description: `${spec.name} — the route every ${key === "contract" ? "contract" : "policy"} takes before it can be issued.`,
      definition: { steps: spec.steps.map((s) => ({ ...s })) },
      status: "active",
      row_version: 1,
      created_by: users.admin,
      updated_by: users.admin,
      created_at: ts(720, 8),
      updated_at: ts(720, 8),
    });
  }

  // ── templates and their versions ──────────────────────────────────────────
  const templates: DocstudioModel["templates"] = [];
  for (const spec of TEMPLATE_SPECS) {
    const id = ctx.id("doc_template", spec.key);
    const body = checkedBody(templateBody(spec, company), `template ${spec.key}`);
    const versionIds: string[] = [];
    for (let v = 1; v <= spec.versions; v++) {
      const vid = ctx.id("doc_template_version", spec.key, v);
      versionIds.push(vid);
      const agoDays = 700 - (v - 1) * 200;
      push("doc_template_version", {
        id: vid,
        org_id: orgId,
        template_id: id,
        version: v,
        body,
        settings: DEFAULT_SETTINGS,
        change_note:
          v === 1
            ? "First published version."
            : "Payment and notice clauses reworded after the annual legal review.",
        published_at: ts(agoDays, 9),
        published_by: users.admin,
        created_by: users.admin,
        created_at: ts(agoDays + 3, 9),
      });
    }
    push("doc_template", {
      id,
      org_id: orgId,
      key: spec.key,
      name_en: spec.en,
      name_ar: spec.ar,
      category: spec.category,
      description: `${spec.en} used across the business. Fictional content for the Pilot Lab.`,
      status: "published",
      current_version: spec.versions,
      builtin_key: null,
      workflow_id: spec.workflow ? workflows[spec.workflow] : null,
      row_version: spec.versions,
      created_by: users.admin,
      updated_by: users.admin,
      created_at: ts(703, 9),
      updated_at: ts(700 - (spec.versions - 1) * 200, 9),
    });
    templates.push({ spec, id, versionIds });
  }

  // ── documents ─────────────────────────────────────────────────────────────
  const total = company.profile.documents;
  const statuses = allocateStatuses(total);
  const historyDays = Math.max(90, clock.daysAgoOf(company.history.from));
  const docs: Doc[] = [];
  const issuer = issuerFor(company);

  for (let i = 0; i < total; i++) {
    const t = templates[i % templates.length]!;
    const spec = t.spec;
    const status = statuses[i]!;
    // Newer documents sit later in the list; the spread is deterministic.
    const createdAgo = Math.max(5, Math.round(historyDays - (i * (historyDays - 10)) / total));
    const issued = ISSUED_STATUSES.has(status);
    const issuedAgo = issued ? Math.max(2, createdAgo - 7) : null;
    const language: Doc["language"] = ar
      ? i % 3 === 0
        ? "bilingual"
        : "ar"
      : i % 5 === 0
        ? "bilingual"
        : "en";

    let cpKind: string | null = null;
    let cpId: string | null = null;
    let cpLabel: string | null = null;
    if (spec.counterparty === "customer" && customers.length) {
      cpKind = "customer";
      cpId = customers[i % customers.length]!;
      cpLabel = `Customer ${(i % customers.length) + 1}`;
    } else if (spec.counterparty === "supplier" && suppliers.length) {
      cpKind = "supplier";
      cpId = suppliers[i % suppliers.length]!;
      cpLabel = `Supplier ${(i % suppliers.length) + 1}`;
    } else if (spec.counterparty === "employee" && employees.length) {
      cpKind = "employee";
      cpId = employees[i % employees.length]!;
      cpLabel = `Employee ${(i % employees.length) + 1}`;
    }

    // A quarter of documents hang off a job, which is what makes the
    // "documents for this job" panel worth opening.
    const job = jobs.length && i % 4 === 0 ? jobs[i % jobs.length]! : null;

    const body = checkedBody(templateBody(spec, company), `document ${i}`);
    const bodyText = bodyPlainText(body as never);
    const docId = ctx.id("doc_document", i);
    const rev1Id = ctx.id("doc_revision", i, 1);
    // An amendment in progress on a live contract: issued, and with a working
    // revision open on top of the frozen one.
    const amend = status === "active" && spec.term && i % 7 === 0;
    const rev2Id = amend ? ctx.id("doc_revision", i, 2) : null;
    const snapshotId = issued ? ctx.id("doc_snapshot", i) : null;
    const hash = issued ? contentHash({ body, docId, version: 1 }) : null;

    docs.push({
      id: docId,
      reference: `DOC-${String(i + 1).padStart(3, "0")}`,
      spec,
      templateId: t.id,
      templateVersionId: t.versionIds[t.versionIds.length - 1]!,
      workflowId: spec.workflow ? workflows[spec.workflow] : null,
      status,
      language,
      title: `${spec.en} — ${cpLabel ?? (job ? job.reference : `internal ${i + 1}`)}`,
      folderId: folderIds.length ? folderIds[i % folderIds.length]! : null,
      counterpartyKind: cpKind,
      counterpartyId: cpId,
      counterpartyLabel: cpLabel,
      recordType: job ? "job" : null,
      recordId: job ? job.id : null,
      ownerUserId: i % 3 === 0 ? users.manager : i % 3 === 1 ? users.admin : users.owner,
      createdAgo,
      issuedAgo,
      effectiveFrom: issuedAgo === null ? null : clock.dayAgo(issuedAgo),
      expiresAt:
        issuedAgo === null
          ? null
          : status === "expired"
            ? clock.dayAgo(Math.max(1, Math.floor(issuedAgo / 3)))
            : spec.term
              ? clock.dayAhead(120 + (i % 200))
              : null,
      rev1Id,
      rev2Id,
      snapshotId,
      contentHash: hash,
      body,
      bodyText,
      supersedesId: null,
      supersededById: null,
    });
  }

  /*
   * Supersession is a pair, not a flag: every superseded document points at the
   * one that replaced it, and that one points back. Pairing walks the list in
   * index order so the same documents pair on every run.
   */
  const superseded = docs.filter((d) => d.status === "superseded");
  const successors = docs.filter((d) => d.status === "active" && d.spec.term);
  for (const [i, old] of superseded.entries()) {
    const next = successors[i];
    if (!next) {
      notes.push(`${superseded.length - i} superseded documents had no successor to point at`);
      break;
    }
    old.supersededById = next.id;
    next.supersedesId = old.id;
  }

  // ── document, revision, snapshot and event rows ───────────────────────────
  for (const d of docs) {
    const issued = d.issuedAgo !== null;
    push("doc_document", {
      id: d.id,
      org_id: orgId,
      reference: d.reference,
      title: d.title,
      category: d.spec.category,
      language: d.language,
      status: d.status,
      folder_id: d.folderId,
      tags: [d.spec.key, d.spec.category],
      template_id: d.templateId,
      template_version_id: d.templateVersionId,
      workflow_id: d.workflowId,
      /*
       * Both of these are foreign keys to rows this family writes AFTER the
       * document — a revision and a snapshot — and neither constraint is
       * deferrable, so they cannot be set on insert. The product has the same
       * problem and solves it the same way: create the document, write the
       * revision, then point one at the other. `linkDocuments` below does it
       * in a single statement once every child row exists.
       */
      working_revision_id: null,
      issued_snapshot_id: null,
      issued_at: d.issuedAgo === null ? null : ts(d.issuedAgo, 11),
      issued_by: issued ? users.owner : null,
      effective_from: d.effectiveFrom,
      expires_at: d.expiresAt,
      counterparty_kind: d.counterpartyKind,
      counterparty_id: d.counterpartyId,
      counterparty_label: d.counterpartyLabel,
      record_type: d.recordType,
      record_id: d.recordId,
      owner_user_id: d.ownerUserId,
      supersedes_document_id: d.supersedesId,
      superseded_by_document_id: d.supersededById,
      terminated_at:
        d.status === "terminated" ? ts(Math.max(1, (d.issuedAgo ?? 30) - 20), 14) : null,
      terminated_by: d.status === "terminated" ? users.owner : null,
      termination_reason:
        d.status === "terminated"
          ? "Terminated by mutual agreement after the counterparty restructured its operations."
          : null,
      archived_at: d.status === "archived" ? ts(Math.max(1, (d.issuedAgo ?? 40) - 30), 15) : null,
      archived_by: d.status === "archived" ? users.admin : null,
      retention_until: issued ? clock.dayAhead(365 * 5) : null,
      legal_hold: d.status === "terminated" && d.spec.term,
      search_text: [d.title, d.reference, d.spec.key, d.counterpartyLabel ?? "", d.bodyText].join(
        "\n",
      ),
      row_version: issued ? 3 : 1,
      created_by: users.admin,
      updated_by: users.admin,
      created_at: ts(d.createdAgo, 10),
      updated_at: ts(Math.min(d.createdAgo, d.issuedAgo ?? d.createdAgo), 11),
    });

    push("doc_revision", {
      id: d.rev1Id,
      org_id: orgId,
      document_id: d.id,
      revision_no: 1,
      state: issued ? "frozen" : "working",
      body: d.body,
      variables: {},
      settings: DEFAULT_SETTINGS,
      body_text: d.bodyText,
      content_hash: d.contentHash,
      based_on_revision_id: null,
      note: issued ? "Frozen at issue." : null,
      frozen_at: issued ? ts(d.issuedAgo!, 11) : null,
      frozen_by: issued ? users.owner : null,
      row_version: 1,
      created_by: users.admin,
      updated_by: users.admin,
      created_at: ts(d.createdAgo, 10),
      updated_at: ts(d.issuedAgo ?? d.createdAgo, 11),
    });
    if (d.rev2Id) {
      push("doc_revision", {
        id: d.rev2Id,
        org_id: orgId,
        document_id: d.id,
        revision_no: 2,
        state: "working",
        body: d.body,
        variables: {},
        settings: DEFAULT_SETTINGS,
        body_text: d.bodyText,
        content_hash: null,
        based_on_revision_id: d.rev1Id,
        note: "Amendment in progress: revised scope and payment schedule.",
        frozen_at: null,
        frozen_by: null,
        row_version: 1,
        created_by: users.manager,
        updated_by: users.manager,
        created_at: ts(Math.max(1, d.issuedAgo! - 15), 10),
        updated_at: ts(Math.max(1, d.issuedAgo! - 15), 10),
      });
    }

    if (d.snapshotId) {
      const issuedAt = ts(d.issuedAgo!, 11);
      push("doc_snapshot", {
        id: d.snapshotId,
        org_id: orgId,
        document_id: d.id,
        revision_id: d.rev1Id,
        snapshot: {
          version: 1,
          document: {
            id: d.id,
            reference: d.reference,
            title: d.title,
            category: d.spec.category,
            language: d.language,
            issuedAt,
            effectiveFrom: d.effectiveFrom,
            expiresAt: d.expiresAt,
            counterpartyKind: d.counterpartyKind,
            counterpartyId: d.counterpartyId,
            counterpartyLabel: d.counterpartyLabel,
            recordType: d.recordType,
            recordId: d.recordId,
            parties: d.spec.parties,
          },
          issuer: captureIssuerSnapshot(issuer, issuedAt),
          branding: { logoFileId: null, accentColor: company.brandColor },
          body: d.body,
          values: { bindings: {}, lineItems: {}, variables: {} },
          settings: DEFAULT_SETTINGS,
          fonts: ["NotoSans", "NotoNaskhArabic"],
          issuedAt,
        },
        content_hash: d.contentHash,
        issued_at: issuedAt,
        issued_by: users.owner,
        created_by: users.owner,
        created_at: issuedAt,
      });
    }

    // ── the evidence chain, hashed with the product's own function ──────────
    const timeline: Array<{ kind: string; ago: number; actor: string | null; payload: Row }> = [
      {
        kind: "created",
        ago: d.createdAgo,
        actor: users.admin,
        payload: { reference: d.reference },
      },
    ];
    const at = DOC_STATUS_ORDER.indexOf(d.status);
    const reached = (s: DocStatusKey) => at >= DOC_STATUS_ORDER.indexOf(s);
    if (reached("review"))
      timeline.push({
        kind: "submitted_for_review",
        ago: Math.max(1, d.createdAgo - 2),
        actor: users.admin,
        payload: {},
      });
    if (reached("approval"))
      timeline.push({
        kind: "approval_started",
        ago: Math.max(1, d.createdAgo - 4),
        actor: users.manager,
        payload: { workflowId: d.workflowId },
      });
    if (reached("signature")) {
      timeline.push({
        kind: "approval_completed",
        ago: Math.max(1, d.createdAgo - 6),
        actor: users.owner,
        payload: {},
      });
      timeline.push({
        kind: "issued",
        ago: d.issuedAgo!,
        actor: users.owner,
        payload: { contentHash: d.contentHash },
      });
      if (d.spec.parties.length)
        timeline.push({
          kind: "signature_requested",
          ago: Math.max(1, d.issuedAgo! - 1),
          actor: users.owner,
          payload: { parties: d.spec.parties },
        });
    }
    if (reached("active")) {
      if (d.spec.parties.length)
        timeline.push({
          kind: "signed",
          ago: Math.max(1, d.issuedAgo! - 3),
          actor: null,
          payload: { party: d.spec.parties[d.spec.parties.length - 1] },
        });
      timeline.push({
        kind: "activated",
        ago: Math.max(1, d.issuedAgo! - 4),
        actor: users.owner,
        payload: {},
      });
    }
    if (d.rev2Id)
      timeline.push({
        kind: "revision_opened",
        ago: Math.max(1, d.issuedAgo! - 15),
        actor: users.manager,
        payload: { revisionNo: 2 },
      });
    if (d.status === "expired")
      timeline.push({
        kind: "expired",
        ago: Math.max(1, Math.floor((d.issuedAgo ?? 30) / 3)),
        actor: null,
        payload: {},
      });
    if (d.status === "terminated")
      timeline.push({
        kind: "terminated",
        ago: Math.max(1, (d.issuedAgo ?? 30) - 20),
        actor: users.owner,
        payload: { reason: "mutual agreement" },
      });
    if (d.status === "superseded")
      timeline.push({
        kind: "superseded",
        ago: Math.max(1, (d.issuedAgo ?? 30) - 10),
        actor: users.admin,
        payload: { by: d.supersededById },
      });
    if (d.status === "archived")
      timeline.push({
        kind: "archived",
        ago: Math.max(1, (d.issuedAgo ?? 40) - 30),
        actor: users.admin,
        payload: {},
      });

    let prev = GENESIS_HASH;
    for (const [n, e] of timeline.entries()) {
      const seq = n + 1;
      const atIso = ts(e.ago, 10, Math.min(59, n * 7));
      const event: ChainEventInput = {
        documentId: d.id,
        seq,
        kind: e.kind,
        actorUserId: e.actor,
        actorLabel: e.actor ? null : "Counterparty",
        payload: e.payload,
        at: atIso,
      };
      const hash = eventHash(prev, event);
      push("doc_event", {
        id: ctx.id("doc_event", d.id, seq),
        org_id: orgId,
        document_id: d.id,
        seq,
        kind: e.kind,
        actor_user_id: e.actor,
        actor_label: e.actor ? null : "Counterparty",
        payload: e.payload,
        prev_hash: prev,
        event_hash: hash,
        at: atIso,
        created_at: atIso,
      });
      prev = hash;
    }

    // ── workflow run and its steps ─────────────────────────────────────────
    if (d.workflowId && reached("review")) {
      const wfKey: WorkflowKey = d.spec.workflow!;
      const spec = WORKFLOW_SPECS[wfKey];
      const runId = ctx.id("doc_workflow_run", d.id);
      const running = d.status === "review" || d.status === "approval";
      const startedAgo = Math.max(1, d.createdAgo - 2);
      const finishedAgo = running ? null : Math.max(1, d.createdAgo - 6);
      push("doc_workflow_run", {
        id: runId,
        org_id: orgId,
        document_id: d.id,
        revision_id: d.rev1Id,
        workflow_id: d.workflowId,
        definition: { steps: spec.steps.map((s) => ({ ...s })) },
        status: running ? "running" : "completed",
        current_step_index: running ? (d.status === "review" ? 0 : 1) : spec.steps.length - 1,
        requires_signature: spec.steps.some((s) => s.kind === "signature"),
        outcome_note: running ? null : "Approved and issued.",
        started_by: users.admin,
        started_at: ts(startedAgo, 9),
        finished_at: finishedAgo === null ? null : ts(finishedAgo, 16),
        row_version: 1,
        created_by: users.admin,
        created_at: ts(startedAgo, 9),
        updated_at: ts(finishedAgo ?? startedAgo, 16),
      });
      for (const [si, step] of spec.steps.entries()) {
        const currentIndex = running ? (d.status === "review" ? 0 : 1) : spec.steps.length;
        const done = si < currentIndex;
        const active = si === currentIndex;
        const stepStatus = done ? "completed" : active ? "active" : "pending";
        const decided = done && step.kind === "approval";
        push("doc_workflow_step_run", {
          id: ctx.id("doc_workflow_step_run", d.id, step.id),
          org_id: orgId,
          run_id: runId,
          document_id: d.id,
          step_id: step.id,
          step_index: si,
          kind: step.kind,
          status: stepStatus,
          assignee_user_id:
            step.archetype === "owner"
              ? users.owner
              : step.archetype === "manager"
                ? users.manager
                : step.archetype === "admin"
                  ? users.admin
                  : null,
          assignee_archetype: step.archetype,
          approval_id: null,
          due_at: ts(Math.max(1, startedAgo - si * 2 - 5), 17),
          decided_by: done ? (step.archetype === "owner" ? users.owner : users.manager) : null,
          decided_at: done ? ts(Math.max(1, startedAgo - si * 2), 15) : null,
          decision: decided ? "approved" : null,
          note: done ? "Reviewed against the standard clause set; no changes required." : null,
          delegated_from: null,
          escalated_at: null,
          row_version: 1,
          created_by: users.admin,
          created_at: ts(startedAgo, 9),
          updated_at: ts(Math.max(1, startedAgo - si * 2), 15),
        });
      }
    }

    // ── the signature room ─────────────────────────────────────────────────
    if (d.spec.parties.length && issued && d.snapshotId) {
      const reqId = ctx.id("doc_signature_request", d.id);
      const createdAgo = Math.max(2, d.issuedAgo! - 1);
      const complete = reached("active");
      push("doc_signature_request", {
        id: reqId,
        org_id: orgId,
        document_id: d.id,
        snapshot_id: d.snapshotId,
        provider: "native",
        mode: "sequential",
        status: complete ? "completed" : "in_progress",
        message: "Please review and sign. This is a Pilot Lab document.",
        // A room still waiting on a signature has time left on it; a finished
        // one is allowed to have run out. Both satisfy expires_at > created_at.
        expires_at: complete ? ts(Math.max(0, createdAgo - 30), 12) : ts(-30, 12),
        completed_at: complete ? ts(Math.max(1, d.issuedAgo! - 3), 12) : null,
        cancelled_at: null,
        cancel_reason: null,
        row_version: 1,
        created_by: users.owner,
        created_at: ts(createdAgo, 12),
        updated_at: ts(complete ? Math.max(1, d.issuedAgo! - 3) : createdAgo, 12),
      });
      for (const [pi, party] of d.spec.parties.entries()) {
        const signerId = ctx.id("doc_signer", d.id, pi);
        const isMember = pi === 0;
        const signed = complete || (!complete && isMember);
        const signedAgo = Math.max(1, d.issuedAgo! - 2 - pi);
        push("doc_signer", {
          id: signerId,
          org_id: orgId,
          request_id: reqId,
          document_id: d.id,
          order_index: pi,
          party,
          party_kind: isMember ? "member" : "external",
          user_id: isMember ? users.owner : null,
          name: isMember
            ? (company.personas.find((p) => p.key === "owner")?.fullName ?? "Owner")
            : `${d.counterpartyLabel ?? "Counterparty"} signatory`,
          email: isMember ? null : `signer.${d.reference.toLowerCase()}@pilot-lab.invalid`,
          title: isMember ? "Managing Director" : "Authorised signatory",
          status: signed ? "signed" : "invited",
          // A hash of the id, not a usable token: nothing here can be signed
          // from outside, and the column is globally unique.
          token_hash: sha(`h33:signer:${signerId}`),
          token_expires_at: signed ? ts(Math.max(0, createdAgo - 30), 12) : ts(-30, 12),
          invited_at: ts(createdAgo, 12),
          delivery: isMember ? "in_app" : "link",
          viewed_at: ts(Math.max(1, createdAgo - 1), 13),
          signed_at: signed ? ts(signedAgo, 14) : null,
          declined_at: null,
          decline_reason: null,
          signature_kind: signed ? "typed" : null,
          signature_data: signed ? (isMember ? "Owner" : "Counterparty signatory") : null,
          evidence: signed ? { method: "typed", channel: isMember ? "in_app" : "link" } : null,
          evidence_hash: signed ? sha(`h33:evidence:${signerId}`) : null,
          reminder_count: signed ? 0 : 1,
          last_reminded_at: signed ? null : ts(Math.max(1, createdAgo - 5), 9),
          revoked_at: null,
          revoked_by: null,
          row_version: 1,
          created_by: users.owner,
          created_at: ts(createdAgo, 12),
          updated_at: ts(signed ? signedAgo : createdAgo, 14),
        });
      }
    }

    // ── review comments ────────────────────────────────────────────────────
    if (docs.indexOf(d) % 4 === 0) {
      const n = 1 + (docs.indexOf(d) % 3);
      for (let ci = 0; ci < n; ci++) {
        const resolved = ci === 0 && d.status !== "draft";
        const withSuggestion = ci === 1;
        push("doc_comment", {
          id: ctx.id("doc_comment", d.id, ci),
          org_id: orgId,
          document_id: d.id,
          revision_id: d.rev1Id,
          block_id: ci === 0 ? "c_scope" : "c_payment",
          parent_id: null,
          body: ar ? sentence(rng, "ar") : sentence(rng, "en"),
          author_user_id: ci % 2 === 0 ? users.manager : users.finance,
          mentions: ci === 0 ? [users.owner] : [],
          suggestion: withSuggestion
            ? { blockId: "c_payment", text: "Thirty days, not sixty." }
            : null,
          suggestion_status: withSuggestion
            ? d.status === "draft"
              ? "proposed"
              : "accepted"
            : null,
          resolved_at: resolved ? ts(Math.max(1, d.createdAgo - 3), 11) : null,
          resolved_by: resolved ? users.manager : null,
          removed_at: null,
          created_at: ts(Math.max(1, d.createdAgo - 1), 11),
          updated_at: ts(Math.max(1, d.createdAgo - 1), 11),
        });
      }
    }

    // ── obligations, the reason anyone opens a contract twice ──────────────
    if (d.spec.term && issued && d.status !== "archived") {
      const plans: Array<{
        kind: string;
        title: string;
        dueIn: number;
        status: string;
        money: boolean;
        risk: string | null;
      }> = [
        {
          kind: "renewal",
          title: "Renewal decision due",
          dueIn: 45 + (docs.indexOf(d) % 120),
          status: "open",
          money: false,
          risk: "medium",
        },
        {
          kind: "review",
          title: "Annual clause review",
          dueIn: -(20 + (docs.indexOf(d) % 40)),
          status: docs.indexOf(d) % 3 === 0 ? "open" : "done",
          money: false,
          risk: "low",
        },
        {
          kind: "payment",
          title: "Quarterly fee falls due",
          dueIn: -(5 + (docs.indexOf(d) % 15)),
          status: docs.indexOf(d) % 5 === 0 ? "waived" : "done",
          money: true,
          risk: null,
        },
      ];
      for (const [oi, p] of plans.entries()) {
        const dueOn = p.dueIn >= 0 ? clock.dayAhead(p.dueIn) : clock.dayAgo(-p.dueIn);
        const closed = p.status === "waived" || p.status === "cancelled";
        push("doc_obligation", {
          id: ctx.id("doc_obligation", d.id, oi),
          org_id: orgId,
          document_id: d.id,
          kind: p.kind,
          title: p.title,
          description: paragraph(rng, ar ? "ar" : "en", 1),
          clause_ref: p.kind === "renewal" ? "c_term" : p.kind === "payment" ? "c_payment" : null,
          side: p.kind === "payment" ? "ours" : "theirs",
          owner_user_id: d.ownerUserId,
          due_on: dueOn,
          recurrence_months: p.kind === "payment" ? 3 : p.kind === "review" ? 12 : null,
          amount_cents: p.money ? 250000 + (docs.indexOf(d) % 40) * 5000 : null,
          currency: p.money ? company.currency : null,
          risk_level: p.risk,
          requires_evidence: p.kind !== "renewal",
          status: p.status,
          completed_at: p.status === "done" ? ts(Math.max(1, -p.dueIn - 2), 13) : null,
          completed_by: p.status === "done" ? d.ownerUserId : null,
          evidence_note:
            p.status === "done" ? "Completed and filed against the contract record." : null,
          evidence_file_id: null,
          closed_reason: closed
            ? "Waived: the counterparty absorbed the charge this quarter."
            : null,
          escalated_to: null,
          escalated_at: null,
          source: "template",
          linked_record_type: d.recordType === "job" ? "job" : null,
          linked_record_id: d.recordType === "job" ? d.recordId : null,
          reminders_sent: [],
          row_version: 1,
          created_by: users.admin,
          created_at: ts(d.issuedAgo!, 12),
          updated_at: ts(d.issuedAgo!, 12),
        });
      }
    }

    // ── public forms ───────────────────────────────────────────────────────
    if (d.spec.category === "form" && issued && d.snapshotId) {
      const linkId = ctx.id("doc_form_link", d.id);
      const createdAgo = d.issuedAgo!;
      const uses = 1 + (docs.indexOf(d) % 4);
      push("doc_form_link", {
        id: linkId,
        org_id: orgId,
        document_id: d.id,
        snapshot_id: d.snapshotId,
        label: "Site gate — visitor request",
        token_hash: sha(`h33:formlink:${linkId}`),
        // Still live, so the share screen has a working link to show.
        expires_at: ts(-90, 12),
        max_uses: 100,
        use_count: uses,
        revoked_at: null,
        revoked_by: null,
        last_used_at: ts(Math.max(1, createdAgo - 30), 8),
        created_by: users.admin,
        created_at: ts(createdAgo, 12),
      });
      for (let si = 0; si < uses; si++) {
        const st = si === 0 ? "converted" : si === 1 ? "reviewed" : "received";
        push("doc_form_submission", {
          id: ctx.id("doc_form_submission", d.id, si),
          org_id: orgId,
          document_id: d.id,
          link_id: linkId,
          snapshot_id: d.snapshotId,
          answers: {
            visitor_name: `Visitor ${si + 1}`,
            visit_date: clock.dayAgo(Math.max(1, createdAgo - 30 - si)),
            visit_reason: ["Delivery", "Inspection", "Maintenance"][si % 3],
            induction_done: true,
          },
          submitter_name: `Visitor ${si + 1}`,
          submitter_email: `visitor${si + 1}.${d.reference.toLowerCase()}@pilot-lab.invalid`,
          submitted_at: ts(Math.max(1, createdAgo - 30 - si), 8),
          ip: null,
          user_agent: null,
          status: st,
          reviewed_by: st === "received" ? null : users.admin,
          reviewed_at: st === "received" ? null : ts(Math.max(1, createdAgo - 29 - si), 9),
          review_note: st === "received" ? null : "Checked against the visitor log.",
          converted_record_type: st === "converted" && d.recordId ? "job" : null,
          converted_record_id: st === "converted" && d.recordId ? d.recordId : null,
          created_at: ts(Math.max(1, createdAgo - 30 - si), 8),
          updated_at: ts(Math.max(1, createdAgo - 29 - si), 9),
        });
      }
    }
  }

  // ── saved views ───────────────────────────────────────────────────────────
  const views: Array<{ name: string; config: Row; shared: boolean; by: string }> = [
    {
      name: "Expiring in 90 days",
      config: { status: ["active"], expiresWithinDays: 90, sort: "expires_at" },
      shared: true,
      by: users.manager,
    },
    {
      name: "Waiting on me",
      config: { workflowAssignee: "me", status: ["review", "approval"] },
      shared: false,
      by: users.owner,
    },
    {
      name: "Out for signature",
      config: { status: ["signature"], sort: "issued_at" },
      shared: true,
      by: users.admin,
    },
    {
      name: "Overdue obligations",
      config: { obligationStatus: ["open"], dueBefore: "today" },
      shared: true,
      by: users.finance,
    },
  ];
  for (const [i, v] of views.entries())
    push("doc_saved_view", {
      id: ctx.id("doc_saved_view", i),
      org_id: orgId,
      name: v.name,
      config: v.config,
      is_shared: v.shared,
      created_by: v.by,
      removed_at: null,
      created_at: ts(300 - i * 10, 9),
      updated_at: ts(300 - i * 10, 9),
    });

  push("reference_sequence", { org_id: orgId, scope_key: "document", next_value: total + 1 });

  const tableCounts = Object.fromEntries(
    DOCSTUDIO_TABLES.map((t) => [t, rows[t].length]),
  ) as Record<DocstudioTable, number>;

  const model: DocstudioModel = { workflows, templates, docs, rows, notes, tableCounts };
  MODELS.set(memoKey, model);
  return model;
}

/**
 * Point every document at its working revision and its issued snapshot, in one
 * statement. Up to a few hundred documents a company; one round trip.
 */
async function linkDocuments(ctx: LabContext, m: DocstudioModel): Promise<number> {
  const links = m.docs
    .map((d) => ({
      id: d.id,
      wr: d.issuedAgo !== null ? d.rev2Id : d.rev1Id,
      sn: d.snapshotId,
    }))
    .filter((x) => x.wr !== null || x.sn !== null);
  if (!links.length) return 0;
  const res = await ctx.sql.unsafe(
    `update public.doc_document d
        set working_revision_id = v.wr, issued_snapshot_id = v.sn
       from json_to_recordset($1::text::json) as v(id uuid, wr uuid, sn uuid)
      where d.id = v.id and d.org_id = $2`,
    [JSON.stringify(links), ctx.orgId] as never[],
  );
  return res.count ?? links.length;
}

export function planDocstudio(ctx: LabContext): FamilyPlan {
  const m = buildDocstudio(ctx);
  return { family: "docstudio", expected: { ...m.tableCounts } };
}

export async function seedDocstudio(ctx: LabContext): Promise<FamilyReport> {
  const m = buildDocstudio(ctx);
  const counts: Record<string, number> = {};
  for (const table of DOCSTUDIO_TABLES) {
    const r = await ctx.insert(
      table,
      m.rows[table],
      table === "reference_sequence" ? SEQ_CONFLICT : undefined,
    );
    counts[table] = r.attempted;
    if (m.rows[table].length) ctx.log(`${table}: ${r.attempted} rows`);
  }
  if (docstudioRuntime.live && !ctx.dryRun) {
    const linked = await linkDocuments(ctx, m);
    ctx.log(`doc_document: ${linked} linked to their revision and snapshot`);
  }
  return {
    family: "docstudio",
    counts,
    handoff: {
      documentIds: m.docs.map((d) => d.id),
      activeDocumentIds: m.docs.filter((d) => d.status === "active").map((d) => d.id),
      templateIds: m.templates.map((t) => t.id),
      workflowIds: Object.values(m.workflows),
    },
    notes: m.notes,
  };
}

export const docstudio: Family = {
  key: "docstudio",
  deps: ["setup", "people", "masters", "work"],
  appliesTo: (c) => c.profile.enables.docstudio,
  plan: planDocstudio,
  seed: seedDocstudio,

  async verify(ctx): Promise<Check[]> {
    const m = buildDocstudio(ctx);
    const org = ctx.orgId;
    const checks: Check[] = [];
    const count = async (table: string, where = ""): Promise<number> => {
      const [r] = (await ctx.sql.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1 ${where}`,
        [org] as never[],
      )) as unknown as Array<{ n: number }>;
      return r!.n;
    };
    const violators = async (name: string, sqlText: string) => {
      const [r] = (await ctx.sql.unsafe(sqlText, [org] as never[])) as unknown as Array<{
        n: number;
      }>;
      checks.push({ name, ok: r!.n === 0, detail: `${r!.n} violating rows` });
    };

    for (const t of DOCSTUDIO_TABLES) {
      const n = await count(t);
      const want = m.tableCounts[t];
      const ok = t === "reference_sequence" ? n >= want : n === want;
      checks.push({ name: `count ${t}`, ok, detail: `${n} live vs ${want} planned` });
    }

    await violators(
      "every issued document has a snapshot",
      `select count(*)::int as n from public.doc_document d
       where d.org_id = $1 and d.issued_at is not null
         and not exists (select 1 from public.doc_snapshot s where s.document_id = d.id and s.org_id = d.org_id)`,
    );
    await violators(
      "no unissued document carries a snapshot",
      `select count(*)::int as n from public.doc_document d
       where d.org_id = $1 and d.issued_at is null and d.issued_snapshot_id is not null`,
    );
    await violators(
      "the event chain has no sequence gap",
      `select count(*)::int as n from (
         select document_id from public.doc_event where org_id = $1
         group by document_id having max(seq) <> count(*) or min(seq) <> 1
       ) x`,
    );
    await violators(
      "every event links to the hash before it",
      `select count(*)::int as n from public.doc_event e
       join public.doc_event p on p.document_id = e.document_id and p.org_id = e.org_id and p.seq = e.seq - 1
       where e.org_id = $1 and e.prev_hash <> p.event_hash`,
    );
    await violators(
      "the first event of every document starts from genesis",
      `select count(*)::int as n from public.doc_event
       where org_id = $1 and seq = 1 and prev_hash <> repeat('0', 64)`,
    );
    await violators(
      "supersession is mutual",
      `select count(*)::int as n from public.doc_document a
       where a.org_id = $1 and a.superseded_by_document_id is not null
         and not exists (select 1 from public.doc_document b
                         where b.id = a.superseded_by_document_id and b.org_id = a.org_id
                           and b.supersedes_document_id = a.id)`,
    );
    await violators(
      "a signed signer carries signed_at and evidence",
      `select count(*)::int as n from public.doc_signer
       where org_id = $1 and status = 'signed' and (signed_at is null or evidence_hash is null)`,
    );
    await violators(
      "every external signer address is .invalid",
      `select count(*)::int as n from public.doc_signer
       where org_id = $1 and email is not null and email not like '%@pilot-lab.invalid'`,
    );
    await violators(
      "a frozen revision carries its content hash",
      `select count(*)::int as n from public.doc_revision
       where org_id = $1 and state = 'frozen' and (frozen_at is null or content_hash is null)`,
    );
    await violators(
      "no obligation is done without a completion time",
      `select count(*)::int as n from public.doc_obligation
       where org_id = $1 and ((status = 'done') <> (completed_at is not null))`,
    );

    const overdue = await count("doc_obligation", `and status = 'open' and due_on < current_date`);
    checks.push({
      name: "the obligations list has something genuinely overdue to show",
      ok: overdue > 0,
      detail: `${overdue} open and past due`,
    });
    const upcoming = await count(
      "doc_obligation",
      `and status = 'open' and due_on >= current_date`,
    );
    checks.push({
      name: "the obligations list has something upcoming to show",
      ok: upcoming > 0,
      detail: `${upcoming} open and ahead`,
    });

    return checks;
  },
};
