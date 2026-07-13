import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listPurchaseOrders } from "@/modules/supply/service";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning"> = {
  draft: "neutral",
  approved: "info",
  sent: "info",
  partially_received: "warning",
  received: "success",
  cancelled: "neutral",
};

export default async function PurchaseOrdersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "po.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const rows = await listPurchaseOrders(resolved.ctx, a);
  const currency = resolved.baseCurrency as CurrencyCode;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("po.title")}</h1>
        {can(a, "po.manage") ? (
          <Link href={`/o/${orgId}/purchase-orders/new`}>
            <Button>{t("po.new")}</Button>
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("po.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/o/${orgId}/purchase-orders/${r.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.reference}</span>
                  <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {t(`po.status.${r.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 flex items-center justify-between text-xs text-ink-muted">
                  <span>
                    {r.supplierName ?? "—"}
                    {r.jobReference ? ` · ${r.jobReference}` : ""}
                  </span>
                  <span dir="ltr">
                    {formatMoney(Number(r.totalMinor), currency, { locale: "en" })}
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
