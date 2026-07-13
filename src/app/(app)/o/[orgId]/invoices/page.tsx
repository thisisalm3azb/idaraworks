import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listInvoices } from "@/modules/invoices/service";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  issued: "info",
  partially_paid: "warning",
  paid: "success",
  cancelled: "danger",
};

export default async function InvoicesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "invoices.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const rows = await listInvoices(resolved.ctx, resolved.archetype);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("invoices.title")}</h1>
        {can(resolved.archetype, "invoices.manage") ? (
          <Link href={`/o/${orgId}/invoices/new`}>
            <Button>{t("invoices.new")}</Button>
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("invoices.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((i) => (
            <li key={i.id}>
              <Link
                href={`/o/${orgId}/invoices/${i.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">
                    {i.reference}
                    {i.kind === "credit_note" ? (
                      <span className="ms-2">
                        <Badge tone="warning">{t("invoices.credit_note")}</Badge>
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={TONE[i.status] ?? "neutral"}>
                    {t(`invoices.status.${i.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {i.customerName ?? "—"}
                  {i.totalMinor !== null ? ` · ${formatMoney(i.totalMinor, currency)}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
