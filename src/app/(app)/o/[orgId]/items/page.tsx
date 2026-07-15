import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listItemCategories, listItems } from "@/modules/masters/service";
import { isMasterDataErrorCode } from "@/platform/http/actionError";
import { createItemAction } from "./actions";

export default async function ItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    error?: string;
    ref?: string;
    field?: string;
    sku?: string;
    name?: string;
    category_key?: string;
    unit?: string;
    unit_cost_minor?: string;
    selling_price_minor?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const items = await listItems(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "catalog.manage");
  const addWithOrg = createItemAction.bind(null, orgId);

  const categories = await listItemCategories(resolved.ctx, resolved.archetype);
  const labelOf = (key: string) => {
    const c = categories.find((x) => x.key === key);
    return c ? (locale === "ar" ? c.labels.ar : c.labels.en) : key;
  };

  const errorCode = isMasterDataErrorCode(sp.error) ? sp.error : undefined;
  const errorMsg = errorCode ? t(`masterdata.error.${errorCode}`) : null;
  const invalid = errorCode ? sp.field : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("items.title")} />
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
          {errorMsg ? (
            <div className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger" role="alert">
              <p>{errorMsg}</p>
              {sp.ref ? (
                <p className="mt-1 text-xs text-danger/80">
                  {t("masterdata.error.reference", { id: sp.ref })}
                </p>
              ) : null}
            </div>
          ) : null}
          <form action={addWithOrg} className="flex flex-col gap-4">
            <Field
              label={t("items.sku")}
              name="sku"
              required
              defaultValue={sp.sku ?? ""}
              error={invalid === "sku" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "sku" || undefined}
            />
            <Field
              label={t("common.name")}
              name="name"
              required
              defaultValue={sp.name ?? ""}
              error={invalid === "name" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "name" || undefined}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="category_key" className="text-sm font-medium text-ink">
                {t("items.category")}
              </label>
              <select
                id="category_key"
                name="category_key"
                required
                defaultValue={sp.category_key ?? ""}
                autoFocus={invalid === "categoryKey" || undefined}
                aria-invalid={invalid === "categoryKey" || undefined}
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {locale === "ar" ? c.labels.ar : c.labels.en}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label={t("items.unit")}
              name="unit"
              defaultValue={sp.unit ?? "pcs"}
              required
              error={invalid === "unit" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "unit" || undefined}
            />
            {resolved.ctx.costPrivileged ? (
              <Field
                label={t("items.unit_cost")}
                name="unit_cost_minor"
                type="number"
                defaultValue={sp.unit_cost_minor ?? ""}
                error={invalid === "unitCostMinor" ? (errorMsg ?? undefined) : undefined}
                autoFocus={invalid === "unitCostMinor" || undefined}
              />
            ) : null}
            {resolved.ctx.pricePrivileged ? (
              <Field
                label={t("items.selling_price")}
                name="selling_price_minor"
                type="number"
                defaultValue={sp.selling_price_minor ?? ""}
                error={invalid === "sellingPriceMinor" ? (errorMsg ?? undefined) : undefined}
                autoFocus={invalid === "sellingPriceMinor" || undefined}
              />
            ) : null}
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
