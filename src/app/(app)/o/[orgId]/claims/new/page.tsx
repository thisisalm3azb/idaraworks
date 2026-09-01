import { notFound, redirect } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { hrSurfacesEnabled } from "@/platform/flags";
import type { CurrencyCode } from "@/platform/registries";
import { listExpenseCategories } from "@/modules/expenses/service";
import { createClaimAction } from "../actions";

export default async function NewClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const categories = await listExpenseCategories(resolved.ctx);
  const create = createClaimAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("hr.claims.new")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("common.error")}
        </p>
      ) : null}
      <form action={create} className="flex flex-col gap-3">
        <Card>
          <label className="text-xs text-ink-muted">
            {t("hr.claims.claim_title")}
            <input
              name="title"
              required
              maxLength={200}
              className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            />
          </label>
          <label className="mt-2 block text-xs text-ink-muted">
            {t("hr.claims.route")}
            <select
              name="route"
              className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              <option value="payroll">{t("hr.claims.route_payroll")}</option>
              <option value="expense_book">{t("hr.claims.route_expense_book")}</option>
            </select>
          </label>
        </Card>
        <p className="text-xs text-ink-muted">{t("hr.claims.lines_hint")}</p>
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-ink-muted">
                  {t("hr.claims.line_date")}
                  <input
                    type="date"
                    name={`line_${i}_date`}
                    required={i === 0}
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  />
                </label>
                <label className="flex-1 text-xs text-ink-muted">
                  {t("hr.claims.category")}
                  <select
                    name={`line_${i}_category`}
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  >
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {locale === "ar" ? c.labelAr : c.labelEn}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="text-xs text-ink-muted">
                {t("hr.claims.description")}
                <input
                  name={`line_${i}_description`}
                  required={i === 0}
                  maxLength={500}
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-ink-muted">
                  {t("hr.claims.amount", { currency })}
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    name={`line_${i}_amount`}
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                    dir="ltr"
                  />
                </label>
                <label className="flex-1 text-xs text-ink-muted">
                  {t("hr.claims.mileage")}
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    name={`line_${i}_km`}
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                    dir="ltr"
                  />
                </label>
              </div>
            </div>
          </Card>
        ))}
        <Button type="submit">{t("hr.claims.create")}</Button>
      </form>
    </div>
  );
}
