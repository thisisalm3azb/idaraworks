/**
 * Documents (H22.0) — one place that turns a business record into a rendered
 * document, and one place that decides who may see it.
 *
 * Every document type resolves through `documentModel()`, so preview, print,
 * PDF and a share link are the same bytes produced by the same code. Adding a
 * document type means adding a builder here, not a new rendering stack.
 *
 * Identity rule, from 003B.1 and enforced below: a DRAFT renders from the
 * organization's current identity, because it is a working copy that should
 * show today's letterhead. An ISSUED document renders from the snapshot taken
 * when it was issued, so changing the logo, address, tax number or legal name
 * tomorrow cannot rewrite what a customer already received.
 */
import { createHash, randomBytes } from "node:crypto";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError, type Action } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import {
  captureIssuerSnapshot,
  renderDocument,
  type DocLanguage,
  type DocumentRenderModel,
} from "@/platform/documents";
import { getDocumentProfile } from "@/modules/branding/service";
import { resolveIssuer } from "./issuer-resolve";
import { getQuote } from "@/modules/quotes/service";
import { getInvoice } from "@/modules/invoices/service";
import { formatDate, formatMoney } from "@/platform/format";

export const DOCUMENT_KINDS = ["quote", "invoice", "week_plan"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Reading a document requires the permission for the record behind it. */
const VIEW_ACTION: Record<DocumentKind, Action> = {
  quote: "quotes.view",
  invoice: "invoices.view",
  week_plan: "week.view",
};

export class DocumentNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`no ${kind} document for ${id}`);
    this.name = "DocumentNotFoundError";
  }
}

/**
 * Which documents may be handed to someone outside the organization.
 *
 * A quotation or an invoice is ADDRESSED to one customer: sending it to that
 * customer is the whole point, and it contains only their own commercial terms.
 *
 * A weekly work plan is neither. It renders employee names against tasks, and
 * it covers every job that week, which in a business serving more than one
 * customer means one customer's link would show them another's job references,
 * names and schedule. That is a disclosure, not a feature, so no share link can
 * be minted for one and the public route refuses the kind outright.
 */
export const SHAREABLE_KINDS = ["quote", "invoice"] as const;
export type ShareableKind = (typeof SHAREABLE_KINDS)[number];

const isShareable = (kind: DocumentKind): kind is ShareableKind =>
  (SHAREABLE_KINDS as readonly string[]).includes(kind);

export class DocumentNotShareableError extends Error {
  constructor(kind: string) {
    super(`a ${kind} document cannot be shared outside the organization`);
    this.name = "DocumentNotShareableError";
  }
}

/** Statuses at which a record is formal and must carry a snapshot. */
const ISSUED_STATUSES: Record<DocumentKind, readonly string[]> = {
  quote: ["sent", "accepted", "converted", "converting", "rejected", "expired"],
  invoice: ["issued", "partially_paid", "paid", "cancelled"],
  week_plan: ["issued", "revised", "cancelled"],
};

const WATERMARK_FOR: Record<string, "draft" | "cancelled" | "void" | null> = {
  draft: "draft",
  pending_approval: "draft",
  approved: "draft",
  cancelled: "cancelled",
  rejected: "cancelled",
  expired: "void",
};

export type DocumentContext = {
  kind: DocumentKind;
  id: string;
  language: DocLanguage;
};

const t = (language: DocLanguage, en: string, ar: string) => (language === "en" ? en : ar);

/** A bilingual document formats its dates and money in the Arabic column's
 *  locale; "bilingual" is a layout, not a third date format. */
const dateLocale = (language: DocLanguage): "en" | "ar" => (language === "en" ? "en" : "ar");

/** The currency union the money formatter accepts. */
type Currency = Parameters<typeof formatMoney>[1];

