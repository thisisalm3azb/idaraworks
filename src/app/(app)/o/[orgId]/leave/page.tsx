import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatDate } from "@/platform/format";
import { leaveBalances, listLeaveRequests, listLeaveTypes, myEmployee } from "@/modules/hr/service";
import { requestLeaveAction, cancelLeaveAction, requestOvertimeAction } from "./actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
  cancelled: "info",
};

export default async function LeavePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();

  const me = await myEmployee(resolved.ctx);
  const managesOthers = can(resolved.archetype, "attendance.manage");
  const types = await listLeaveTypes(resolved.ctx);
  const balances = me ? await leaveBalances(resolved.ctx, resolved.archetype, me.id) : [];
  const myRequests = me
    ? await listLeaveRequests(resolved.ctx, resolved.archetype, { employeeId: me.id })
    : [];
  const teamPending = managesOthers
    ? (await listLeaveRequests(resolved.ctx, resolved.archetype, { status: "pending" })).filter(
        (r) => r.employeeId !== me?.id,
      )
    : [];
  const requestLeave = requestLeaveAction.bind(null, orgId);
  const cancelLeave = cancelLeaveAction.bind(null, orgId);
  const requestOt = requestOvertimeAction.bind(null, orgId);
  const typeLabel = (key: string) => {
    const ty = types.find((x) => x.key === key);
    return ty ? (locale === "ar" ? ty.labelAr : ty.labelEn) : key;
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("hr.leave.title")}</h1>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t(sp.ok === "cancelled" ? "hr.leave.cancelled" : "hr.leave.submitted")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t(sp.error === "not_employee" ? "hr.not_employee" : "common.error")}
        </p>
      ) : null}
      {!me ? <EmptyState title={t("hr.not_employee")} /> : null}

      {me && balances.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.leave.balances")}</h2>
          <ul className="flex flex-wrap gap-3">
            {balances.map((b) => (
              <li key={b.leaveTypeId} className="rounded-md border border-line px-3 py-2">
                <span className="block text-xs text-ink-muted">
                  {locale === "ar" ? b.labelAr : b.labelEn}
                </span>
                <span className="font-medium text-ink" dir="ltr">
                  {t("hr.leave.balance_days", { days: b.balanceDays })}
                </span>
                {b.pendingDays > 0 ? (
                  <span className="block text-xs text-warning" dir="ltr">
                    {t("hr.leave.pending_days", { days: b.pendingDays })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {me ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.leave.request_new")}</h2>
          <form action={requestLeave} className="flex flex-col gap-2">
            <label className="text-xs text-ink-muted">
              {t("hr.leave.type")}
              <select
                name="leave_type_id"
                required
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {types.map((ty) => (
                  <option key={ty.id} value={ty.id}>
                    {locale === "ar" ? ty.labelAr : ty.labelEn}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.leave.start")}
                <input
                  type="date"
                  name="start_date"
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.leave.end")}
                <input
                  type="date"
                  name="end_date"
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
            </div>
            <label className="text-xs text-ink-muted">
              {t("hr.leave.reason")}
              <input
                name="reason"
                maxLength={1000}
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </label>
            <Button type="submit">{t("hr.leave.submit")}</Button>
          </form>
        </Card>
      ) : null}

      {me ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">{t("hr.leave.requests")}</h2>
          {myRequests.length === 0 ? (
            <EmptyState title={t("hr.leave.empty")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {myRequests.map((r) => (
                <li key={r.id} className="rounded-md border border-line bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink">{typeLabel(r.typeKey)}</span>
                      <span className="text-xs text-ink-muted" dir="ltr">
                        {formatDate(r.startDate, { locale })} – {formatDate(r.endDate, { locale })}{" "}
                        · {t("hr.leave.days", { days: r.days })}
                      </span>
                    </div>
                    <Badge tone={STATUS_TONE[r.status] ?? "info"}>
                      {t(`hr.status.${r.status}`)}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    {r.status === "approved" ? (
                      <a
                        href={`/api/o/${orgId}/documents/leave_confirmation/${r.id}?format=pdf&lang=${locale}`}
                        className="text-sm text-ink-secondary underline"
                      >
                        {t("hr.leave.confirmation_pdf")}
                      </a>
                    ) : null}
                    {r.status === "pending" || r.status === "approved" ? (
                      <form action={cancelLeave}>
                        <input type="hidden" name="request_id" value={r.id} />
                        <button type="submit" className="text-sm text-danger underline">
                          {t("hr.leave.cancel")}
                        </button>
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {me ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.ot.title")}</h2>
          <form action={requestOt} className="flex flex-col gap-2">
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.claims.line_date")}
                <input
                  type="date"
                  name="work_date"
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
              <label className="flex-1 text-xs text-ink-muted">
                {t("hr.ot.minutes")}
                <input
                  type="number"
                  name="minutes"
                  min={1}
                  max={960}
                  required
                  className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                />
              </label>
            </div>
            <label className="text-xs text-ink-muted">
              {t("hr.leave.reason")}
              <input
                name="reason"
                required
                maxLength={500}
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </label>
            <Button type="submit" variant="secondary">
              {t("hr.leave.submit")}
            </Button>
          </form>
        </Card>
      ) : null}

      {managesOthers && teamPending.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">{t("hr.leave.team_requests")}</h2>
          <ul className="flex flex-col gap-2">
            {teamPending.map((r) => (
              <li key={r.id} className="rounded-md border border-line bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink">{r.employeeName}</span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {typeLabel(r.typeKey)} · {formatDate(r.startDate, { locale })} –{" "}
                      {formatDate(r.endDate, { locale })} · {t("hr.leave.days", { days: r.days })}
                    </span>
                  </div>
                  <Badge tone="warning">{t("hr.status.pending")}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
