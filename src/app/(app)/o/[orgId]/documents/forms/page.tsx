import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { listDocuments, listSubmissions, listTemplates } from "@/modules/docstudio/service";
import { SubmissionsInbox, type SubmissionsDict } from "./SubmissionsInbox";

/** H26 — forms: every form document, its links, and the submissions waiting for a reviewer. */
export default async function FormsPage({ params }: { params: Promise<{ orgId: string }> }) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.forms.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const [forms, submissions, templates] = await Promise.all([
    listDocuments(resolved.ctx, resolved.archetype, { category: ["form"], limit: 200 }),
    listSubmissions(resolved.ctx, resolved.archetype, { limit: 300 }),
    listTemplates(resolved.ctx, resolved.archetype),
  ]);
  const k = (key: string) => t(`docstudio.fm.${key}`);
  const dict: SubmissionsDict = {
    title: k("title"),
    subtitle: k("subtitle"),
    forms: k("forms"),
    noForms: k("no_forms"),
    newForm: k("new_form"),
    open: t("docstudio.tpl.open"),
    submissions: k("submissions"),
    noSubmissions: k("no_submissions"),
    status: Object.fromEntries(
      ["received", "reviewed", "converted", "discarded"].map((s) => [s, k(`status.${s}`)]),
    ),
    docStatus: Object.fromEntries(
      [
        "draft",
        "review",
        "approval",
        "signature",
        "active",
        "expired",
        "terminated",
        "superseded",
        "archived",
      ].map((s) => [s, t(`docstudio.status.${s}`)]),
    ),
    submittedAt: k("submitted_at"),
    from: k("from"),
    answers: k("answers"),
    markReviewed: k("mark_reviewed"),
    discard: k("discard"),
    convert: k("convert"),
    convertTitle: k("convert_title"),
    convertHint: k("convert_hint"),
    target: k("target"),
    targets: {
      customer: k("target.customer"),
      lead: k("target.lead"),
      document: k("target.document"),
    },
    mapping: k("mapping"),
    mapField: k("map_field"),
    fromAnswer: k("from_answer"),
    template: t("docstudio.field.template"),
    docTitle: t("docstudio.field.title"),
    note: t("docstudio.ws.note"),
    confirm: t("docstudio.ws.confirm"),
    cancel: t("docstudio.cancel"),
    close: t("docstudio.ws.close"),
    converted: k("converted"),
    showAll: k("show_all"),
    saved: t("docstudio.saved"),
    failed: t("docstudio.failed"),
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {t("docstudio.back")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink">{dict.title}</h1>
        <p className="text-sm text-ink-muted">{dict.subtitle}</p>
      </div>
      <SubmissionsInbox
        orgId={orgId}
        locale={locale}
        forms={forms.rows.map((f) => ({
          id: f.id,
          reference: f.reference,
          title: f.title,
          status: f.effectiveStatus,
        }))}
        submissions={submissions}
        templates={templates
          .filter((x) => x.status === "published")
          .map((x) => ({
            value: x.builtIn ? x.key : (x.id as string),
            label: locale === "ar" ? x.nameAr : x.nameEn,
          }))}
        dict={dict}
      />
    </div>
  );
}
