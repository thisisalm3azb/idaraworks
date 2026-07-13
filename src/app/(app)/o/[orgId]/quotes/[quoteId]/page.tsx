import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { getQuote } from "@/modules/quotes/service";
import {
  submitQuoteAction,
  sendQuoteAction,
  acceptQuoteAction,
  rejectQuoteAction,
} from "../actions";

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; quoteId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, quoteId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "quotes.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const q = await getQuote(resolved.ctx, resolved.archetype, quoteId);
  if (!q) notFound();
  const manage = can(resolved.archetype, "quotes.manage");
  const money = (v: number | null) => (v === null ? "🔒" : formatMoney(v, currency));

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{q.reference}</h1>
        <Badge tone="info">{t(`quotes.status.${q.status}`)}</Badge>
      </div>
      {sp.ok ? <Badge tone="success">{t("common.saved")}</Badge> : null}
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader title={q.customerName ?? "—"} meta={money(q.totalMinor)} />
        <ul className="flex flex-col gap-1 text-sm">
          {q.lines.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between gap-2 border-b border-line py-1"
            >
              <span className="truncate text-ink">{l.description}</span>
              <span className="font-mono text-ink-muted" dir="ltr">
                {l.qty} {l.unit} · {money(l.lineTotalMinor)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {manage ? (
        <div className="flex flex-col gap-2">
          {q.status === "draft" || q.status === "rejected" ? (
            <form action={submitQuoteAction.bind(null, orgId)}>
              <input type="hidden" name="quote_id" value={q.id} />
              <Button type="submit">{t("quotes.action.submit")}</Button>
            </form>
          ) : null}
          {q.status === "approved" ? (
            <form action={sendQuoteAction.bind(null, orgId)}>
              <input type="hidden" name="quote_id" value={q.id} />
              <Button type="submit">{t("quotes.action.send")}</Button>
            </form>
          ) : null}
          {(q.status === "approved" || q.status === "sent") && q.convertedJobId === null ? (
            <>
              <form action={acceptQuoteAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="quote_id" value={q.id} />
                <input
                  name="note"
                  placeholder={t("quotes.action.accept_note")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <Button type="submit" variant="primary">
                  {t("quotes.action.accept")}
                </Button>
              </form>
              <form action={rejectQuoteAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="quote_id" value={q.id} />
                <input
                  name="reason"
                  required
                  placeholder={t("quotes.action.reject_reason")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <Button type="submit" variant="danger">
                  {t("quotes.action.reject")}
                </Button>
              </form>
            </>
          ) : null}
          {q.convertedJobId ? (
            <Link
              href={`/o/${orgId}/jobs/${q.convertedJobId}`}
              className="text-sm text-brand hover:underline"
            >
              {t("quotes.converted_job")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
