import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { journalRegister } from "@/modules/finance/service";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  posted: "success",
  draft: "info",
  reversed: "warning",
  cancelled: "danger",
};

/** H24K — the journal register: paged, filterable, drillable. */
export default async function JournalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string; page?: string; ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const limit = 25;
  const reg = await journalRegister(resolved.ctx, resolved.archetype, {
    status: sp.status || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  const qs = (p: number) =>
    `?${new URLSearchParams({ ...(sp.status ? { status: sp.status } : {}), page: String(p) })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("finance.journals.title")}</h1>
        {can(resolved.archetype, "finance.post") ? (
          <Link
            href={`/o/${orgId}/finance/journals/new`}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            {t("finance.journals.new")}
          </Link>
        ) : null}
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <div className="flex flex-wrap gap-2 text-sm">
        {["", "draft", "posted", "reversed", "cancelled"].map((s) => (
          <Link
            key={s || "all"}
            href={s ? `?status=${s}` : "?"}
            className={`rounded-full border px-3 py-1 ${
              (sp.status ?? "") === s ? "border-accent text-accent" : "border-line text-ink-muted"
            }`}
          >
            {s ? t(`finance.journals.status_${s}`) : t("common.all")}
          </Link>
        ))}
      </div>

      {reg.rows.length === 0 ? (
        <EmptyState title={t("finance.journals.empty")} />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y divide-line">
            {reg.rows.map((r) => (
              <li key={r.entryId}>
                <Link
                  href={`/o/${orgId}/finance/journals/${r.entryId}`}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-ink" dir="ltr">
                      {r.entryNo}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {formatDate(r.entryDate, { locale })} · {r.journalKind}
                      {r.memo ? ` · ${r.memo.slice(0, 60)}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm text-ink" dir="ltr">
                      {formatMoney(r.totalDebitMinor, currency, { locale })}
                    </span>
                    <Badge tone={STATUS_TONE[r.status] ?? "info"}>
                      {t(`finance.journals.status_${r.status}`)}
                    </Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center justify-between text-sm">
        {page > 1 ? (
          <Link className="text-accent underline" href={qs(page - 1)}>
            {t("common.previous")}
          </Link>
        ) : (
          <span />
        )}
        {reg.hasMore ? (
          <Link className="text-accent underline" href={qs(page + 1)}>
            {t("common.next")}
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
