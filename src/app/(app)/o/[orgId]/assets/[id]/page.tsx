import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { assetDetail } from "@/modules/assets/service";
import { formatDate, formatDateTime, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

/**
 * One asset (H22F).
 *
 * The record of a physical object's whole life: what it is, where it came from,
 * who has it, what has been done to it, and — if it has gone — how it went.
 *
 * Nothing on this page is editable. H22F delivers the register as something a
 * business can READ; the actions H22E built (assign, transfer, inspect, service,
 * dispose) each need their own considered form, and a half-wired button that
 * loses somebody's reason text is worse than no button. What is here is honest
 * about what it is.
 *
 * A disposed asset renders exactly like a live one, with its disposal at the
 * top. That is the point of keeping the history readable.
 */
export default async function AssetPage({
  params,
}: {
  params: Promise<{ orgId: string; id: string }>;
}) {
  if (!stockSurfacesEnabled()) notFound();

  const { orgId, id } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "assets.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();

  const detail = await assetDetail(resolved.ctx, resolved.archetype, id);
  if (!detail) notFound();
  const { asset: a } = detail;
  const name = locale === "ar" && a.nameAr ? a.nameAr : a.nameEn;
  const money = (minor: number | null, currency: string | null) =>
    minor !== null && currency ? formatMoney(minor, currency as CurrencyCode, { locale }) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">{name}</h1>
            <p className="text-sm text-ink-muted">{a.assetNo}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={toneFor(a.status)}>{t(`assets.status.${a.status}`)}</Badge>
            <Badge tone="neutral">{t(`assets.condition.${a.condition}`)}</Badge>
          </div>
        </div>
        {a.descriptionEn ? (
          <p className="mt-2 text-sm text-ink-secondary">{a.descriptionEn}</p>
        ) : null}
        <p className="mt-2 text-xs text-ink-muted">
          <Link href={`/o/${orgId}/assets`} className="underline">
            {t("assets.title")}
          </Link>
        </p>
      </Card>

      {/*
       * Retirement and disposal go FIRST, not last. Somebody opening the record
       * of a machine that no longer exists needs to know that in the first line
       * they read, not after scrolling past its service history.
       */}
      {a.disposedAt || a.retiredAt ? (
        <Card>
          <CardHeader title={a.disposedAt ? t("assets.disposed") : t("assets.retired")} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {a.disposedAt ? (
              <Row label={t("assets.disposed_on")} value={formatDate(a.disposedAt, { locale })} />
            ) : null}
            {a.retiredAt ? (
              <Row label={t("assets.retired_on")} value={formatDate(a.retiredAt, { locale })} />
            ) : null}
            {a.retiredReason ? <Row label={t("common.reason")} value={a.retiredReason} /> : null}
          </dl>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("assets.identity")} />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row label={t("assets.category")} value={a.categoryName} />
          <Row label={t("assets.serial")} value={a.serialNo} />
          <Row label={t("assets.barcode")} value={a.barcode} />
          <Row label={t("assets.custodian")} value={a.custodianName} />
          {a.custodianSince ? (
            <Row
              label={t("assets.custodian_since")}
              value={formatDate(a.custodianSince, { locale })}
            />
          ) : null}
          <Row
            label={t("assets.location")}
            value={
              a.locationName && a.warehouseName
                ? `${a.warehouseName} · ${a.locationName}`
                : (a.locationName ?? a.warehouseName ?? a.siteNote)
            }
          />
        </dl>
      </Card>

      <Card>
        <CardHeader title={t("assets.acquisition")} />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row
            label={t("assets.source")}
            value={a.acquisitionSource ? t(`assets.source_kind.${a.acquisitionSource}`) : null}
          />
          <Row
            label={t("assets.acquired_on")}
            value={a.acquiredOn ? formatDate(a.acquiredOn, { locale }) : null}
          />
          <Row label={t("assets.supplier")} value={a.supplierName} />
          {a.purchaseOrderId && a.purchaseOrderNo ? (
            <div className="flex flex-col">
              <dt className="text-xs text-ink-muted">{t("assets.purchase_order")}</dt>
              <dd className="text-sm text-ink">
                <Link
                  href={`/o/${orgId}/purchase-orders/${a.purchaseOrderId}`}
                  className="underline"
                >
                  {a.purchaseOrderNo}
                </Link>
              </dd>
            </div>
          ) : null}
          {/*
           * Provenance. A serialized asset that came in through a goods receipt
           * keeps its inventory identity — H22E's rule that receiving an asset
           * must not erase where it came from. Shown, because a person auditing
           * an asset is exactly the person who needs to follow that thread.
           */}
          {a.stockSerialNo && a.itemId ? (
            <div className="flex flex-col">
              <dt className="text-xs text-ink-muted">{t("assets.from_stock")}</dt>
              <dd className="text-sm text-ink">
                <Link href={`/o/${orgId}/stock/${a.itemId}`} className="underline">
                  {a.stockSerialNo}
                </Link>
              </dd>
            </div>
          ) : null}
          {/*
           * Cost is inside the wall. When it is redacted the row is simply not
           * drawn — a row reading "—" where money belongs invites the reader to
           * conclude nobody recorded it.
           */}
          {money(a.acquisitionCostMinor, a.currency) ? (
            <Row label={t("assets.cost")} value={money(a.acquisitionCostMinor, a.currency)} />
          ) : null}
          {money(a.residualValueMinor, a.currency) ? (
            <Row label={t("assets.residual")} value={money(a.residualValueMinor, a.currency)} />
          ) : null}
          {a.usefulLifeMonths !== null ? (
            <Row
              label={t("assets.useful_life")}
              value={t("assets.months", { n: a.usefulLifeMonths })}
            />
          ) : null}
        </dl>
        {a.acquisitionCostMinor !== null || a.usefulLifeMonths !== null ? (
          /*
           * Said plainly, because the numbers above look exactly like the inputs
           * to a depreciation schedule and this phase deliberately does not
           * calculate one. H24 owns that; recording what a thing cost and how
           * long it should last is not the same as claiming a book value.
           */
          <p className="mt-3 text-xs text-ink-muted">{t("assets.no_depreciation")}</p>
        ) : null}
      </Card>

      {a.warrantyEndOn ? (
        <Card>
          <CardHeader title={t("assets.warranty")} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <Row label={t("assets.warranty_provider")} value={a.warrantyProvider} />
            <Row
              label={t("assets.warranty_from")}
              value={a.warrantyStartOn ? formatDate(a.warrantyStartOn, { locale }) : null}
            />
            <Row
              label={t("assets.warranty_until")}
              value={formatDate(a.warrantyEndOn, { locale })}
            />
          </dl>
        </Card>
      ) : null}

      {detail.disposals.length > 0 ? (
        <Card>
          <CardHeader title={t("assets.disposal_history")} />
          <ul className="divide-y divide-line">
            {detail.disposals.map((d) => (
              <li key={d.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {d.reference} · {t(`assets.disposal_method.${d.method}`)}
                  </span>
                  <Badge tone={d.status === "completed" ? "neutral" : "warning"}>
                    {t(`assets.disposal_status.${d.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-ink-secondary">{d.reason}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {t("assets.requested_by", {
                    who: d.requestedByName ?? "—",
                    when: formatDate(d.requestedAt, { locale }),
                  })}
                  {d.decidedAt
                    ? ` · ${t("assets.decided_by", {
                        who: d.decidedByName ?? "—",
                        when: formatDate(d.decidedAt, { locale }),
                      })}`
                    : ""}
                </p>
                {d.decisionNote ? (
                  <p className="mt-1 text-xs text-ink-secondary">{d.decisionNote}</p>
                ) : null}
                {money(d.actualProceedsMinor, d.currency) ? (
                  <p className="mt-1 text-xs text-ink-muted">
                    {t("assets.proceeds", { amount: money(d.actualProceedsMinor, d.currency)! })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("assets.custody_history")} />
        {detail.custody.length === 0 ? (
          <EmptyState title={t("assets.no_custody")} />
        ) : (
          <ul className="divide-y divide-line">
            {detail.custody.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {t(`assets.event.${e.event}`)}
                  </span>
                  {/*
                   * A correction is shown as its own event pointing at the one
                   * it fixes, never as a quiet edit of the original. The trail
                   * is append-only in the database; it would be dishonest for
                   * the screen to present it as anything else.
                   */}
                  {e.correctsId ? <Badge tone="neutral">{t("assets.is_correction")}</Badge> : null}
                </div>
                <p className="text-xs text-ink-muted">
                  {[e.fromName, e.toName].filter(Boolean).join(" → ") ||
                    [e.fromLocationName, e.toLocationName].filter(Boolean).join(" → ") ||
                    ""}
                  {e.fromName || e.toName || e.fromLocationName || e.toLocationName ? " · " : ""}
                  {formatDateTime(e.effectiveAt, { locale })}
                </p>
                {e.reason ? <p className="mt-1 text-xs text-ink-secondary">{e.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {detail.plans.length > 0 ? (
        <Card>
          <CardHeader title={t("assets.maintenance_plans")} />
          <ul className="divide-y divide-line">
            {detail.plans.map((p) => {
              return (
                <li key={p.id} className="flex min-h-14 items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {locale === "ar" && p.nameAr ? p.nameAr : p.nameEn}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {p.nextDueOn
                        ? t("assets.next_due", { date: formatDate(p.nextDueOn, { locale }) })
                        : t("assets.not_scheduled")}
                    </p>
                  </div>
                  {p.overdue ? <Badge tone="danger">{t("assets.overdue")}</Badge> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {detail.maintenance.length > 0 ? (
        <Card>
          <CardHeader title={t("assets.maintenance_history")} />
          <ul className="divide-y divide-line">
            {detail.maintenance.map((m) => (
              <li key={m.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {t(`assets.maintenance_kind.${m.kind}`)}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {formatDate(m.performedOn, { locale })}
                  </span>
                </div>
                <p className="text-xs text-ink-muted">
                  {[m.planName, m.vendorName ?? m.performedByName].filter(Boolean).join(" · ")}
                </p>
                {/*
                 * Maintenance done as a JOB links back to that job. H22E was
                 * explicit that maintenance work rides H21's engine rather than
                 * growing a second one, and this link is where that shows.
                 */}
                {m.jobId ? (
                  <p className="mt-1 text-xs">
                    <Link href={`/o/${orgId}/jobs/${m.jobId}`} className="text-brand underline">
                      {t("assets.open_work")}
                    </Link>
                  </p>
                ) : null}
                {m.notes ? <p className="mt-1 text-xs text-ink-secondary">{m.notes}</p> : null}
                {money(m.costMinor, m.currency) ? (
                  <p className="mt-1 text-xs text-ink-muted">{money(m.costMinor, m.currency)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {detail.inspections.length > 0 ? (
        <Card>
          <CardHeader title={t("assets.inspections")} />
          <ul className="divide-y divide-line">
            {detail.inspections.map((i) => (
              <li key={i.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {t(`assets.inspection_kind.${i.kind}`)}
                  </span>
                  <Badge tone={i.passed ? "success" : "danger"}>
                    {i.passed ? t("assets.passed") : t("assets.failed")}
                  </Badge>
                </div>
                <p className="text-xs text-ink-muted">
                  {[i.inspectedByName, formatDate(i.inspectedOn, { locale })]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {i.findings ? (
                  <p className="mt-1 text-xs text-ink-secondary">{i.findings}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {detail.downtime.length > 0 ? (
        <Card>
          <CardHeader title={t("assets.downtime")} />
          <ul className="divide-y divide-line">
            {detail.downtime.map((d) => (
              <li key={d.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {t(`assets.downtime_reason.${d.reason}`)}
                  </span>
                  {d.endedAt === null ? (
                    <Badge tone="warning">{t("assets.still_down")}</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-ink-muted">
                  {formatDateTime(d.startedAt, { locale })}
                  {d.endedAt ? ` → ${formatDateTime(d.endedAt, { locale })}` : ""}
                </p>
                {d.detail ? <p className="mt-1 text-xs text-ink-secondary">{d.detail}</p> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {detail.truncated ? (
        <p className="text-xs text-ink-muted">{t("assets.history_truncated")}</p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

function toneFor(status: string): "success" | "warning" | "neutral" | "danger" {
  if (status === "in_service" || status === "in_storage") return "success";
  if (status === "under_maintenance" || status === "in_transit") return "warning";
  if (status === "lost") return "danger";
  return "neutral";
}
