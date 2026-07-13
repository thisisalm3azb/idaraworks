import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { listExpenseCategories, listActiveJobsBrief } from "@/modules/expenses/service";
import { createExpenseAction } from "../actions";

export default async function NewExpensePage({
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
  if (!can(resolved.archetype, "expenses.create")) redirect(`/o/${orgId}/expenses`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobTerm = { job: term("job", terms, "singular") };
  const [categories, jobs] = await Promise.all([
    listExpenseCategories(resolved.ctx),
    listActiveJobsBrief(resolved.ctx),
  ]);

  const field = "flex flex-col gap-1 text-sm";
  const input =
    "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("expenses.new")}</h1>
      {sp.error ? <Badge tone="danger">{t(`expenses.error.${sp.error}`)}</Badge> : null}
      <Card>
        <CardHeader title={t("expenses.form.title")} />
        <form action={createExpenseAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("expenses.form.category")}
            <select name="category_key" required className={input}>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {locale === "ar" ? c.labelAr : c.labelEn}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("expenses.form.job", jobTerm)}
            <select name="job_id" className={input}>
              <option value="">{t("expenses.overhead")}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.reference} — {j.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("expenses.form.description")}
            <input name="description" required maxLength={500} className={input} />
          </label>
          <label className={field}>
            {t("expenses.form.date")}
            <input name="expense_date" type="date" required className={input} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              {t("expenses.form.amount")}
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                required
                dir="ltr"
                className={input}
              />
            </label>
            <label className={field}>
              {t("expenses.form.vat")}
              <input
                name="vat_amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                dir="ltr"
                className={input}
              />
            </label>
          </div>
          <Button type="submit">{t("expenses.form.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
