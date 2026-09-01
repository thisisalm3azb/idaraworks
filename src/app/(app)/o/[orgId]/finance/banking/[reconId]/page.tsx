import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listReconciliations, unreconciledReport, suggestMatches } from "@/modules/finance/service";
import { addMatchAction, completeReconciliationAction } from "../../actions";

/**
 * H24K — one reconciliation. Suggestions are SUGGESTIONS: each carries its
 * evidence and becomes a match only when a person presses accept; completing
 * freezes the matches. Nothing here posts or repairs the ledger.
 */
export default async function ReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; reconId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId, reconId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (minor: number) => formatMoney(minor, currency, { locale });
  const recon = (await listReconciliations(resolved.ctx, resolved.archetype)).find(
    (r) => r.id === reconId,
  );
  if (!recon) notFound();
  const reconciles = can(resolved.archetype, "finance.reconcile");
  const open = recon.status === "in_progress";
  const [report, suggestions] = await Promise.all([
    unreconciledReport(resolved.ctx, resolved.archetype, recon.bankAccountId),
    open && reconciles
      ? suggestMatches(resolved.ctx, resolved.archetype, recon.bankAccountId)
      : Promise.resolve([]),
  ]);
  const stmtOf = new Map(report.statementLines.map((s) => [s.id, s]));
  const glOf = new Map(report.ledgerLines.map((g) => [g.id, g]));
  const accept = addMatchAction.bind(null, orgId);
  const complete = completeReconciliationAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{recon.label}</h1>
        <Badge tone={recon.status === "completed" ? "success" : "info"}>
          {t(`finance.banking.recon_${recon.status}`)}
        </Badge>
      </div>
      <p className="text-sm text-ink-muted">
        {recon.bankAccountName} · {formatDate(recon.startedAt, { locale })} ·{" "}
        {t("finance.banking.matched_count")}: {recon.matchCount}
      </p>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {open && reconciles && suggestions.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">
            {t("finance.banking.suggestions")}
          </h2>
          <p className="mb-2 text-xs text-ink-muted">{t("finance.banking.suggestions_hint")}</p>
          <ul className="flex flex-col divide-y divide-line">
            {suggestions.slice(0, 30).map((s) => {
              const stmt = stmtOf.get(s.statementLineId);
              const gl = glOf.get(s.journalLineId);
              if (!stmt || !gl) return null;
              return (
                <li
                  key={`${s.statementLineId}-${s.journalLineId}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-col text-sm">
                    <span className="text-ink">
                      {stmt.description} · <span dir="ltr">{money(stmt.amountMinor)}</span>
                    </span>
                    <span className="text-xs text-ink-muted">
                      <span dir="ltr">{gl.entryNo}</span> · {s.evidence}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={s.confidence === "exact" ? "success" : "warning"}>
                      {t(`finance.banking.confidence_${s.confidence}`)}
                    </Badge>
                    <form action={accept}>
                      <input type="hidden" name="reconciliation_id" value={reconId} />
                      <input type="hidden" name="statement_line_id" value={s.statementLineId} />
                      <input type="hidden" name="journal_line_id" value={s.journalLineId} />
                      <input type="hidden" name="amount_minor" value={stmt.amountMinor} />
                      <Button type="submit" variant="secondary">
                        {t("finance.banking.accept")}
                      </Button>
                    </form>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">
            {t("finance.banking.unmatched_statement")}
          </h2>
          {report.statementLines.length === 0 ? (
            <p className="text-sm text-success">{t("finance.banking.all_matched")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {report.statementLines.slice(0, 50).map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className="truncate text-ink">{s.description}</span>
                  <span className="text-ink-muted" dir="ltr">
                    {money(s.amountMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">
            {t("finance.banking.unmatched_ledger")}
          </h2>
          {report.ledgerLines.length === 0 ? (
            <p className="text-sm text-success">{t("finance.banking.all_matched")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {report.ledgerLines.slice(0, 50).map((g) => (
                <li key={g.id} className="flex justify-between gap-2">
                  <span dir="ltr">{g.entryNo}</span>
                  <span className="text-ink-muted" dir="ltr">
                    {money(g.signedMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <a
          href={`/api/o/${orgId}/documents/bank_recon_summary/${reconId}?print=1&lang=${locale}`}
          target="_blank"
          className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink"
        >
          {t("finance.journals.print")}
        </a>
        {open && reconciles ? (
          <form action={complete}>
            <input type="hidden" name="reconciliation_id" value={reconId} />
            <Button type="submit">{t("finance.banking.complete")}</Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