async function quoteModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const q = await getQuote(ctx, archetype, id);
  if (!q) throw new DocumentNotFoundError("quote", id);
  const [row] = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select issuer_snapshot, status from public.quote
      where id = ${id} and org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<{ issuer_snapshot: unknown; status: string }>;
  const issued = ISSUED_STATUSES.quote.includes(row?.status ?? "");
  const { issuer, notice } = await resolveIssuer(ctx, row?.issuer_snapshot, issued);
  const money = (minor: number | null) =>
    minor == null ? null : formatMoney(minor, q.currency as Currency, { locale: "en" });

  return {
    kind: "quote",
    language,
    issuer,
    recipient: q.customerName ? { name: q.customerName } : null,
    titleEn: "Quotation",
    titleAr: "عرض سعر",
    reference: q.reference,
    dateText: q.createdAt
      ? formatDate(q.createdAt.slice(0, 10), { locale: dateLocale(language) })
      : undefined,
    statusText: q.status,
    watermark: WATERMARK_FOR[q.status] ?? null,
    noticeText: notice,
    fields: q.validUntil
      ? [
          {
            label: t(language, "Valid until", "صالح حتى"),
            value: formatDate(q.validUntil, { locale: dateLocale(language) }),
            ltr: true,
          },
        ]
      : [],
    sections: [
      {
        columns: [
          "#",
          t(language, "Description", "الوصف"),
          t(language, "Qty", "الكمية"),
          t(language, "Unit price", "سعر الوحدة"),
          t(language, "Amount", "المبلغ"),
        ],
        lines: q.lines.map((l, i) => ({
          position: String(i + 1),
          description: l.description,
          quantity: String(l.qty),
          unit: l.unit,
          unitPrice: money(l.unitPriceMinor),
          amount: money(l.lineTotalMinor),
        })),
        emptyText: t(language, "No items.", "لا توجد بنود."),
      },
    ],
    totals: [
      { label: t(language, "Subtotal", "المجموع الفرعي"), value: money(q.subtotalMinor) ?? "" },
      ...(q.vatAmountMinor
        ? [{ label: t(language, "VAT", "ضريبة القيمة المضافة"), value: money(q.vatAmountMinor)! }]
        : []),
      { label: t(language, "Total", "الإجمالي"), value: money(q.totalMinor) ?? "", strong: true },
    ],
    termsTitle: t(language, "Terms", "الشروط"),
    terms: q.terms,
    showSignatory: true,
  };
}

async function invoiceModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const inv = await getInvoice(ctx, archetype, id);
  if (!inv) throw new DocumentNotFoundError("invoice", id);
  const [row] = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select issuer_snapshot, status from public.invoice
      where id = ${id} and org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<{ issuer_snapshot: unknown; status: string }>;
  const issued = ISSUED_STATUSES.invoice.includes(row?.status ?? "");
  const { issuer, notice } = await resolveIssuer(ctx, row?.issuer_snapshot, issued);
  const money = (minor: number | null) =>
    minor == null ? null : formatMoney(minor, inv.currency as Currency, { locale: "en" });
  const isCredit = inv.kind === "credit_note";

  return {
    kind: "invoice",
    language,
    issuer,
    recipient: inv.customerName
      ? { name: inv.customerName, trn: inv.customerTaxRegNo ?? null }
      : null,
    titleEn: isCredit ? "Credit note" : "Tax invoice",
    titleAr: isCredit ? "إشعار دائن" : "فاتورة ضريبية",
    reference: inv.reference,
    dateText: inv.issuedAt
      ? formatDate(inv.issuedAt.slice(0, 10), { locale: dateLocale(language) })
      : undefined,
    statusText: inv.status,
    watermark: isCredit ? "credit" : (WATERMARK_FOR[inv.status] ?? null),
    noticeText: notice,
    fields: inv.dueDate
      ? [
          {
            label: t(language, "Due date", "تاريخ الاستحقاق"),
            value: formatDate(inv.dueDate, { locale: dateLocale(language) }),
            ltr: true,
          },
        ]
      : [],
    sections: [
      {
        columns: [
          "#",
          t(language, "Description", "الوصف"),
          t(language, "Qty", "الكمية"),
          t(language, "Unit price", "سعر الوحدة"),
          t(language, "Amount", "المبلغ"),
        ],
        lines: inv.lines.map((l, i) => ({
          position: String(i + 1),
          description: l.description,
          quantity: String(l.qty),
          unit: l.unit,
          unitPrice: money(l.unitPriceMinor),
          amount: money(l.lineTotalMinor),
        })),
        emptyText: t(language, "No items.", "لا توجد بنود."),
      },
    ],
    totals: [
      { label: t(language, "Subtotal", "المجموع الفرعي"), value: money(inv.subtotalMinor) ?? "" },
      ...(inv.vatAmountMinor
        ? [{ label: t(language, "VAT", "ضريبة القيمة المضافة"), value: money(inv.vatAmountMinor)! }]
        : []),
      {
        label: t(language, "Total", "الإجمالي"),
        value: money(inv.totalMinor) ?? "",
        strong: true,
      },
    ],
    showSignatory: false,
    showPaymentInstructions: true,
  };
}

