import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale, type Translator } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listMyNotifications } from "@/platform/notifications";
import { hrAttentionFeed, type HrAttentionItem } from "@/modules/hr/service";
import { attentionFeed, type AttentionItem } from "@/modules/inventory/service";
import { formatDate } from "@/platform/format";
import { stockSurfacesEnabled, hrSurfacesEnabled } from "@/platform/flags";
import { markReadAction } from "./actions";

/**
 * The inbox (H22F).
 *
 * This exists because of a rule H22 set for itself: do not build alerts with no
 * visible inbox. Notifications were already being written — approvals, seat
 * invitations, subscription changes — and nothing in the product ever showed
 * them to anybody. Every one of those was an alert nobody could receive.
 *
 * Two lists, deliberately separate, because they are different kinds of fact.
 *
 * NEEDS ATTENTION is computed now, from the data, every time this page loads:
 * stock below its reorder point, batches near their date, services falling due.
 * Nothing happens at the moment any of those becomes true, so there is no event
 * to store — and this system has no worker to check on a schedule. Computing it
 * on read cannot go stale and cannot silently stop.
 *
 * NOTIFICATIONS are things that HAPPENED and were addressed to this person. They
 * are stored, they are read once, and they stay read.
 *
 * Mobile first: this is a page a foreman opens on a phone in a workshop, so
 * every row is a card with a full-width tap target rather than a table.
 */
