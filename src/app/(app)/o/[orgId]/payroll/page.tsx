import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listPayRuns, listPayGroups } from "@/modules/payroll/service";
import { createPayGroupAction, createPayRunAction } from "./actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  finalized: "success",
  approved: "success",
  awaiting_approval: "warning",
  review: "info",
  draft: "info",
  cancelled: "danger",
};

export default async function PayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "payroll.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const manages = can(resolved.archetype, "payroll.manage") && resolved.ctx.costPrivileged;
  const groups = await listPayGroups(resolved.ctx, resolved.archetype);
  const runs = await listPayRuns(resolved.ctx, resolved.archetype, {});
  const createGroup = createPayGroupAction.bind(null, orgId);
  const createRun = createPayRunAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("hr.payroll.title")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{t("common.error")}</p>
      ) : null}

      {manages && groups.length === 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.payroll.new_group")}</h2>
          <form action={createGroup} className="flex flex-col gap-2">
            <label className="text-xs text-ink-muted">
              {t("hr.payroll.group_name")}
              <input
                name="name"
                required
                maxLength={120}
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </label>
            <label className="text-xs text-ink-muted">
              {t("hr.payroll.rounding")}
              <select
                name="rounding"
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                dir="ltr"
              >
                {[1, 5, 10, 25, 50, 100].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit">{t("hr.payroll.new_group")}</Button>
          </form>
        </Card>
      ) : null}

      {manages && groups.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.payroll.new_run")}</h2>
          <form action={createRun} className="flex flex-col gap-2">
            <label className="text-xs text-ink-muted">
              {t("hr.payroll.group_name")}
              <select
                name="pay_group_id"
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.payroll.period_start")}
                <input
                  type="date"
                  name="period_start"
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.payroll.period_end")}
                <input
                  type="date"
                  name="period_end"
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
            </div>
            <label className="text-xs text-ink-muted">
              {t("hr.payroll.run_kind")}
              <select
                name="run_kind"
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                <option value="regular">{t("hr.payroll.kind_regular")}</option>
                <option value="off_cycle">{t("hr.payroll.kind_off_cycle")}</option>
              </select>
            </label>
            <Button type="submit">{t("hr.payroll.new_run")}</Button>
          </form>
        </Card>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState title={t("hr.payroll.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`/o/${orgId}/payroll/${r.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink">{r.reference}</span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {formatDate(r.periodStart, { locale })} – {formatDate(r.periodEnd, { locale })} ·{" "}
                      {t("hr.payroll.lines", { count: r.lines })}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={STATUS_TONE[r.status] ?? "info"}>{t(`hr.status.${r.status}`)}</Badge>
                    {resolved.ctx.costPrivileged ? (
                      <span className="text-sm text-ink" dir="ltr">
                        {formatMoney(r.netTotalMinor, currency, { locale: "en" })}
                      </span>
                    ) : null}
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
