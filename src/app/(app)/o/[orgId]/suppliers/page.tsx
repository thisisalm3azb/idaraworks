import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { listSuppliers } from "@/modules/masters/service";
import { createSupplierAction } from "./actions";

export default async function SuppliersPage({
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
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const suppliers = await listSuppliers(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "catalog.manage");
  const addWithOrg = createSupplierAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("suppliers.title", { suppliers: term("supplier", terms, "plural") })}
        />
        {error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {suppliers.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {suppliers.map((s) => (
              <li key={s.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <p className="text-sm font-medium text-ink">{s.name}</p>
                <Badge tone={s.active ? "success" : "neutral"}>
                  {s.active ? t("common.active") : t("common.inactive")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader
            title={t("suppliers.add", { supplier: term("supplier", terms, "singular") })}
          />
          <form action={addWithOrg} className="flex flex-col gap-4">
            <Field label={t("common.name")} name="name" required />
            <Field label={t("customers.tax_no")} name="tax_reg_no" />
            <Field label={t("common.phone")} name="phone" />
            <Field label={t("common.email")} name="email" type="email" />
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