/** Build the render model for any supported document. */
export async function documentModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  doc: DocumentContext,
): Promise<DocumentRenderModel> {
  assertCan(archetype, VIEW_ACTION[doc.kind]);
  switch (doc.kind) {
    case "quote":
      return quoteModel(ctx, archetype, doc.id, doc.language);
    case "invoice":
      return invoiceModel(ctx, archetype, doc.id, doc.language);
    case "week_plan": {
      const { weekPlanModel } = await import("./week-plan-document");
      return weekPlanModel(ctx, archetype, doc.id, doc.language);
    }
  }
}

/** Model to HTML, for preview, print and the share page. */
export async function documentHtml(
  ctx: Ctx,
  archetype: RoleArchetype,
  doc: DocumentContext,
): Promise<string> {
  return renderDocument(await documentModel(ctx, archetype, doc));
}

/**
 * Capture the issuer snapshot onto a record as it becomes formal.
 *
 * Runs INSIDE the caller's transaction, and only when no snapshot exists yet:
 * re-issuing must never rewrite the identity a document already went out with.
 */
export async function captureDocumentIssuerIn(
  tx: TenantTx,
  ctx: Ctx,
  table: "quote" | "invoice" | "week_plan",
  id: string,
): Promise<void> {
  const profile = await getDocumentProfile(ctx);
  const snapshot = captureIssuerSnapshot(profile.identity, new Date().toISOString());
  await tx.execute(sql`
    update public.${sql.raw(table)}
    set issuer_snapshot = ${JSON.stringify(snapshot)}::jsonb
    where id = ${id} and org_id = ${ctx.orgId} and issuer_snapshot is null
  `);
}

// ── Sharing ─────────────────────────────────────────────────────────────────

/** 32 bytes of randomness, base64url. Guessing one is not a realistic attack. */
function newShareToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

export const SHARE_MAX_DAYS = 90;

/**
 * Create a share link. The plaintext token is returned ONCE and never stored:
 * only its SHA-256 lives in the database, so a leaked backup is not a set of
 * working document URLs.
 */
export async function createDocumentShare(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: { kind: DocumentKind; id: string; days: number },
): Promise<{ token: string; expiresAt: string }> {
  assertCan(archetype, VIEW_ACTION[input.kind]);
  // Sharing sends a document outside the organization; viewing it internally is
  // not the same act, so it carries its own permission.
  assertCan(archetype, "documents.share");
  // Permission is not enough: some documents must never leave, whoever asks.
  if (!isShareable(input.kind)) throw new DocumentNotShareableError(input.kind);
  /*
   * The public route renders a shared document with pricePrivileged: true, which
   * is right for the customer the quotation is addressed to and wrong as an
   * escape hatch. Without this, a member whose price visibility is off could
   * mint a link and then read, through that link, the money the application
   * refuses to show them in the app. Minting is the only place this can be
   * stopped, because by the time the link is opened there is no member left.
   */
  if (!ctx.pricePrivileged) throw new ForbiddenError("documents.share");
  const days = Math.min(Math.max(Math.trunc(input.days), 1), SHARE_MAX_DAYS);
  const { raw, hash } = newShareToken();

  const expiresAt = await command<{ expiresAt: string; shareId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "document.share",
        entityType: "document_share" as const,
        entityId: r.shareId,
        // The token is never written to the audit trail.
        summary: `Shared ${input.kind} ${input.id} until ${r.expiresAt.slice(0, 10)}`,
      }),
    },
    async (tx) => {
      const [row] = (await tx.execute(sql`
        insert into public.document_share
          (org_id, subject_type, subject_id, token_hash, expires_at, created_by)
        values (${ctx.orgId}, ${input.kind}, ${input.id}, ${hash},
                now() + (${days}::int * interval '1 day'), ${ctx.userId})
        returning id::text as id, expires_at::text as expires_at
      `)) as unknown as Array<{ id: string; expires_at: string }>;
      return { expiresAt: row!.expires_at, shareId: row!.id };
    },
  );
  return { token: raw, expiresAt: expiresAt.expiresAt };
}

