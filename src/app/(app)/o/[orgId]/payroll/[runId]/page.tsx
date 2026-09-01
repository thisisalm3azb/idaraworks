import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { getPayRun } from "@/modules/payroll/service";
import { payRunStepAction } from "../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  finalized: "success",
  approved: "success",
  awaiting_approval: "warning",
  review: "info",
  draft: "info",
  cancelled: "danger",
};

export default async function PayRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; runId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId, runId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "payroll.view")) notFound();
  // Amounts are the whole page: without cost privilege there is nothing honest
  // to show here — the list page already presents the run without money.
  if (!resolved.ctx.costPrivileged) redirect(`/o/${orgId}/payroll`);
  const t = await getT();
  const locale = await getServerLocale();
  const run = await getPayRun(resolved.ctx, resolved.archetype, runId);
  if (!run) notFound();
  const currency = run.currency as CurrencyCode;
  const money = (m: number) => formatMoney(m, currency, { locale: "en" });
  const step = payRunStepAction.bind(null, orgId);
  const manages = can(resolved.archetype, "payroll.manage");
  const approves = can(resolved.archetype, "payroll.approve");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{run.reference}</h1>
        <Badge tone={STATUS_TONE[run.status] ?? "info"}>{t(`hr.status.${run.status}`)}</Badge>
      </div>
      <p className="text-sm text-ink-secondary" dir="ltr">
        {formatDate(run.periodStart, { locale })} – {formatDate(run.periodEnd, { locale })}
        {run.packVersion ? ` · ${run.packVersion}` : ""}
      </p>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t(sp.ok === "finalize" ? "hr.payroll.finalized" : "hr.payroll.calculated")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{t("common.error")}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {manages && (run.status === "draft" || run.status === "review") && run.runKind !== "reversal" ? (
          <form action={step}>
            <input type="hidden" name="run_id" value={run.id} />
            <input type="hidden" name="step" value="calculate" />
            <Button type="submit">{t("hr.payroll.calculate")}</Button>
          </form>
        ) : null}
        {manages && run.status === "review" && run.lines.length > 0 ? (
          <form action={step}>
            <input type="hidden" name="run_id" value={run.id} />
            <input type="hidden" name="step" value="submit" />
            <Button type="submit">{t("hr.payroll.submit_approval")}</Button>
          </form>
        ) : null}
        {approves && run.status === "approved" ? (
          <form action={step}>
            <input type="hidden" name="run_id" value={run.id} />
            <input type="hidden" name="step" value="finalize" />
            <Button type="submit">{t("hr.payroll.finalize")}</Button>
          </form>
        ) : null}
        {manages && (run.status === "awaiting_approval" || run.status === "approved") ? (
          <form action={step}>
            <input type="hidden" name="run_id" value={run.id} />
            <input type="hidden" name="step" value="reopen" />
            <Button type="submit" variant="secondary">
              {t("hr.payroll.reopen")}
            </Button>
          </form>
        ) : null}
        {run.status === "finalized" ? (
          <a
            href={`/api/o/${orgId}/documents/payroll_register/${run.id}?format=pdf&lang=${locale}`}
            className="text-sm text-ink-secondary underline"
          >
            {t("hr.payroll.register_pdf")}
          </a>
        ) : null}
      </div>

      {run.exceptionCount > 0 ? (
        <Card>
          <h2 className="text-sm font-semibold text-warning">
            {t("hr.payroll.exceptions")} ({run.exceptionCount})
          </h2>
          <p className="text-xs text-ink-muted">{t("hr.payroll.exception_note")}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {run.lines
              .filter((l) => l.exceptions.length > 0)
              .map((l) => (
                <li key={l.id} className="text-sm text-ink-secondary">
                  {l.employeeName}: {l.exceptions.join("; ")}
                </li>
              ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        {/* The table scrolls inside its own container at 375px. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-line text-start text-xs text-ink-muted">
                <th className="py-2 text-start">{t("hr.payroll.employee")}</th>
                <th className="py-2 text-end">{t("hr.payroll.gross")}</th>
                <th className="py-2 text-end">{t("hr.payroll.deductions")}</th>
                <th className="py-2 text-end">{t("hr.payroll.net")}</th>
                <th className="py-2 text-end"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {run.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 text-ink">{l.employeeName}</td>
                  <td className="py-2 text-end text-ink" dir="ltr">
                    {money(l.grossMinor)}
                  </td>
                  <td className="py-2 text-end text-ink" dir="ltr">
                    {money(l.deductionMinor)}
                  </td>
                  <td className="py-2 text-end font-medium text-ink" dir="ltr">
                    {money(l.netMinor)}
                  </td>
                  <td className="py-2 text-end">
                    {l.payslipId ? (
                      <a
                        href={`/api/o/${orgId}/documents/payslip/${l.payslipId}?format=pdf&lang=${locale}`}
                        className="text-ink-secondary underline"
                      >
                        {t("hr.payroll.payslip")}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-semibold text-ink">
                <td className="py-2">{t("hr.claims.total")}</td>
                <td className="py-2 text-end" dir="ltr">
                  {money(run.grossTotalMinor)}
                </td>
                <td className="py-2 text-end" dir="ltr">
                  {money(run.deductionTotalMinor)}
                </td>
                <td className="py-2 text-end" dir="ltr">
                  {money(run.netTotalMinor)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {approves && run.status === "finalized" && run.runKind !== "reversal" ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("hr.payroll.reverse")}</h2>
          <form action={step} className="flex flex-col gap-2">
            <input type="hidden" name="run_id" value={run.id} />
            <input type="hidden" name="step" value="reverse" />
            <label className="text-xs text-ink-muted">
              {t("hr.payroll.reverse_reason")}
              <input
                name="reason"
                required
                maxLength={500}
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </label>
            <Button type="submit" variant="danger">
              {t("hr.payroll.reverse")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
