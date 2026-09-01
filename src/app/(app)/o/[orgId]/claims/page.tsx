import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listClaims } from "@/modules/hr/service";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  approved: "success",
  paid: "success",
  submitted: "warning",
  returned: "danger",
  draft: "info",
  cancelled: "info",
};

export default async function ClaimsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  // listClaims narrows to the caller's own claims unless they hold expenses.view.
  const rows = await listClaims(resolved.ctx, resolved.archetype);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("hr.claims.title")}</h1>
        <Link href={`/o/${orgId}/claims/new`}>
          <Button>{t("hr.claims.new")}</Button>
        </Link>
      </div>
      {sp.ok === "cancelled" ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("hr.status.cancelled")}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t("hr.claims.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={`/o/${orgId}/claims/${c.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink">
                      {c.reference} · {c.title}
                    </span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {c.employeeName} · {formatDate(c.createdAt.slice(0, 10), { locale })}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={STATUS_TONE[c.status] ?? "info"}>
                      {t(`hr.status.${c.status}`)}
                    </Badge>
                    <span className="text-sm text-ink" dir="ltr">
                      {formatMoney(c.totalMinor, currency, { locale: "en" })}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
