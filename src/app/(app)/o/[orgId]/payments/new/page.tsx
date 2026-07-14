import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listInvoices } from "@/modules/invoices/service";
import { recordPaymentAction } from "../actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export default async function NewPaymentPage({
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
  if (!can(resolved.archetype, "payments.manage")) redirect(`/o/${orgId}/payments`);
  const t = await getT();
  const invoices = (await listInvoices(resolved.ctx, resolved.archetype)).filter(
    (i) => i.kind === "invoice" && (i.status === "issued" || i.status === "partially_paid"),
  );
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("payments.new")}</h1>
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={t("payments.form.title")} />
        <form action={recordPaymentAction.bind(null, orgId)} className="flex flex-col gap-3">
          {/* S10 idempotency: a fresh key per render — a double-tap of THIS form replays it (one
              payment); a new page load mints a new key = a deliberate second payment (0063). */}
          <input type="hidden" name="idempotency_key" value={`pmt-${randomUUID()}`} />
          <label className={field}>
            {t("payments.form.invoice")}
            <select name="invoice_id" className={input}>
              <option value="">—</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.reference}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("payments.form.method")}
            <select name="method" className={input}>
              {["bank_transfer", "cash", "cheque", "card", "other"].map((m) => (
                <option key={m} value={m}>
                  {t(`payments.method.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("payments.form.date")}
            <input name="payment_date" type="date" required className={input} />
          </label>
          <label className={field}>
            {t("payments.form.amount")}
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
            {t("payments.form.external_reference")}
            <input name="external_reference" maxLength={200} className={input} />
          </label>
          <Button type="submit">{t("payments.form.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
