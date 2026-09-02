import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import {
  DOC_CATEGORIES,
  DOC_STATUSES,
  listDocViews,
  listDocuments,
  listFolders,
  listTags,
} from "@/modules/docstudio/service";
import { DocumentsHome, type HomeDict } from "./DocumentsHome";

const WINDOW = 500;

/** H26 — the Document Command Centre: what needs attention, and the library. */
export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; view?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const [docs, folders, tags, views] = await Promise.all([
    listDocuments(resolved.ctx, resolved.archetype, { limit: WINDOW, includeArchived: true }),
    listFolders(resolved.ctx, resolved.archetype),
    listTags(resolved.ctx, resolved.archetype),
    listDocViews(resolved.ctx, resolved.archetype),
  ]);
  const dict: HomeDict = {
    status: Object.fromEntries(DOC_STATUSES.map((s) => [s, t(`docstudio.status.${s}`)])),
    category: Object.fromEntries(DOC_CATEGORIES.map((c) => [c, t(`docstudio.category.${c}`)])),
    counterparty: {
      customer: t("docstudio.counterparty.customer"),
      supplier: t("docstudio.counterparty.supplier"),
      employee: t("docstudio.counterparty.employee"),
      other: t("docstudio.counterparty.other"),
    },
    kpi: {
      drafts: t("docstudio.kpi.drafts"),
      review: t("docstudio.kpi.review"),
      signature: t("docstudio.kpi.signature"),
      active: t("docstudio.kpi.active"),
      expiring: t("docstudio.kpi.expiring"),
      window: t("docstudio.kpi.window", { n: WINDOW }),
    },
    filter: {
      search: t("docstudio.filter.search"),
      status: t("docstudio.filter.status"),
      category: t("docstudio.filter.category"),
      folder: t("docstudio.filter.folder"),
      tag: t("docstudio.filter.tag"),
      all: t("docstudio.filter.all"),
      clear: t("docstudio.filter.clear"),
      noFolder: t("docstudio.field.no_folder"),
    },
    layout: {
      list: t("docstudio.layout.list"),
      board: t("docstudio.layout.board"),
      timeline: t("docstudio.layout.timeline"),
      graph: t("docstudio.layout.graph"),
    },
    views: {
      title: t("docstudio.views.title"),
      save: t("docstudio.views.save"),
      name: t("docstudio.views.name"),
      shared: t("docstudio.views.shared"),
      remove: t("docstudio.views.remove"),
    },
    columns: {
      reference: t("docstudio.columns.reference"),
      title: t("docstudio.columns.title"),
      status: t("docstudio.columns.status"),
      counterparty: t("docstudio.columns.counterparty"),
      updated: t("docstudio.columns.updated"),
      expires: t("docstudio.columns.expires"),
    },
    empty: {
      title: t("docstudio.empty.title"),
      body: t("docstudio.empty.body"),
      filtered: t("docstudio.empty.filtered"),
    },
    timelineNone: t("docstudio.timeline.none"),
    newDocument: t("docstudio.new"),
    saved: t("docstudio.saved"),
    failed: t("docstudio.failed"),
    cancel: t("docstudio.cancel"),
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("docstudio.title")}</h1>
          <p className="text-sm text-ink-muted">{t("docstudio.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can(resolved.archetype, "documents.templates.manage") ? (
            <Link
              href={`/o/${orgId}/documents/templates`}
              className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-sunken"
            >
              {t("docstudio.templates")}
            </Link>
          ) : null}
          <Link
            href={`/o/${orgId}/documents/obligations`}
            className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-sunken"
          >
            {t("docstudio.obligations")}
          </Link>
          {can(resolved.archetype, "documents.create") ? (
            <Link href={`/o/${orgId}/documents/new`}>
              <Button>{t("docstudio.new")}</Button>
            </Link>
          ) : null}
        </div>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}
      <DocumentsHome
        orgId={orgId}
        locale={locale}
        rows={docs.rows}
        total={docs.total}
        folders={folders}
        tags={tags}
        views={views}
        initialViewId={sp.view ?? null}
        canCreate={can(resolved.archetype, "documents.create")}
        dict={dict}
      />
    </div>
  );
}
