import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getServerLocale } from "@/platform/i18n/server";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { listQuoteFormOptions } from "@/modules/quotes/service";
import { listActiveJobsBrief } from "@/modules/expenses/service";
import { createDraftAction } from "../actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export default async function NewCustomerUpdatePage({
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
  if (!can(resolved.archetype, "customer_updates.draft")) redirect(`/o/${orgId}/customer-updates`);
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
      <h1 className="text-lg font-semibold text-ink">{t("customer_updates.new")}</h1>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={t("customer_updates.form.title")} />
        <form action={createDraftAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("customer_updates.form.job", jobVars)}
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
            {t("customer_updates.form.customer")}
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
            {t("customer_updates.form.language")}
            <select name="language" defaultValue="ar" className={input}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className={field}>
            {t("customer_updates.form.msg_title")}
            <input name="title" required maxLength={200} className={input} />
          </label>
          <label className={field}>
            {t("customer_updates.form.body")}
            <textarea name="body" required maxLength={4000} rows={5} className={input} />
          </label>
          <p className="text-xs text-ink-muted">{t("customer_updates.form.safe_note")}</p>
          <Button type="submit">{t("customer_updates.form.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