export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ all?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const showAll = sp.all === "1";

  const notifications = await listMyNotifications(resolved.ctx, !showAll, { limit: 50 });

  /*
   * The attention half is RELEASE gated as well as permission gated.
   *
   * It reports stock levels, batch dates and asset servicing — the H22 system
   * that is not released yet. Ungated, this inbox would start announcing an
   * unfinished feature to a customer the moment the first row landed in those
   * tables, on a deployment where every screen it refers to answers 404.
   *
   * The notification half below is NOT gated: approvals, seat invitations and
   * subscription changes are all shipped, and until this page existed there was
   * nowhere to read any of them.
   *
   * A viewer without the stock permission simply gets the notification half. An
   * empty attention section would imply nothing needs attention, which is a
   * different claim from "not yours to see".
   */
  const attention =
    stockSurfacesEnabled() && can(resolved.archetype, "inventory.view")
      ? await attentionFeed(resolved.ctx, resolved.archetype)
      : null;

  /*
   * H23H — the HR half of "what needs attention", under the same two gates:
   * released (FEATURE_HR_SURFACES) and permitted (employees.view). Probation
   * decisions, expiring documents, ending contracts and waiting pay runs are
   * date-truths computed on read, exactly like the stock feed above.
   */
  const hrAttention =
    hrSurfacesEnabled() && can(resolved.archetype, "employees.view")
      ? await hrAttentionFeed(resolved.ctx, resolved.archetype)
      : null;

  const markRead = markReadAction.bind(null, orgId);
  const unread = notifications.filter((n) => n.readAt === null).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("inbox.title")}</h1>
        <Link
          href={`/o/${orgId}/inbox${showAll ? "" : "?all=1"}`}
          className="text-sm text-ink-secondary underline underline-offset-4"
        >
          {showAll ? t("inbox.show_unread") : t("inbox.show_all")}
        </Link>
      </div>

      {attention && attention.items.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink-secondary">{t("inbox.attention")}</h2>
          <ul className="flex flex-col gap-3">
            {attention.items.map((item) => (
              <li key={`${item.kind}:${item.entityId}:${item.on ?? ""}`}>
                <AttentionRow orgId={orgId} item={item} locale={locale} t={t} />
              </li>
            ))}
          </ul>
          {attention.truncated ? (
            /*
             * Said out loud. A capped list that does not admit it is capped
             * reads as "this is everything", which is exactly the wrong thing
             * to believe about a list of problems.
             */
            <p className="text-xs text-ink-muted">{t("inbox.attention_truncated")}</p>
          ) : null}
        </section>
      ) : null}

      {hrAttention && hrAttention.items.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink-secondary">{t("inbox.attention_hr")}</h2>
          <ul className="flex flex-col gap-3">
            {hrAttention.items.map((item) => (
              <li key={`${item.kind}:${item.entityId}:${item.on ?? ""}`}>
                <HrAttentionRow orgId={orgId} item={item} locale={locale} t={t} />
              </li>
            ))}
          </ul>
          {hrAttention.truncated ? (
            <p className="text-xs text-ink-muted">{t("inbox.attention_truncated")}</p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink-secondary">
          {t("inbox.notifications")}
          {unread > 0 ? ` (${unread})` : ""}
        </h2>
        {notifications.length === 0 ? (
          <EmptyState title={showAll ? t("inbox.empty_all") : t("inbox.empty_unread")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {notifications.map((n) => (
              <li key={n.id}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">{n.title}</span>
                      {n.readAt === null ? <Badge tone="info">{t("inbox.unread")}</Badge> : null}
                    </div>
                    {n.body ? <p className="text-sm text-ink-secondary">{n.body}</p> : null}
                    <span className="text-xs text-ink-muted">
                      {formatDate(n.createdAt.slice(0, 10), { locale })}
                    </span>
                    {n.readAt === null ? (
                      <form action={markRead}>
                        <input type="hidden" name="id" value={n.id} />
                        <Button type="submit" variant="secondary">
                          {t("inbox.mark_read")}
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One thing that wants doing something about, with a way to go and do it. */
function AttentionRow({
  orgId,
  item,
  locale,
  t,
}: {
  orgId: string;
  item: AttentionItem;
  locale: "en" | "ar";
  t: Translator;
}) {
  /*
   * The wording is chosen here, in the reader's language, from facts the module
   * supplied. A stored name has no catalogue entry — it falls back to English
   * when the org never gave it an Arabic one, which is the honest choice: a
   * blank is worse than a name in the wrong language.
   */
  const name = item.name ? (locale === "ar" ? (item.name.ar ?? item.name.en) : item.name.en) : "";
  const vars = { ...item.vars, name, date: item.on ? formatDate(item.on, { locale }) : "" };
  /*
   * The section only renders when the screens are released, so by the time a
   * row reaches here there is always somewhere to go.
   */
  const href =
    item.entityType === "asset"
      ? `/o/${orgId}/assets/${item.entityId}`
      : `/o/${orgId}/stock/${item.entityId}`;
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-ink">{t(`inbox.attn.${item.kind}.title`, vars)}</span>
          <Badge tone={item.severity === "urgent" ? "danger" : "warning"}>
            {t(`inbox.severity_${item.severity}`)}
          </Badge>
        </div>
        <p className="text-sm text-ink-secondary">{t(`inbox.attn.${item.kind}.detail`, vars)}</p>
        <Link
          href={href}
          className="inline-flex min-h-11 items-center text-sm text-ink underline underline-offset-4"
        >
          {t("inbox.open_item")}
        </Link>
      </div>
    </Card>
  );
}

/** One HR concern, worded by the catalogue from the module's facts (H23H). */
function HrAttentionRow({
  orgId,
  item,
  locale,
  t,
}: {
  orgId: string;
  item: HrAttentionItem;
  locale: "en" | "ar";
  t: Translator;
}) {
  const name = item.name ? (locale === "ar" ? (item.name.ar ?? item.name.en) : item.name.en) : "";
  const vars = { ...item.vars, name, date: item.on ? formatDate(item.on, { locale }) : "" };
  const href =
    item.entityType === "pay_run"
      ? `/o/${orgId}/payroll/${item.entityId}`
      : `/o/${orgId}/people`;
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-ink">{t(`inbox.attn.${item.kind}.title`, vars)}</span>
          <Badge tone={item.severity === "urgent" ? "danger" : "warning"}>
            {t(`inbox.severity_${item.severity}`)}
          </Badge>
        </div>
        <p className="text-sm text-ink-secondary">{t(`inbox.attn.${item.kind}.detail`, vars)}</p>
        <Link
          href={href}
          className="inline-flex min-h-11 items-center text-sm text-ink underline underline-offset-4"
        >
          {t("inbox.open_item")}
        </Link>
      </div>
    </Card>
  );
}
