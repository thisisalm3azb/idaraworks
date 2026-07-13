import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getServerLocale } from "@/platform/i18n/server";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { listQuoteFormOptions } from "@/modules/quotes/service";
import { listActiveJobsBrief } from "@/modules/expenses/service";
import { createInvoiceAction } from "../actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "invoices.manage")) redirect(`/o/${orgId}/invoices`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobVars = { job: term("job", terms, "singular"), jobs: term("job", terms, "plural") };
  const [{ customers }, jobs] = await Promise.all([
    listQuoteFormOptions(resolved.ctx),
    listActiveJobsBrief(resolved.ctx),
  ]);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("invoices.new")}</h1>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={t("invoices.form.title")} />
        <form action={createInvoiceAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("invoices.form.customer")}
            <select name="customer_id" className={input}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("invoices.form.job", jobVars)}
            <select name="job_id" className={input}>
              <option value="">—</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.reference} — {j.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("invoices.form.description")}
            <input name="description" required maxLength={300} className={input} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className={field}>
              {t("quotes.form.qty")}
              <input
                name="qty"
                type="number"
                min="0"
                step="0.001"
                defaultValue="1"
                dir="ltr"
                className={input}
              />
            </label>
            <label className={field}>
              {t("quotes.form.unit")}
              <input name="unit" defaultValue="unit" className={input} />
            </label>
            <label className={field}>
              {t("quotes.form.vat")}
              <input
                name="vat_rate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                defaultValue="0"
                dir="ltr"
                className={input}
              />
            </label>
          </div>
          <label className={field}>
            {t("quotes.form.unit_price")}
            <input
              name="unit_price"
              type="number"
              min="0"
              step="0.01"
              required
              dir="ltr"
              className={input}
            />
          </label>
          <label className={field}>
            {t("invoices.form.due_date")}
            <input name="due_date" type="date" className={input} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="is_export" type="checkbox" /> {t("invoices.form.is_export")}
          </label>
          <Button type="submit">{t("invoices.form.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
