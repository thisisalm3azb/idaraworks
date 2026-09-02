import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import {
  DOC_CATEGORIES,
  DOC_LANGUAGES,
  listDocuments,
  listTemplates,
} from "@/modules/docstudio/service";
import { createTemplateAction } from "../studio-actions";

/** H26 — the governed template library: built-ins plus the organisation's own, versioned. */
export default async function TemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.templates.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const [templates, docs] = await Promise.all([
    listTemplates(resolved.ctx, resolved.archetype),
    listDocuments(resolved.ctx, resolved.archetype, { limit: 100 }),
  ]);
  const create = createTemplateAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  const name = (x: (typeof templates)[number]) => (locale === "ar" ? x.nameAr : x.nameEn);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {t("docstudio.back")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink">{t("docstudio.tpl.title")}</h1>
        <p className="text-sm text-ink-muted">{t("docstudio.tpl.subtitle")}</p>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((x) => (
          <Card key={x.key}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-ink">{name(x)}</h2>
                <p className="text-xs text-ink-muted">
                  {t(`docstudio.category.${x.category}`)} · {t(`docstudio.language.${x.language}`)}
                  {x.builtIn ? ` · ${t("docstudio.builtin")}` : ` · v${x.currentVersion}`}
                </p>
              </div>
              <Badge tone={x.status === "published" ? "success" : "neutral"}>
                {t(`docstudio.tpl.status.${x.status}`)}
              </Badge>
            </div>
            {x.description ? (
              <p className="mt-2 text-sm text-ink-secondary">{x.description}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {x.status === "published" && can(resolved.archetype, "documents.create") ? (
                <Link
                  href={`/o/${orgId}/documents/new?template=${encodeURIComponent(x.builtIn ? x.key : (x.id as string))}`}
                  className="min-h-9 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-sunken"
                >
                  {t("docstudio.tpl.use")}
                </Link>
              ) : null}
              {x.builtIn ? null : (
                <Link
                  href={`/o/${orgId}/documents/templates/${x.id}`}
                  className="min-h-9 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-sunken"
                >
                  {t("docstudio.tpl.open")}
                </Link>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t("docstudio.tpl.new")}</h2>
        <form action={create} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-muted">
            {t("docstudio.tpl.key")}
            <input
              name="key"
              required
              pattern="[a-z0-9_.-]{1,60}"
              className={`${input} font-mono`}
            />
          </label>
          <label className="text-xs text-ink-muted">
            {t("docstudio.tpl.name_en")}
            <input name="nameEn" required maxLength={160} className={input} />
          </label>
          <label className="text-xs text-ink-muted">
            {t("docstudio.tpl.name_ar")}
            <input name="nameAr" required maxLength={160} dir="rtl" className={input} />
          </label>
          <label className="text-xs text-ink-muted">
            {t("docstudio.field.category")}
            <select name="category" className={input} defaultValue="contract">
              {DOC_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`docstudio.category.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {t("docstudio.field.language")}
            <select name="language" className={input} defaultValue="en">
              {DOC_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`docstudio.language.${l}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {t("docstudio.tpl.from")}
            <select name="from" className={input} defaultValue="">
              <option value="">{t("docstudio.field.blank")}</option>
              {templates
                .filter((x) => x.builtIn)
                .map((x) => (
                  <option key={x.key} value={x.key}>
                    {name(x)} · {t("docstudio.builtin")}
                  </option>
                ))}
              {docs.rows.map((d) => (
                <option key={d.id} value={`doc:${d.id}`}>
                  {d.reference} · {d.title}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted sm:col-span-3">
            {t("docstudio.tpl.description")}
            <input name="description" maxLength={2000} className={input} />
          </label>
          <div className="sm:col-span-3">
            <Button type="submit">{t("docstudio.tpl.create")}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
