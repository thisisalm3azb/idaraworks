import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { listCustomers } from "@/modules/masters/service";
import { isMasterDataErrorCode } from "@/platform/http/actionError";
import { createCustomerAction } from "./actions";

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    error?: string;
    ref?: string;
    field?: string;
    name?: string;
    country?: string;
    phone?: string;
    email?: string;
    tax_reg_no?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const customers = await listCustomers(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "customers.manage");
  const addWithOrg = createCustomerAction.bind(null, orgId);

  const errorCode = isMasterDataErrorCode(sp.error) ? sp.error : undefined;
  const errorMsg = errorCode ? t(`masterdata.error.${errorCode}`) : null;
  const invalid = errorCode ? sp.field : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("customers.title", { customers: term("customer", terms, "plural") })}
        />
        {customers.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {customers.map((c) => (
              <li key={c.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-ink-muted">{c.country ?? ""}</p>
                </div>
                <Badge tone={c.active ? "success" : "neutral"}>
                  {c.active ? t("common.active") : t("common.inactive")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader
            title={t("customers.add", { customer: term("customer", terms, "singular") })}
          />
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
              label={t("common.name")}
              name="name"
              required
              defaultValue={sp.name ?? ""}
              error={invalid === "name" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "name" || undefined}
            />
            <Field
              label={t("customers.country")}
              name="country"
              maxLength={2}
              placeholder="AE"
              defaultValue={sp.country ?? ""}
              error={invalid === "country" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "country" || undefined}
            />
            <Field label={t("common.phone")} name="phone" defaultValue={sp.phone ?? ""} />
            <Field
              label={t("common.email")}
              name="email"
              type="email"
              defaultValue={sp.email ?? ""}
              error={invalid === "email" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "email" || undefined}
            />
            <Field
              label={t("customers.tax_no")}
              name="tax_reg_no"
              defaultValue={sp.tax_reg_no ?? ""}
            />
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
