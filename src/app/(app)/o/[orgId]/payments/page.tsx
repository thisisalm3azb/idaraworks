import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listPayments } from "@/modules/payments/service";
import { voidPaymentAction } from "./actions";

export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "payments.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const rows = await listPayments(resolved.ctx, resolved.archetype);
  const manage = can(resolved.archetype, "payments.manage");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("payments.title")}</h1>
        {manage ? (
          <Link href={`/o/${orgId}/payments/new`}>
            <Button>{t("payments.new")}</Button>
          </Link>
        ) : null}
      </div>
      {sp.ok ? <Badge tone="success">{t("common.saved")}</Badge> : null}
      {rows.length === 0 ? (
        <EmptyState title={t("payments.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((p) => (
            <li key={p.id} className="rounded-md border border-line bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-medium text-ink ${p.voided ? "line-through" : ""}`}>
                  {p.reference}
                </span>
                <span className="font-mono text-sm text-ink" dir="ltr">
                  {p.amountMinor !== null ? formatMoney(p.amountMinor, currency) : "🔒"}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {p.paymentDate} · {t(`payments.method.${p.method}`)} ·{" "}
                {t(`payments.status.${p.status}`)}
              </p>
              {manage && !p.voided ? (
                <form action={voidPaymentAction.bind(null, orgId)} className="mt-2 flex gap-2">
                  <input type="hidden" name="payment_id" value={p.id} />
                  <input
                    name="reason"
                    required
                    placeholder={t("payments.void_reason")}
                    className="min-h-9 flex-1 rounded border border-line bg-card px-2 text-xs"
                  />
                  <Button type="submit" variant="ghost">
                    {t("payments.void")}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
