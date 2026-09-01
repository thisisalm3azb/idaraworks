import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { journalEntryDetail } from "@/modules/finance/service";
import { journalStepAction } from "../../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info"> = {
  posted: "success",
  draft: "info",
  reversed: "warning",
  cancelled: "danger",
};

/** H24K — one entry: lines, source link, lifecycle, and the voucher print. */
export default async function JournalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; entryId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId, entryId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  let entry;
  try {
    entry = await journalEntryDetail(resolved.ctx, resolved.archetype, entryId);
  } catch {
    notFound();
  }
  const money = (minor: number) =>
    minor === 0 ? "" : formatMoney(minor, entry.currency as CurrencyCode, { locale });
  const posts = can(resolved.archetype, "finance.post");
  const step = journalStepAction.bind(null, orgId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink" dir="ltr">
          {entry.entryNo}
        </h1>
        <Badge tone={STATUS_TONE[entry.status] ?? "info"}>
          {t(`finance.journals.status_${entry.status}`)}
        </Badge>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <Card>
        <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
          <span dir="ltr">{formatDate(entry.entryDate, { locale })}</span>
          <span>{entry.journalKind}</span>
          {entry.sourceType ? <span>{entry.sourceType}</span> : null}
          {entry.memo ? <span className="text-ink">{entry.memo}</span> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted">
                <th className="py-2 text-start">{t("finance.journals.account")}</th>
                <th className="py-2 text-end">{t("finance.journals.debit")}</th>
                <th className="py-2 text-end">{t("finance.journals.credit")}</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((l) => (
                <tr key={l.lineNo} className="border-b border-line last:border-0">
                  <td className="py-2 text-ink">
                    <span dir="ltr">{l.accountCode}</span> —{" "}
                    {locale === "ar" && l.accountNameAr ? l.accountNameAr : l.accountNameEn}
                    {l.description ? (
                      <span className="block text-xs text-ink-muted">{l.description}</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-end" dir="ltr">
                    {money(l.debitMinor)}
                  </td>
                  <td className="py-2 text-end" dir="ltr">
                    {money(l.creditMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/o/${orgId}/documents/journal_voucher/${entryId}?print=1&lang=${locale}`}
          target="_blank"
          className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink"
        >
          {t("finance.journals.print")}
        </a>
        <a
          href={`/api/o/${orgId}/documents/journal_voucher/${entryId}?format=pdf&lang=${locale}`}
          className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink"
        >
          PDF
        </a>
        {entry.reversedByEntryId ? (
          <Link
            className="text-sm text-accent underline"
            href={`/o/${orgId}/finance/journals/${entry.reversedByEntryId}`}
          >
            {t("finance.journals.reversed_by")}
          </Link>
        ) : null}
        {entry.reversesEntryId ? (
          <Link
            className="text-sm text-accent underline"
            href={`/o/${orgId}/finance/journals/${entry.reversesEntryId}`}
          >
            {t("finance.journals.reverses")}
          </Link>
        ) : null}
      </div>

      {posts && entry.status === "draft" ? (
        <Card>
          <div className="flex flex-wrap gap-2">
            <form action={step}>
              <input type="hidden" name="entry_id" value={entryId} />
              <input type="hidden" name="step" value="post" />
              <Button type="submit">{t("finance.journals.post")}</Button>
            </form>
            <form action={step}>
              <input type="hidden" name="entry_id" value={entryId} />
              <input type="hidden" name="step" value="cancel" />
              <Button type="submit" variant="secondary">
                {t("finance.journals.cancel")}
              </Button>
            </form>
          </div>
        </Card>
      ) : null}

      {posts && entry.status === "posted" && !entry.reversedByEntryId ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.journals.reverse")}</h2>
          <form action={step} className="flex flex-col gap-2 sm:max-w-sm">
            <input type="hidden" name="entry_id" value={entryId} />
            <input type="hidden" name="step" value="reverse" />
            <label className="text-xs text-ink-muted">
              {t("finance.journals.entry_date")}
              <input
                name="date"
                type="date"
                defaultValue={today}
                required
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                dir="ltr"
              />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.journals.reverse_reason")}
              <input
                name="memo"
                required
                maxLength={1000}
                className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </label>
            <Button type="submit" variant="secondary">
              {t("finance.journals.reverse")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
