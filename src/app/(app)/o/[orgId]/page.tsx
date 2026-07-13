import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { composeToday, type TodayCard } from "@/modules/today/service";
import { getOwnerDigest, type DigestSection } from "@/modules/digest/service";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { dismissExceptionAction } from "./actions";

const SEV_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  info: "info",
  warning: "warning",
  critical: "danger",
};
// Manager exception cards carry a dismiss action (owner/admin/manager, audience+scope).
const EXCEPTION_CARDS = new Set(["missing_reports", "overdue", "blockers"]);

export default async function OrgHome({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();

  // The S5 Today screens are FOREMAN + MANAGER (management sees the manager view).
  if (!can(resolved.archetype, "today.view")) {
    return (
      <EmptyState
        title={t("today.other_role.title")}
        description={t("today.other_role.description")}
      />
    );
  }

  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobVars = {
    job: term("job", terms, "singular"),
    jobs: term("job", terms, "plural"),
  };
  const now = new Date();
  const payload = await composeToday(resolved.ctx, resolved.archetype, {
    asOf: now.toISOString().slice(0, 10),
    computedAt: now.toISOString(),
  });
  const canDismiss = can(resolved.archetype, "exceptions.dismiss");
  // S7: the owner digest card (doc 03 card 6) — the persisted deterministic digest, narrated
  // when AI is enabled, always readable without it. Money redacts per the reader (getOwnerDigest).
  const digest = can(resolved.archetype, "digest.view")
    ? await getOwnerDigest(resolved.ctx, resolved.archetype)
    : null;
  const currency = resolved.baseCurrency as CurrencyCode;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("today.title")}</h1>
        <Badge tone="neutral">{t(`today.screen.${payload.screen}`)}</Badge>
      </div>
      {sp.ok === "dismissed" ? (
        <Badge tone="success">{t("today.dismissed")}</Badge>
      ) : sp.error ? (
        <Badge tone="danger">{t("common.error")}</Badge>
      ) : null}

      {digest ? (
        <Card>
          <CardHeader
            title={t("digest.title")}
            meta={
              <span className="text-xs text-ink-muted">{`${t("today.card_as_of")} ${digest.computedAt.slice(11, 16)}`}</span>
            }
          />
          {digest.narration ? (
            <p className="mb-2 text-sm leading-relaxed text-ink">{digest.narration}</p>
          ) : null}
          <ul className="flex flex-col">
            {digest.sections
              .filter((s) => s.count > 0 || s.moneyMinor)
              .map((s) => (
                <DigestRow
                  key={s.key}
                  section={s}
                  orgId={orgId}
                  label={t(s.labelKey)}
                  currency={currency}
                />
              ))}
          </ul>
          {digest.sections.every((s) => s.count === 0 && !s.moneyMinor) ? (
            <p className="text-xs text-ink-muted">{t("digest.all_clear")}</p>
          ) : null}
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {payload.cards.map((card) => (
          <TodayCardView
            key={card.key}
            card={card}
            orgId={orgId}
            title={t(`today.card.${card.key}`, jobVars)}
            emptyLabel={t("today.card_empty")}
            canDismiss={canDismiss && EXCEPTION_CARDS.has(card.key)}
            dismissLabel={t("today.dismiss")}
            severityLabel={(s: string) => t(`exceptions.severity.${s}`)}
          />
        ))}
      </div>
    </div>
  );
}

// Deep-link target per digest section (evidence links come from the structured source).
const DIGEST_LINK: Record<string, string> = {
  needs_decision: "approvals",
  at_risk: "week",
  collections: "ar",
  supply: "purchase-orders",
  yesterday: "reports/review",
  crew: "week",
  customers_awaiting: "customer-updates",
  this_week: "week",
};

function DigestRow({
  section,
  orgId,
  label,
  currency,
}: {
  section: DigestSection;
  orgId: string;
  label: string;
  currency: CurrencyCode;
}) {
  const href = `/o/${orgId}/${DIGEST_LINK[section.key] ?? ""}`;
  return (
    <li className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0">
      <Link href={href} className="text-ink hover:underline">
        {label}
      </Link>
      <span className="flex items-center gap-2 font-mono text-ink" dir="ltr">
        {section.moneyMinor !== null ? formatMoney(section.moneyMinor, currency) : null}
        <Badge tone={section.count > 0 ? "brand" : "neutral"}>{section.count}</Badge>
      </span>
    </li>
  );
}

function TodayCardView({
  card,
  orgId,
  title,
  emptyLabel,
  canDismiss,
  dismissLabel,
  severityLabel,
}: {
  card: TodayCard;
  orgId: string;
  title: string;
  emptyLabel: string;
  canDismiss: boolean;
  dismissLabel: string;
  severityLabel: (s: string) => string;
}) {
  const asOf = new Date(card.freshness.computedAt).toISOString().slice(11, 16);
  return (
    <Card>
      <CardHeader
        title={title}
        meta={
          <span className="flex items-center gap-2 text-xs text-ink-muted">
            <Badge tone={card.count > 0 ? "brand" : "neutral"}>{card.count}</Badge>
            <span>{`as of ${asOf}`}</span>
          </span>
        }
      />
      {card.count === 0 ? (
        <p className="text-xs text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {card.items.slice(0, 8).map((item, i) => (
            <li
              key={String(item.id ?? i)}
              className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
            >
              <span className="min-w-0 truncate text-ink">
                {typeof item.severity === "string" ? (
                  <Badge tone={SEV_TONE[item.severity] ?? "neutral"}>
                    {severityLabel(item.severity)}
                  </Badge>
                ) : null}{" "}
                {itemLabel(item, orgId)}
              </span>
              {canDismiss && typeof item.id === "string" ? (
                <form action={dismissExceptionAction.bind(null, orgId)}>
                  <input type="hidden" name="exception_id" value={item.id} />
                  <Button type="submit" variant="ghost">
                    {dismissLabel}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function itemLabel(item: Record<string, unknown>, orgId: string) {
  const ref = (item.reference as string | undefined) ?? (item.name as string | undefined);
  const jobId = item.jobId as string | undefined;
  const label = ref ?? (typeof item.reportDate === "string" ? item.reportDate : "—");
  if (jobId) {
    return (
      <Link href={`/o/${orgId}/jobs/${jobId}`} className="text-brand hover:underline">
        {label}
      </Link>
    );
  }
  return <span>{label}</span>;
}
