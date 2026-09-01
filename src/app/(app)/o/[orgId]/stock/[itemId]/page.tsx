import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import type { Translator } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import {
  itemStock,
  listItemLots,
  listItemSerials,
  listMovements,
  getStockItem,
  type MovementRow,
} from "@/modules/inventory/service";

import { formatDate, formatDateTime, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

/**
 * One item's stock (H22F).
 *
 * Four questions, in the order somebody actually asks them: where is it, which
 * batches are they, which individual units are they, and what happened to it.
 *
 * The last section is the ledger — the append-only record H22B built. It is
 * shown as HISTORY, not as an editable list, because that is what it is: a
 * reversal appears as its own line pointing at what it undid, and nothing here
 * ever disappears. That property is the whole reason the ledger exists, so the
 * screen should make it visible rather than tidy it away.
 */
export default async function ItemStockPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  if (!stockSurfacesEnabled()) notFound();

  const { orgId, itemId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "inventory.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();

  // An item from another organization is NOT FOUND, never "forbidden": the
  // second answer confirms the id exists somewhere, which is a tenancy leak
  // dressed as good manners.
  const item = await getStockItem(resolved.ctx, resolved.archetype, itemId);
  if (!item) notFound();

  const [balances, lots, serials, movements] = await Promise.all([
    itemStock(resolved.ctx, resolved.archetype, itemId),
    listItemLots(resolved.ctx, resolved.archetype, itemId, { limit: 50 }),
    listItemSerials(resolved.ctx, resolved.archetype, itemId, { limit: 50 }),
    listMovements(resolved.ctx, resolved.archetype, {
      itemId,
      cursor: sp.cursor,
      limit: 50,
    }),
  ]);

  const totalOnHand = balances.reduce((sum, b) => sum + Number(b.onHand), 0);
  const totalAvailable = balances.reduce((sum, b) => sum + Number(b.available), 0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={`${item.sku} — ${item.name}`} />
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p className="text-2xl font-semibold text-ink">
            {totalAvailable}{" "}
            <span className="text-base font-normal text-ink-muted">{item.uom}</span>
          </p>
          {totalOnHand !== totalAvailable ? (
            <p className="text-sm text-ink-secondary">
              {t("stock.on_hand_vs_available", {
                onHand: String(totalOnHand),
                available: String(totalAvailable),
              })}
            </p>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          <Link href={`/o/${orgId}/stock`} className="underline">
            {t("stock.title")}
          </Link>
        </p>
      </Card>

      <Card>
        <CardHeader title={t("stock.by_location")} />
        {balances.length === 0 ? (
          <EmptyState title={t("stock.none_held")} />
        ) : (
          <ul className="divide-y divide-line">
            {balances.map((b) => (
              <li
                key={b.locationId}
                className="flex min-h-14 items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{b.locationName}</p>
                  <p className="text-xs text-ink-muted">{b.warehouseName}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-ink">
                    {b.available} {item.uom}
                  </p>
                  {Number(b.reserved) !== 0 ? (
                    <p className="text-xs text-ink-muted">
                      {t("stock.reserved", { n: b.reserved })}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {lots.length > 0 ? (
        <Card>
          <CardHeader title={t("stock.batches")} />
          <ul className="divide-y divide-line">
            {lots.map((l) => {
              return (
                <li key={l.id} className="flex min-h-14 items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{l.code}</p>
                    {l.expiryDate ? (
                      <p className="text-xs text-ink-muted">
                        {t("stock.expires", { date: formatDate(l.expiryDate, { locale }) })}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm text-ink">
                      {l.onHand} {item.uom}
                    </span>
                    {l.expired ? <Badge tone="danger">{t("stock.expired")}</Badge> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {serials.rows.length > 0 ? (
        <Card>
          <CardHeader title={t("stock.serials")} />
          <ul className="divide-y divide-line">
            {serials.rows.map((s) => (
              <li key={s.id} className="flex min-h-14 items-center justify-between gap-3 py-3">
                <p className="truncate text-sm font-medium text-ink">{s.serialNo}</p>
                <div className="flex shrink-0 items-center gap-2">
                  {s.locationName ? (
                    <span className="text-xs text-ink-muted">{s.locationName}</span>
                  ) : null}
                  <Badge tone={s.status === "in_stock" ? "success" : "neutral"}>
                    {t(`stock.serial_status.${s.status}`)}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
          {serials.hasMore ? (
            <p className="mt-3 text-xs text-ink-muted">{t("stock.serials_truncated")}</p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("stock.history")} />
        {movements.rows.length === 0 ? (
          <EmptyState title={t("stock.no_history")} />
        ) : (
          <ul className="divide-y divide-line">
            {movements.rows.map((m) => (
              <li key={m.id}>
                <MovementLine m={m} uom={item.uom} locale={locale} t={t} />
              </li>
            ))}
          </ul>
        )}
        {movements.nextCursor ? (
          <div className="mt-3 flex items-center gap-4">
            <Link
              href={`/o/${orgId}/stock/${itemId}?cursor=${encodeURIComponent(movements.nextCursor)}`}
              className="inline-flex min-h-11 items-center text-sm text-brand underline"
            >
              {t("common.next")}
            </Link>
            {sp.cursor ? (
              <Link
                href={`/o/${orgId}/stock/${itemId}`}
                className="inline-flex min-h-11 items-center text-sm text-ink-secondary underline"
              >
                {t("stock.back_to_start")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/** One ledger line: what happened, where, how much, and what it cost. */
function MovementLine({
  m,
  uom,
  locale,
  t,
}: {
  m: MovementRow;
  uom: string;
  locale: "en" | "ar";
  t: Translator;
}) {
  /*
   * A reservation moves NOTHING physically: it posts qty_delta 0 and a
   * reserved_delta. Reading only the quantity rendered every reservation and
   * release as "−0 pcs" — a line that says nothing happened, about the event
   * that is the entire reason the stock is unavailable. So the line shows
   * whichever of the two this movement actually changed.
   */
  const physical = Number(m.qtyDelta) !== 0;
  const delta = physical ? Number(m.qtyDelta) : Number(m.reservedDelta);
  const inbound = delta > 0;
  return (
    <div className="flex min-h-14 items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {t(`stock.movement.${m.movementType}`)}
          {m.reversesMovementId ? (
            <span className="ms-2 align-middle">
              <Badge tone="neutral">{t("stock.is_reversal")}</Badge>
            </span>
          ) : null}
        </p>
        <p className="text-xs text-ink-muted">
          {m.locationName} · {formatDateTime(m.effectiveAt, { locale })}
        </p>
        {m.note ? <p className="mt-1 text-xs text-ink-secondary">{m.note}</p> : null}
      </div>
      <div className="shrink-0 text-right">
        {/*
         * The sign is spelled out rather than left to a minus glyph: at a
         * glance, on a phone, "-2" and "2" are one pixel apart, and getting
         * the direction of a stock movement wrong is the expensive mistake.
         */}
        <p className={`text-sm font-medium ${inbound ? "text-success" : "text-ink"}`}>
          {inbound ? "+" : "−"}
          {Math.abs(delta)} {uom}
        </p>
        {/* Said, so a promise is never mistaken for stock arriving or leaving. */}
        {!physical ? (
          <p className="text-xs text-ink-muted">{t("stock.reserved_not_moved")}</p>
        ) : null}
        {m.valueMinor !== null && m.currency ? (
          <p className="text-xs text-ink-muted">
            {formatMoney(Math.abs(m.valueMinor), m.currency as CurrencyCode, { locale })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
