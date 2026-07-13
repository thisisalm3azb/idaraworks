import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listQuoteFormOptions } from "@/modules/quotes/service";
import { createQuoteAction } from "../actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export default async function NewQuotePage({
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
  if (!can(resolved.archetype, "quotes.manage")) redirect(`/o/${orgId}/quotes`);
  const t = await getT();
  const opts = await listQuoteFormOptions(resolved.ctx);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("quotes.new")}</h1>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={t("quotes.form.title")} />
        <form action={createQuoteAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("quotes.form.customer")}
            <select name="customer_id" className={input}>
              <option value="">—</option>
              {opts.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("quotes.form.preset")}
            <select name="preset_id" className={input}>
              <option value="">—</option>
              {opts.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("quotes.form.description")}
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
            {t("quotes.form.terms")}
            <input name="terms" maxLength={2000} className={input} />
          </label>
          <Button type="submit">{t("quotes.form.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
