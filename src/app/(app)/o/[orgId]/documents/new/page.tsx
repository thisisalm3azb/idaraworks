import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can, ForbiddenError } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { listCustomers, listEmployees, listSuppliers } from "@/modules/masters/service";
import { listQuotes } from "@/modules/quotes/service";
import { listInvoices } from "@/modules/invoices/service";
import { listJobs } from "@/modules/jobs/service";
import {
  DOC_CATEGORIES,
  DOC_LANGUAGES,
  listFolders,
  listTemplates,
} from "@/modules/docstudio/service";
import { createDocumentAction } from "../studio-actions";
import { NewDocumentForm } from "./NewDocumentForm";

async function guarded<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenError) return fallback;
    throw err;
  }
}

/** H26 — create a document from a template or a blank page. */
export default async function NewDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; template?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.create")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const { ctx, archetype } = resolved;
  const [templates, folders, customers, suppliers, employees, quotes, invoices, jobs] =
    await Promise.all([
      listTemplates(ctx, archetype),
      listFolders(ctx, archetype),
      guarded(() => listCustomers(ctx, archetype, { limit: 200 }), []),
      guarded(() => listSuppliers(ctx, archetype, { limit: 200 }), { rows: [], hasMore: false }),
      guarded(() => listEmployees(ctx, archetype), []),
      guarded(() => listQuotes(ctx, archetype, { limit: 100 }), []),
      guarded(() => listInvoices(ctx, archetype, { limit: 100 }), []),
      guarded(() => listJobs(ctx, archetype, { limit: 100 }), {
        rows: [],
        hasMore: false,
        total: 0,
      }),
    ]);
  const create = createDocumentAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {t("docstudio.back")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink">{t("docstudio.new")}</h1>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}
      <Card>
        <NewDocumentForm
          action={create}
          initialTemplate={sp.template ?? "blank"}
          templates={templates
            .filter((x) => x.status === "published")
            .map((x) => ({
              value: x.builtIn ? x.key : (x.id as string),
              label: `${locale === "ar" ? x.nameAr : x.nameEn}${x.builtIn ? ` · ${t("docstudio.builtin")}` : ""}`,
              category: x.category,
              language: x.language,
            }))}
          folders={folders.map((f) => ({ id: f.id, name: f.name }))}
          categories={DOC_CATEGORIES.map((c) => ({
            value: c,
            label: t(`docstudio.category.${c}`),
          }))}
          languages={DOC_LANGUAGES.map((l) => ({ value: l, label: t(`docstudio.language.${l}`) }))}
          counterparties={{
            customer: customers.map((c) => ({ id: c.id, label: c.name })),
            supplier: suppliers.rows.map((s) => ({ id: s.id, label: s.name })),
            employee: employees.map((e) => ({ id: e.id, label: e.name })),
          }}
          records={{
            quote: quotes.map((q) => ({
              id: q.id,
              label: `${q.reference} · ${q.customerName ?? ""}`,
            })),
            invoice: invoices.map((i) => ({
              id: i.id,
              label: `${i.reference} · ${i.customerName ?? ""}`,
            })),
            job: jobs.rows.map((j) => ({ id: j.id, label: `${j.reference} · ${j.name}` })),
          }}
          dict={{
            title: t("docstudio.field.title"),
            category: t("docstudio.field.category"),
            language: t("docstudio.field.language"),
            template: t("docstudio.field.template"),
            blank: t("docstudio.field.blank"),
            counterparty: t("docstudio.field.counterparty"),
            counterpartyNone: t("docstudio.field.counterparty_none"),
            otherLabel: t("docstudio.field.other_label"),
            record: t("docstudio.field.record"),
            recordNone: t("docstudio.field.record_none"),
            expires: t("docstudio.field.expires"),
            tags: t("docstudio.field.tags"),
            folder: t("docstudio.field.folder"),
            noFolder: t("docstudio.field.no_folder"),
            create: t("docstudio.create"),
            kinds: {
              customer: t("docstudio.counterparty.customer"),
              supplier: t("docstudio.counterparty.supplier"),
              employee: t("docstudio.counterparty.employee"),
              other: t("docstudio.counterparty.other"),
            },
            recordKinds: {
              quote: t("docstudio.record.quote"),
              invoice: t("docstudio.record.invoice"),
              job: term("job", terms, "singular"),
            },
          }}
        />
        <div className="mt-3">
          <Link href={`/o/${orgId}/documents`}>
            <Button variant="ghost">{t("docstudio.cancel")}</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
