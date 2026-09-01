import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { hrSurfacesEnabled } from "@/platform/flags";
import { formatMoney, formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { getClaim } from "@/modules/hr/service";
import { submitClaimAction, cancelClaimAction, settleClaimAction } from "../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  approved: "success",
  paid: "success",
  submitted: "warning",
  returned: "danger",
  draft: "info",
  cancelled: "info",
};

export default async function ClaimDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; claimId: string }>;
  searchParams: Promise<{ ok?: string; warn?: string; error?: string }>;
}) {
  if (!hrSurfacesEnabled()) notFound();
  const { orgId, claimId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const claim = await getClaim(resolved.ctx, claimId);
  if (!claim) notFound();
  const currency = claim.currency as CurrencyCode;
  const submit = submitClaimAction.bind(null, orgId);
  const cancel = cancelClaimAction.bind(null, orgId);
  const settle = settleClaimAction.bind(null, orgId);
  const canSettle =
    claim.status === "approved" &&
    claim.settlementRoute === "expense_book" &&
    can(resolved.archetype, "expenses.create");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">
          {claim.reference} · {claim.title}
        </h1>
        <Badge tone={STATUS_TONE[claim.status] ?? "info"}>{t(`hr.status.${claim.status}`)}</Badge>
      </div>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t(sp.ok === "submitted" ? "hr.claims.submitted" : "hr.claims.created")}
        </p>
      ) : null}
      {sp.warn ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t("hr.claims.duplicates_warning", { count: sp.warn })}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{t("common.error")}</p>
      ) : null}

      <Card>
        <p className="text-sm text-ink-secondary">
          {claim.employeeName} ·{" "}
          {t(
            claim.settlementRoute === "payroll"
              ? "hr.claims.route_payroll"
              : "hr.claims.route_expense_book",
          )}
        </p>
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {claim.lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2">
              <div className="flex flex-col">
                <span className="text-sm text-ink">
                  {l.description}
                  {l.mileageKm ? ` (${l.mileageKm} km)` : ""}
                </span>
                <span className="text-xs text-ink-muted" dir="ltr">
                  {formatDate(l.expenseDate, { locale })} · {l.categoryKey}
                </span>
              </div>
              <span className="text-sm text-ink" dir="ltr">
                {formatMoney(l.amountMinor, currency, { locale: "en" })}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="text-sm font-semibold text-ink">{t("hr.claims.total")}</span>
          <span className="font-semibold text-ink" dir="ltr">
            {formatMoney(claim.totalMinor, currency, { locale: "en" })}
          </span>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {claim.status === "draft" || claim.status === "returned" ? (
          <form action={submit}>
            <input type="hidden" name="claim_id" value={claim.id} />
            <Button type="submit">{t("hr.claims.submit")}</Button>
          </form>
        ) : null}
        {canSettle ? (
          <form action={settle}>
            <input type="hidden" name="claim_id" value={claim.id} />
            <Button type="submit">{t("hr.claims.settle")}</Button>
          </form>
        ) : null}
        {["draft", "returned", "submitted"].includes(claim.status) ? (
          <form action={cancel}>
            <input type="hidden" name="claim_id" value={claim.id} />
            <Button type="submit" variant="danger">
              {t("hr.claims.cancel")}
            </Button>
          </form>
        ) : null}
        <a
          href={`/api/o/${orgId}/documents/expense_claim_summary/${claim.id}?format=pdf&lang=${locale}`}
          className="text-sm text-ink-secondary underline"
        >
          {t("hr.claims.pdf")}
        </a>
      </div>
    </div>
  );
}
