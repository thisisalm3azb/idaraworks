import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  listTallyImports,
  tallyImportDetail,
  listAccounts,
  TALLY_SUPPORTED_FORMATS,
  type TallyDryRun,
} from "@/modules/finance/service";
import {
  inspectTallyAction,
  mapTallyAction,
  dryRunTallyAction,
  approveTallyAction,
} from "../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  imported: "success",
  validated: "warning",
  inspected: "info",
  failed: "danger",
};

/**
 * H24J — the guided Tally migration. Upload → inspect → map (a human
 * decision) → dry run with a trial-balance comparison → explicit approval.
 * Exceptions are listed by name; nothing posts twice; nothing posts before
 * the books start.
 */
export default async function TallyImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ batch?: string; ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (minor: number) => formatMoney(minor, currency, { locale });
  const batches = await listTallyImports(resolved.ctx, resolved.archetype);
  const selectedId = sp.batch && batches.some((b) => b.id === sp.batch) ? sp.batch : null;
  const detail = selectedId
    ? await tallyImportDetail(resolved.ctx, resolved.archetype, selectedId)
    : null;
  const accounts = detail ? await listAccounts(resolved.ctx, resolved.archetype) : [];
  const inspect = inspectTallyAction.bind(null, orgId);
  const mapLedgers = mapTallyAction.bind(null, orgId);
  const dryRun = dryRunTallyAction.bind(null, orgId);
  const approve = approveTallyAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  const dry = (detail?.report as { dryRun?: TallyDryRun } | undefined)?.dryRun;
  const nameOf = new Map(accounts.map((a) => [a.id, `${a.code} — ${a.nameEn}`]));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.tally.title")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <Card>
        <h2 className="mb-1 text-sm font-semibold text-ink">{t("finance.tally.formats")}</h2>
        <ul className="flex flex-col gap-1 text-xs text-ink-muted">
          {TALLY_SUPPORTED_FORMATS.map((f) => (
            <li key={f.key}>
              <span className="font-medium text-ink" dir="ltr">
                {f.label}
              </span>{" "}
              — {f.detail}
            </li>
          ))}
        </ul>
        <form action={inspect} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">
            {t("finance.tally.upload")}
            <input
              name="file"
              type="file"
              accept=".xml,.csv,text/xml,text/csv"
              required
              className="mt-1 block min-h-11 text-sm text-ink"
            />
          </label>
          <Button type="submit">{t("finance.tally.inspect")}</Button>
        </form>
      </Card>

      {batches.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.tally.batches")}</h2>
          <ul className="flex flex-col divide-y divide-line">
            {batches.map((b) => (
              <li key={b.id}>
                <a
                  href={`?batch=${b.id}`}
                  className="flex min-h-11 items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-col">
                    <span className="text-sm text-ink" dir="ltr">
                      {b.filename}
                    </span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {b.format} · {b.voucherCount}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[b.status] ?? "info"}>
                    {t(`finance.tally.status_${b.status}`)}
                  </Badge>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {detail ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.tally.mapping")}</h2>
          <p className="mb-2 text-xs text-ink-muted">{t("finance.tally.mapping_hint")}</p>
          <form action={mapLedgers} className="flex flex-col gap-2">
            <input type="hidden" name="import_id" value={detail.id} />
            {detail.ledgers.map((ledger, i) => (
              <div key={ledger} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <span className="self-center text-sm text-ink" dir="ltr">
                  {ledger}
                </span>
                <span>
                  <input type="hidden" name={`ledger_${i}`} value={ledger} />
                  <select
                    name={`account_${i}`}
                    defaultValue={detail.accountMap[ledger] ?? ""}
                    className={input}
                    dir="ltr"
                  >
                    <option value="">—</option>
                    <option value="skip">{t("finance.tally.skip")}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary">
                {t("finance.tally.save_mapping")}
              </Button>
            </div>
          </form>
          {detail.format !== "tally_xml_masters" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <form action={dryRun}>
                <input type="hidden" name="import_id" value={detail.id} />
                <Button type="submit" variant="secondary">
                  {t("finance.tally.dry_run")}
                </Button>
              </form>
              {detail.status === "validated" ? (
                <form action={approve}>
                  <input type="hidden" name="import_id" value={detail.id} />
                  <Button type="submit">{t("finance.tally.approve")}</Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {detail && dry ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">
            {t("finance.tally.dry_run_report")}
          </h2>
          <p className="text-sm text-ink">
            {t("finance.tally.postable")}: {dry.postable} ·{" "}
            <span dir="ltr">
              {money(dry.totalDebitMinor)} / {money(dry.totalCreditMinor)}
            </span>
          </p>
          <p className="mb-2 text-xs text-ink-muted">{t("finance.tally.compare_hint")}</p>
          {dry.accountTotals.length > 0 ? (
            <ul className="mb-2 flex flex-col gap-1 text-xs text-ink-muted">
              {dry.accountTotals.map((a) => (
                <li key={a.accountId} className="flex justify-between gap-2">
                  <span dir="ltr">{nameOf.get(a.accountId) ?? a.accountId}</span>
                  <span dir="ltr">
                    {money(a.debitMinor)} / {money(a.creditMinor)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {dry.exceptions.length > 0 ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-danger">
                {t("finance.tally.exceptions")} ({dry.exceptions.length})
              </h3>
              <ul className="flex flex-col gap-1 text-xs text-ink-muted">
                {dry.exceptions.map((e, i) => (
                  <li key={i}>
                    <span dir="ltr">
                      {e.voucher} ({e.date})
                    </span>{" "}
                    — {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
