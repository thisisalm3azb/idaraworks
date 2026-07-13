import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listQuotes } from "@/modules/quotes/service";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  pending_approval: "info",
  approved: "info",
  sent: "info",
  accepted: "success",
  converted: "success",
  rejected: "danger",
  expired: "neutral",
};

export default async function QuotesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "quotes.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const rows = await listQuotes(resolved.ctx, resolved.archetype);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("quotes.title")}</h1>
        {can(resolved.archetype, "quotes.manage") ? (
          <Link href={`/o/${orgId}/quotes/new`}>
            <Button>{t("quotes.new")}</Button>
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("quotes.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((q) => (
            <li key={q.id}>
              <Link
                href={`/o/${orgId}/quotes/${q.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{q.reference}</span>
                  <Badge tone={TONE[q.status] ?? "neutral"}>{t(`quotes.status.${q.status}`)}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {q.customerName ?? "—"}
                  {q.totalMinor !== null ? ` · ${formatMoney(q.totalMinor, currency)}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
