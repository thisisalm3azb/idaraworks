import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { getExpense } from "@/modules/expenses/service";
import { voidExpenseAction } from "../actions";

export default async function ExpenseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; expenseId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, expenseId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "expenses.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const e = await getExpense(resolved.ctx, resolved.archetype, expenseId);
  if (!e) notFound();
  const canVoid = can(resolved.archetype, "expenses.void") && !e.voided;

  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{e.reference}</h1>
        {e.voided ? <Badge tone="danger">{t("expenses.voided")}</Badge> : null}
      </div>
      {sp.ok === "voided" ? <Badge tone="success">{t("expenses.void_ok")}</Badge> : null}
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={t("expenses.detail.title")} />
        {row(t("expenses.form.category"), e.categoryKey)}
        {row(t("expenses.form.job"), e.jobName ?? t("expenses.overhead"))}
        {row(t("expenses.form.description"), e.description)}
        {row(t("expenses.form.date"), e.expenseDate)}
        {row(t("expenses.detail.net"), formatMoney(e.amountMinor, currency))}
        {row(t("expenses.detail.vat"), formatMoney(e.vatAmountMinor, currency))}
        {row(t("expenses.detail.total"), formatMoney(e.totalMinor, currency))}
        {e.voided ? row(t("expenses.detail.void_reason"), e.voidReason ?? "—") : null}
      </Card>
      {canVoid ? (
        <Card>
          <CardHeader title={t("expenses.void.title")} />
          <form action={voidExpenseAction.bind(null, orgId)} className="flex flex-col gap-2">
            <input type="hidden" name="expense_id" value={e.id} />
            <input
              name="reason"
              required
              maxLength={500}
              placeholder={t("expenses.void.reason_placeholder")}
              className="min-h-11 rounded-md border border-line bg-card px-3 py-2 text-sm text-ink"
            />
            <Button type="submit" variant="danger">
              {t("expenses.void.submit")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
