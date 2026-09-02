/**
 * H27 — the revenue report as a branded document: funnel, win/loss and
 * activity over a range, rendered as HTML or a real PDF (`?format=pdf`)
 * through the platform's PDF renderer with the organisation's issuer
 * identity. Money is redacted by privilege before it reaches the page.
 */
import { NextResponse } from "next/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can, ForbiddenError } from "@/platform/authz";
import { revenueStudioEnabled } from "@/platform/flags";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { logger } from "@/platform/logger";
import { renderingPdf } from "@/platform/documents/failure";
import { getDocumentProfile } from "@/modules/branding/service";
import {
  activityReport,
  funnelReport,
  listStageSettings,
  winLossReport,
} from "@/modules/crm/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export async function GET(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  if (!revenueStudioEnabled()) return new NextResponse("Not found", { status: 404 });
  const { orgId } = await ctx.params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") return new NextResponse("Unauthorized", { status: 401 });
  if (!can(resolved.archetype, "crm.forecast.view"))
    return new NextResponse("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = iso.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from") : null;
  const to = iso.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to") : null;
  const wantsPdf = url.searchParams.get("format") === "pdf";
  const t = await getT();
  const locale = await getServerLocale();
  const rtl = locale === "ar";
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (n: number | null | undefined) =>
    n === null || n === undefined ? t("common.restricted") : formatMoney(n, currency, { locale });

  try {
    const [profile, funnel, winLoss, activity, stages] = await Promise.all([
      getDocumentProfile(resolved.ctx),
      funnelReport(resolved.ctx, resolved.archetype, { from, to }),
      winLossReport(resolved.ctx, resolved.archetype, { from, to }),
      activityReport(resolved.ctx, resolved.archetype, { from, to }),
      listStageSettings(resolved.ctx, resolved.archetype, null),
    ]);
    const stageLabel = (key: string) => {
      const s = stages.find((x) => x.key === key);
      return (rtl ? s?.label.ar || s?.label.en : s?.label.en || s?.label.ar) || key;
    };
    const accent = profile.accentColor ?? "#1f3a5f";
    const title = t("revenue.reports.title");
    const rangeText = `${from ? formatDate(from, { locale }) : "—"} → ${to ? formatDate(to, { locale }) : "—"}`;
    const row = (cells: unknown[]) =>
      `<tr>${cells.map((c, i) => `<td class="${i > 0 ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`;
    const table = (head: string[], rows: string[]) =>
      `<table><thead><tr>${head.map((h, i) => `<th class="${i > 0 ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="muted">${esc(t("common.none"))}</td></tr>`}</tbody></table>`;
    const section = (heading: string, body: string, basis: string) =>
      `<section><h2>${esc(heading)}</h2>${body}<p class="basis">${esc(basis)}</p></section>`;

    const html = `<!doctype html><html lang="${locale}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 18mm 14mm; }
  body { font-family: "Noto Sans", "Noto Naskh Arabic", system-ui, sans-serif; color: #1a1a1a; font-size: 11pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${esc(accent)}; padding-bottom: 8px; margin-bottom: 14px; }
  header img { max-height: 48px; }
  h1 { font-size: 18pt; margin: 0 0 2px; color: ${esc(accent)}; }
  h2 { font-size: 13pt; margin: 18px 0 6px; color: ${esc(accent)}; }
  .meta { font-size: 9pt; color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #ddd; text-align: start; font-size: 10pt; }
  th { background: #f2f2f2; }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; direction: ltr; }
  .kpis { display: flex; gap: 10px; flex-wrap: wrap; }
  .kpi { border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; min-width: 110px; }
  .kpi .l { font-size: 8.5pt; color: #666; } .kpi .v { font-size: 14pt; font-weight: 600; direction: ltr; }
  .basis, .muted { font-size: 8.5pt; color: #666; }
  footer { margin-top: 20px; font-size: 8.5pt; color: #666; border-top: 1px solid #ddd; padding-top: 6px; }
</style></head><body>
<header>
  <div><h1>${esc(title)}</h1><div class="meta">${esc(profile.identity.tradingName)}${profile.identity.legalName && profile.identity.legalName !== profile.identity.tradingName ? ` · ${esc(profile.identity.legalName)}` : ""}</div>
  <div class="meta">${esc(rangeText)} · ${esc(formatDate(new Date(), { locale }))}</div></div>
  ${profile.logoDataUri ? `<img src="${profile.logoDataUri}" alt="">` : ""}
</header>
${section(
  t("revenue.reports.funnel"),
  `<div class="kpis">
    <div class="kpi"><div class="l">${esc(t("revenue.tab.leads"))}</div><div class="v">${funnel.leads.total}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.reports.opportunities_created"))}</div><div class="v">${funnel.opportunities.created}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.kpi.open"))}</div><div class="v">${funnel.opportunities.open}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.forecast.won"))}</div><div class="v">${funnel.opportunities.won.count}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.reports.lead_to_opp"))}</div><div class="v">${funnel.conversion.leadToOpportunityPct ?? "—"}%</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.reports.opp_to_won"))}</div><div class="v">${funnel.conversion.opportunityToWonPct ?? "—"}%</div></div>
  </div>` +
    table(
      [t("revenue.board.move_to"), "#", t("revenue.value")],
      funnel.opportunities.byStage.map((s) =>
        row([stageLabel(s.stageKey), s.count, money(s.valueMinor)]),
      ),
    ) +
    table(
      [t("revenue.leads.source_kind"), "#"],
      Object.entries(funnel.leads.bySource).map(([k, n]) => row([t(`revenue.source.${k}`), n])),
    ),
  funnel.basis,
)}
${section(
  t("revenue.reports.win_loss"),
  `<div class="kpis">
    <div class="kpi"><div class="l">${esc(t("revenue.forecast.won"))}</div><div class="v">${winLoss.won.count}</div><div class="l">${esc(money(winLoss.won.valueMinor))}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.forecast.lost"))}</div><div class="v">${winLoss.lost.count}</div><div class="l">${esc(money(winLoss.lost.valueMinor))}</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.forecast.win_rate"))}</div><div class="v">${winLoss.winRatePct ?? "—"}%</div></div>
    <div class="kpi"><div class="l">${esc(t("revenue.forecast.cycle"))}</div><div class="v">${winLoss.won.avgCycleDays === null ? "—" : Math.round(winLoss.won.avgCycleDays)}</div></div>
  </div>` +
    table(
      [t("revenue.reports.loss_reason"), "#"],
      winLoss.lossReasons.map((r) => row([r.reason, r.count])),
    ) +
    table(
      [t("revenue.filter.owner"), t("revenue.forecast.won"), t("revenue.forecast.lost")],
      winLoss.byOwner.map((o) => row([o.ownerName ?? t("revenue.unassigned"), o.won, o.lost])),
    ),
  winLoss.basis,
)}
${section(
  t("revenue.reports.activity"),
  table(
    [t("revenue.activity.kind"), "#", t("revenue.reports.completed")],
    activity.byKind.map((k) => row([t(`revenue.activity.${k.kind}`), k.count, k.completed])),
  ),
  activity.basis,
)}
<footer>${esc(t("revenue.forecast.disclaimer"))}</footer>
</body></html>`;

    if (!wantsPdf)
      return new NextResponse(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    const pdf = await renderingPdf(async () => {
      const { renderPdf } = await import("@/platform/documents");
      return renderPdf(html, { title, rtl, pageNumbers: true });
    });
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="revenue-report-${from ?? "all"}-${to ?? "all"}.pdf"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
    logger.error({ orgId, err: (err as Error).message }, "revenue report failed");
    return new NextResponse("Report unavailable", { status: 500 });
  }
}