export async function revokeDocumentShare(
  ctx: Ctx,
  archetype: RoleArchetype,
  shareId: string,
): Promise<void> {
  assertCan(archetype, "documents.share");
  await command(
    ctx,
    {
      audit: {
        action: "document.share_revoke",
        entityType: "document_share",
        entityId: shareId,
        summary: "Revoked a document share link",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.document_share
        set revoked_at = now(), revoked_by = ${ctx.userId}
        where id = ${shareId} and org_id = ${ctx.orgId} and revoked_at is null
      `),
  );
}

export type DocumentShareRow = {
  id: string;
  kind: DocumentKind;
  expiresAt: string;
  revokedAt: string | null;
  /** Decided by the database, not the app server: the resolver that actually
   * refuses an expired link applies the same clock, so the list cannot show
   * "active" for a link the public route has already stopped serving. */
  expired: boolean;
  viewCount: number;
  createdAt: string;
};

export async function listDocumentShares(
  ctx: Ctx,
  archetype: RoleArchetype,
  kind: DocumentKind,
  id: string,
): Promise<DocumentShareRow[]> {
  assertCan(archetype, VIEW_ACTION[kind]);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, subject_type, expires_at::text as expires_at,
             revoked_at::text as revoked_at, (expires_at <= now()) as expired,
             view_count, created_at::text as created_at
      from public.document_share
      where org_id = ${ctx.orgId} and subject_type = ${kind} and subject_id = ${id}
      -- Live links first: the cap must fall on dead rows, never on a link
      -- someone still needs to revoke. Ordering by age alone hid the only
      -- control for revoking once an org had 50 expired shares on a record.
      order by (revoked_at is null and expires_at > now()) desc, created_at desc
      limit 50
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.subject_type as DocumentKind,
    expiresAt: r.expires_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    expired: r.expired === true,
    viewCount: Number(r.view_count ?? 0),
    createdAt: r.created_at as string,
  }));
}

/**
 * Resolve a share token for the PUBLIC page. No Ctx: the caller is not signed
 * in and belongs to no organization, so the lookup runs through the SECURITY
 * DEFINER resolver, which applies expiry and revocation itself.
 *
 * Returns null for unknown, expired and revoked alike — the caller renders one
 * identical page for all three so a token cannot be probed.
 */
export async function resolveDocumentShare(rawToken: string): Promise<{
  orgId: string;
  kind: DocumentKind;
  id: string;
} | null> {
  if (!rawToken || rawToken.length < 32 || rawToken.length > 128) return null;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const { createAppDb } = await import("@/platform/tenancy");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select org_id::text as org_id, subject_type, subject_id::text as subject_id
      from app.resolve_document_share(${hash})
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const kind = rows[0].subject_type as DocumentKind;
    // Second gate, independent of the one that mints links: a row for a kind
    // that must not leave resolves to nothing, so a share created before this
    // rule existed, or by any future path that forgets it, still serves nobody.
    if (!isShareable(kind)) return null;
    await db.execute(sql`select app.record_document_share_view(${hash})`).catch(() => undefined);
    return {
      orgId: rows[0].org_id as string,
      kind,
      id: rows[0].subject_id as string,
    };
  } finally {
    await end();
  }
}

export { ForbiddenError };

/**
 * The weekly work plan is part of this module, and service.ts is the module's
 * only door (BUILD_BIBLE §3.3), so its API is re-exported here rather than
 * imported from week-plan.ts by pages and actions.
 */
export {
  WEEK_PLAN_STATUSES,
  WeekPlanImmutableError,
  WeekPlanReasonRequiredError,
  weekStartOf,
  listWeekPlans,
  listWeekPlanJobIds,
  listWeekPlanPickerJobs,
  MAX_WEEK_PLAN_JOBS,
  WeekPlanTooManyJobsError,
  getWeekPlan,
  createWeekPlan,
  setWeekPlanJobs,
  updateWeekPlan,
  issueWeekPlan,
  reviseWeekPlan,
  cancelWeekPlan,
  type WeekPlanStatus,
  type WeekPlanRow,
  type PickerJob,
} from "./week-plan";
