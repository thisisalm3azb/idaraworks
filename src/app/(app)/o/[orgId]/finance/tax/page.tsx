import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate } from "@/platform/format";
import {
  financeSetupState,
  listTaxReturns,
  CT_ADJUSTMENT_RULES,
  AE_VAT_PACK_VERSION,
  AE_CT_PACK_VERSION,
} from "@/modules/finance/service";
import {
  prepareVatReturnAction,
  taxReturnStepAction,
  prepareCtWorkpaperAction,
  addCtAdjustmentAction,
} from "../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  draft: "info",
  under_review: "warning",
  locked: "success",
  amended: "danger",
};

/**
 * H24K — tax working papers. Versioned rule packs; a return is a WORKING
 * PAPER with a review lifecycle, never a filing — the page says so plainly.
 */
export default async function TaxPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "tax.prepare")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const reviews = can(resolved.archetype, "tax.review");
  const [setup, returns] = await Promise.all([
    financeSetupState(resolved.ctx, resolved.archetype),
    listTaxReturns(resolved.ctx, resolved.archetype),
  ]);
  const prepareVat = prepareVatReturnAction.bind(null, orgId);
  const stepReturn = taxReturnStepAction.bind(null, orgId);
  const prepareCt = prepareCtWorkpaperAction.bind(null, orgId);
  const addAdj = addCtAdjustmentAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  const ctReturns = returns.filter((r) => r.taxType === "corporate");
  const drafts = returns.filter((r) => r.status === "draft" || r.status === "under_review");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.tax.title")}</h1>
      <p className="rounded-md bg-sunken px-3 py-2 text-xs text-ink-muted">
        {t("finance.tax.disclaimer")}
      </p>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.tax.vat")}</h2>
          <p className="mb-2 text-xs text-ink-muted" dir="ltr">
            {AE_VAT_PACK_VERSION}
            {setup.vatProfile?.trn ? ` · TRN ${setup.vatProfile.trn}` : ""}
          </p>
          {setup.vatPackInstalled ? (
            <form action={prepareVat} className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-ink-muted">
                  {t("finance.reports.from")}
                  <input name="period_start" type="date" required className={input} dir="ltr" />
                </label>
                <label className="text-xs text-ink-muted">
                  {t("finance.reports.to")}
                  <input name="period_end" type="date" required className={input} dir="ltr" />
                </label>
              </div>
              <Button type="submit">{t("finance.tax.prepare_vat")}</Button>
            </form>
          ) : (
            <p className="text-sm text-ink-muted">{t("finance.tax.pack_missing")}</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.tax.ct")}</h2>
          <p className="mb-2 text-xs text-ink-muted" dir="ltr">
            {AE_CT_PACK_VERSION}
          </p>
          <form action={prepareCt} className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-ink-muted">
                {t("finance.reports.from")}
                <input name="period_start" type="date" required className={input} dir="ltr" />
              </label>
              <label className="text-xs text-ink-muted">
                {t("finance.reports.to")}
                <input name="period_end" type="date" required className={input} dir="ltr" />
              </label>
            </div>
            <Button type="submit">{t("finance.tax.prepare_ct")}</Button>
          </form>
        </Card>
      </div>

      {drafts.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.tax.ct_adjustment")}</h2>
          <form action={addAdj} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {t("finance.tax.return")}
              <select name="return_id" className={input} dir="ltr">
                {ctReturns
                  .filter((r) => r.status === "draft" || r.status === "under_review")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.reference}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.tax.rule")}
              <select name="rule_key" className={input} dir="ltr">
                {Object.entries(CT_ADJUSTMENT_RULES).map(([key, rule]) => (
                  <option key={key} value={key}>
                    {rule.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.tax.source_amount")}
              <input name="source_amount" type="number" step="0.01" className={input} dir="ltr" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.tax.adjustment_amount")}
              <input
                name="adjustment"
                type="number"
                step="0.01"
                min="0"
                required
                className={input}
                dir="ltr"
              />
            </label>
            <label className="text-xs text-ink-muted sm:col-span-2">
              {t("finance.tax.calculation")}
              <input name="calculation" required maxLength={300} className={input} />
            </label>
            <label className="text-xs text-ink-muted sm:col-span-3">
              {t("finance.tax.evidence")}
              <input name="evidence" maxLength={300} className={input} />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit" variant="secondary">
                {t("finance.tax.ct_adjustment")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.tax.returns")}</h2>
        {returns.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("finance.tax.none_yet")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {returns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="text-sm text-ink" dir="ltr">
                    {r.reference}
                  </span>
                  <span className="text-xs text-ink-muted" dir="ltr">
                    {formatDate(r.periodStart, { locale })} — {formatDate(r.periodEnd, { locale })}{" "}
                    · {r.packVersion}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[r.status] ?? "info"}>
                    {t(`finance.tax.status_${r.status}`)}
                  </Badge>
                  <a
                    className="text-xs text-accent underline"
                    target="_blank"
                    href={`/api/o/${orgId}/documents/${
                      r.taxType === "vat" ? "vat_working" : "ct_workpaper"
                    }/${r.id}?print=1&lang=${locale}`}
                  >
                    {t("finance.journals.print")}
                  </a>
                  {r.status === "draft" ? (
                    <form action={stepReturn}>
                      <input type="hidden" name="return_id" value={r.id} />
                      <input type="hidden" name="step" value="under_review" />
                      <Button type="submit" variant="secondary">
                        {t("finance.tax.to_review")}
                      </Button>
                    </form>
                  ) : null}
                  {reviews && r.status === "under_review" ? (
                    <form action={stepReturn}>
                      <input type="hidden" name="return_id" value={r.id} />
                      <input type="hidden" name="step" value="locked" />
                      <Button type="submit" variant="secondary">
                        {t("finance.tax.lock")}
                      </Button>
                    </form>
                  ) : null}
                  {reviews && r.status === "locked" && r.taxType === "vat" ? (
                    <form action={stepReturn}>
                      <input type="hidden" name="return_id" value={r.id} />
                      <input type="hidden" name="step" value="amend" />
                      <Button type="submit" variant="secondary">
                        {t("finance.tax.amend")}
                      </Button>
                    </form>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
