import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listItems } from "@/modules/masters/service";
import { sql, withCtx } from "@/platform/tenancy";
import { createItemAction } from "./actions";

export default async function ItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const { error } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const items = await listItems(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "catalog.manage");
  const addWithOrg = createItemAction.bind(null, orgId);

  const categoryRows = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${resolved.ctx.orgId} and key = 'config.categories.item'
    `),
  )) as unknown as Array<{
    value: {
      categories: Array<{ key: string; labels: { en: string; ar: string }; retired: boolean }>;
    };
  }>;
  const categories = (categoryRows[0]?.value?.categories ?? []).filter((c) => !c.retired);
  const labelOf = (key: string) => {
    const c = categories.find((x) => x.key === key);
    return c ? (locale === "ar" ? c.labels.ar : c.labels.en) : key;
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("items.title")} />
        {error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium text-ink">
                    {i.sku} — {i.name}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {labelOf(i.categoryKey)} · {i.unit}
                    {i.unitCostMinor !== null ? ` · ${i.unitCostMinor}` : ""}
                  </p>
                </div>
                <Badge tone={i.active ? "success" : "neutral"}>
                  {i.active ? t("common.active") : t("common.inactive")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && categories.length > 0 ? (
        <Card>
          <CardHeader title={t("items.add")} />
          <form action={addWithOrg} className="flex flex-col gap-4">
            <Field label={t("items.sku")} name="sku" required />
            <Field label={t("common.name")} name="name" required />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="category_key" className="text-sm font-medium text-ink">
                {t("items.category")}
              </label>
              <select
                id="category_key"
                name="category_key"
                required
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {locale === "ar" ? c.labels.ar : c.labels.en}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t("items.unit")} name="unit" defaultValue="pcs" required />
            {resolved.ctx.costPrivileged ? (
              <Field label={t("items.unit_cost")} name="unit_cost_minor" type="number" />
            ) : null}
            {resolved.ctx.pricePrivileged ? (
              <Field label={t("items.selling_price")} name="selling_price_minor" type="number" />
            ) : null}
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
