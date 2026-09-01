import { notFound, redirect } from "next/navigation";
import { Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { myEmployee } from "@/modules/hr/service";
import { listPayslips } from "@/modules/payroll/service";

/**
 * The employee's own pay surface: their payslips (the payslip row policy
 * scopes the read to their own rows) and self-service letters rendered from
 * their records through the document pipeline.
 */
export default async function MyPayPage({ params }: { params: Promise<{ orgId: string }> }) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const me = await myEmployee(resolved.ctx);
  // RLS narrows the read to the caller's own slips for the unprivileged; a
  // privileged viewer landing here still only wants their own, so filter.
  const slips = me ? await listPayslips(resolved.ctx, { employeeId: me.id }) : [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("hr.my_pay.title")}</h1>
      {!me ? <EmptyState title={t("hr.not_employee")} /> : null}

      {me ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">{t("hr.my_pay.letters")}</h2>
          <p className="mb-2 text-xs text-ink-muted">{t("hr.my_pay.letters_hint")}</p>
          <ul className="flex flex-col gap-2">
            {(
              [
                ["salary_certificate", t("hr.my_pay.salary_certificate")],
                ["experience_letter", t("hr.my_pay.experience_letter")],
              ] as const
            ).map(([kind, label]) => (
              <li key={kind} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{label}</span>
                <span className="flex gap-3">
                  <a
                    href={`/api/o/${orgId}/documents/${kind}/${me.id}?format=pdf&lang=en`}
                    className="text-sm text-ink-secondary underline"
                  >
                    {t("hr.pdf_en")}
                  </a>
                  <a
                    href={`/api/o/${orgId}/documents/${kind}/${me.id}?format=pdf&lang=ar`}
                    className="text-sm text-ink-secondary underline"
                  >
                    {t("hr.pdf_ar")}
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {me ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">{t("hr.my_pay.payslips")}</h2>
          {slips.length === 0 ? (
            <EmptyState title={t("hr.my_pay.empty")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {slips.map((s) => (
                <li key={s.id} className="rounded-md border border-line bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink">{s.slipNo}</span>
                      <span className="text-xs text-ink-muted" dir="ltr">
                        {t("hr.my_pay.period")}: {formatDate(s.periodStart, { locale })} –{" "}
                        {formatDate(s.periodEnd, { locale })}
                      </span>
                    </div>
                    <span className="font-medium text-ink" dir="ltr">
                      {formatMoney(s.netMinor, (s.currency as CurrencyCode) || currency, {
                        locale: "en",
                      })}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-3">
                    <a
                      href={`/api/o/${orgId}/documents/payslip/${s.id}?format=pdf&lang=en`}
                      className="text-sm text-ink-secondary underline"
                    >
                      {t("hr.pdf_en")}
                    </a>
                    <a
                      href={`/api/o/${orgId}/documents/payslip/${s.id}?format=pdf&lang=ar`}
                      className="text-sm text-ink-secondary underline"
                    >
                      {t("hr.pdf_ar")}
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
