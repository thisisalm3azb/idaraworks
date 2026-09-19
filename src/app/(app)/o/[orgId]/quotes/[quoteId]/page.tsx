import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, SubmitButton } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import { formatDate } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { getQuote, listQuoteFormOptions } from "@/modules/quotes/service";
import { listDocumentShares } from "@/modules/documents/service";
import { DocumentActions } from "../../documents/DocumentActions";
import { ShareSection } from "../../documents/ShareSection";
import {
  submitQuoteAction,
  sendQuoteAction,
  acceptQuoteAction,
  rejectQuoteAction,
  convertQuoteAction,
  recoverQuoteAction,
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
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobT = term("job", terms, "singular");
  const currency = resolved.baseCurrency as CurrencyCode;
  const q = await getQuote(resolved.ctx, resolved.archetype, quoteId);
  if (!q) notFound();
  const manage = can(resolved.archetype, "quotes.manage");
  const canShare = can(resolved.archetype, "documents.share");
  const shares = canShare
    ? await listDocumentShares(resolved.ctx, resolved.archetype, "quote", quoteId)
    : [];
  // The templates a manager can start the project from, only when that is the next step.
  const presets =
    manage && q.status === "accepted" && q.convertedJobId === null
      ? (await listQuoteFormOptions(resolved.ctx)).presets
      : [];
  const money = (v: number | null) => (v === null ? "🔒" : formatMoney(v, currency));
  const stale = q.staleConversion;
  const stageCopy =
    q.status === "converting"
      ? t(stale ? "quotes.stage.converting_stuck" : "quotes.stage.converting", { job: jobT })
      : t(`quotes.stage.${q.status}`, { job: jobT });
  const okCopy: Record<string, string> = {
    submitted: t("quotes.ok.submitted"),
    sent: t("quotes.ok.sent"),
    rejected: t("quotes.ok.rejected"),
    accepted: t("quotes.ok.accepted", { job: jobT }),
    recovered: t("quotes.ok.recovered", { job: jobT }),
    still_converting: t("quotes.stage.converting", { job: jobT }),
  };
  const errorCopy: Record<string, string> = {
    submit_state: t("quotes.error.submit_state"),
    send_state: t("quotes.error.send_state"),
    accept_state: t("quotes.error.accept_state"),
    reject_state: t("quotes.error.reject_state"),
    convert_state: t("quotes.error.convert_state"),
    action_state: t("quotes.error.state"),
    no_template: t("quotes.error.no_template", { job: jobT }),
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{q.reference}</h1>
        <Badge tone="info">{t(`quotes.status.${q.status}`)}</Badge>
      </div>
      {sp.ok && okCopy[sp.ok] ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {okCopy[sp.ok]}
        </p>
      ) : null}
      {sp.error && errorCopy[sp.error] ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {errorCopy[sp.error]}
        </p>
      ) : null}
      <Card>
        <CardHeader title={t("quotes.stage.title")} />
        <p className="text-sm text-ink">{stageCopy}</p>
        {q.status === "rejected" && q.rejectedReason ? (
          <p className="mt-1 text-sm text-ink-secondary">
            {t("quotes.reject.reason", { reason: q.rejectedReason })}
          </p>
        ) : null}
        {q.status === "pending_approval" ? (
          <Link
            href={`/o/${orgId}/approvals`}
            className="mt-2 inline-block text-sm text-brand hover:underline"
          >
            {t("quotes.stage.open_approvals")}
          </Link>
        ) : null}
        {manage && q.status === "converting" && stale ? (
          <form action={recoverQuoteAction.bind(null, orgId)} className="mt-3">
            <input type="hidden" name="quote_id" value={q.id} />
            <SubmitButton variant="secondary" pendingLabel={t("common.working")}>
              {t("quotes.stage.retry")}
            </SubmitButton>
          </form>
        ) : null}
      </Card>
      <Card>
        <CardHeader title={q.customerName ?? "—"} meta={money(q.totalMinor)} />
        {q.customerId && can(resolved.archetype, "customers.view") ? (
          <p className="mb-2 text-sm">
            <Link
              href={`/o/${orgId}/customers/${q.customerId}`}
              className="text-brand hover:underline"
            >
              {t("crm.back_to_customer")}
            </Link>
          </p>
        ) : null}
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
      <Card>
        <CardHeader title={t("documents.title")} />
        <DocumentActions orgId={orgId} kind="quote" id={q.id} />
      </Card>
      {canShare ? <ShareSection orgId={orgId} kind="quote" id={q.id} shares={shares} /> : null}
      {manage ? (
        <div className="flex flex-col gap-2">
          {q.status === "draft" || q.status === "rejected" ? (
            <form action={submitQuoteAction.bind(null, orgId)}>
              <input type="hidden" name="quote_id" value={q.id} />
              <SubmitButton pendingLabel={t("common.submitting")}>
                {t("quotes.action.submit")}
              </SubmitButton>
            </form>
          ) : null}
          {q.status === "approved" ? (
            <form action={sendQuoteAction.bind(null, orgId)}>
              <input type="hidden" name="quote_id" value={q.id} />
              <SubmitButton pendingLabel={t("common.working")}>
                {t("quotes.action.send")}
              </SubmitButton>
            </form>
          ) : null}
          {(q.status === "approved" || q.status === "sent") && q.convertedJobId === null ? (
            <>
              {q.presetId === null ? (
                <p className="text-xs text-ink-muted">
                  {t("quotes.accept.no_template_hint", { job: jobT })}
                </p>
              ) : null}
              <form action={acceptQuoteAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="quote_id" value={q.id} />
                <input
                  name="note"
                  placeholder={t("quotes.action.accept_note")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <SubmitButton variant="primary" pendingLabel={t("common.working")}>
                  {t("quotes.action.accept")}
                </SubmitButton>
              </form>
              <form action={rejectQuoteAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="quote_id" value={q.id} />
                <input
                  name="reason"
                  required
                  placeholder={t("quotes.action.reject_reason")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <SubmitButton variant="danger" pendingLabel={t("common.working")}>
                  {t("quotes.action.reject")}
                </SubmitButton>
              </form>
            </>
          ) : null}
          {q.status === "accepted" && q.convertedJobId === null ? (
            <Card>
              <CardHeader
                title={t("quotes.convert.title", { job: jobT })}
                meta={
                  q.acceptedAt
                    ? t("quotes.accept.accepted_on", { date: formatDate(q.acceptedAt) })
                    : undefined
                }
              />
              <p className="mb-3 text-xs text-ink-muted">
                {t("quotes.convert.hint", { job: jobT })}
              </p>
              {presets.length === 0 ? (
                <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-sm text-ink">
                  {t("quotes.convert.no_presets", { job: jobT })}
                </p>
              ) : null}
              <form action={convertQuoteAction.bind(null, orgId)} className="flex flex-col gap-2">
                <input type="hidden" name="quote_id" value={q.id} />
                <label className="text-xs text-ink-muted">
                  {t("quotes.convert.template")}
                  <select
                    name="preset_id"
                    required
                    defaultValue=""
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  >
                    <option value="" disabled>
                      {t("quotes.convert.pick")}
                    </option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-muted">
                  {t("quotes.convert.job_name", { job: jobT })}
                  <input
                    name="job_name"
                    maxLength={160}
                    className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  />
                </label>
                <SubmitButton variant="primary" pendingLabel={t("common.creating")}>
                  {t("quotes.convert.cta", { job: jobT })}
                </SubmitButton>
              </form>
            </Card>
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
