import { redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can, ForbiddenError } from "@/platform/authz";
import { hasFeature } from "@/platform/entitlements";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { getJobCosting, CostingNotFoundError } from "@/modules/costing/service";

export default async function JobCostingPage({
  params,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
}) {
  const { orgId, jobId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "costing.view")) redirect(`/o/${orgId}`);
  // Add-on enforcement (0070 honesty pass): cap.costing gates the page content —
  // the index page renders the upsell state; the costing SERVICE stays ungated
  // (other modules consume it).
  if (!(await hasFeature(resolved.ctx, "cap.costing"))) redirect(`/o/${orgId}/costing`);
  // feat.quote_vs_actual gates the quoted-versus-actual margin section only.
  const quoteVsActual = await hasFeature(resolved.ctx, "feat.quote_vs_actual");
  const t = await getT();
  const terms = await loadOrgTerminology(resolved.ctx, await getServerLocale());
  const jobTerm = { job: term("job", terms, "singular") };
  const currency = resolved.baseCurrency as CurrencyCode;

  let view;
  try {
    view = await getJobCosting(resolved.ctx, resolved.archetype, jobId, currency);
  } catch (err) {
    if (err instanceof CostingNotFoundError || err instanceof ForbiddenError)
      redirect(`/o/${orgId}/costing`);
    throw err;
  }

  const LOCK = "🔒";
  const money = (v: number | null) => (v === null ? LOCK : formatMoney(v, currency));

  const row = (label: string, value: string, privileged = false) => (
    <div className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span
        className={`font-mono ${privileged && value === LOCK ? "text-ink-muted" : "text-ink"}`}
        dir="ltr"
      >
        {value}
      </span>
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("costing.detail.title", jobTerm)}</h1>
        <Badge tone="neutral">{t(`costing.basis.${view.costBasis}`)}</Badge>
      </div>
      <Card>
        <CardHeader title={t("costing.detail.cost")} />
        {row(t("costing.material"), money(view.materialCostMinor))}
        {row(t("costing.po"), money(view.poCostMinor))}
        {row(t("costing.expense"), money(view.expenseCostMinor))}
        {row(t("costing.total_ex_labour"), money(view.totalExLabourMinor))}
        {row(t("costing.labour"), money(view.labourCostMinor), true)}
        {row(t("costing.total"), money(view.totalCostMinor), true)}
      </Card>
      {quoteVsActual ? (
        <Card>
          <CardHeader title={t("costing.detail.margin")} />
          {row(t("costing.quoted"), money(view.quotedMinor), true)}
          {row(t("costing.margin"), money(view.marginMinor), true)}
        </Card>
      ) : (
        <Card>
          <CardHeader title={t("costing.detail.margin")} />
          <p className="text-sm text-ink-muted">{t("costing.qva_upsell")}</p>
        </Card>
      )}
      <p className="text-xs text-ink-muted">
        {view.computedAt
          ? `${t("costing.computed_at")} ${view.computedAt.slice(0, 16).replace("T", " ")}`
          : ""}
        {view.labourCostMinor === null ? ` · ${t("costing.redacted_note")}` : ""}
      </p>
    </div>
  );
}
