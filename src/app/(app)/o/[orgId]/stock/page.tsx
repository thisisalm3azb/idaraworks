import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { listStockLevels } from "@/modules/inventory/service";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

/**
 * Stock levels (H22F).
 *
 * The first screen in H22 that answers the question the whole phase exists for:
 * how much of this do we have, and is any of it a problem.
 *
 * One line per item, aggregated over locations, because "where exactly" is a
 * second question and it has its own page. Quantities for everybody with
 * `inventory.view`; value only inside the cost wall, and the module returns null
 * rather than zero so this page can stay silent instead of printing a lie.
 *
 * Mobile first: a stacked card list, not a table. A foreman checking stock is
 * holding a phone in a workshop, and a table at 375px is a horizontal scroll
 * with a number in it.
 */
export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; cursor?: string; low?: string; in_stock?: string }>;
}) {
  // The gate is here, not only in the navigation: a menu is not a permission,
  // and this whole system is unverified until H22G says otherwise.
  if (!stockSurfacesEnabled()) notFound();

  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "inventory.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();

  const search = (sp.q ?? "").trim();
  const lowOnly = sp.low === "1";
  const inStockOnly = sp.in_stock === "1";
  const { rows, nextCursor } = await listStockLevels(resolved.ctx, resolved.archetype, {
    search,
    lowOnly,
    inStockOnly,
    cursor: sp.cursor,
    limit: 50,
  });

  const hrefWith = (extra: Record<string, string>) =>
    `/o/${orgId}/stock?${new URLSearchParams({
      ...(search ? { q: search } : {}),
      ...(lowOnly ? { low: "1" } : {}),
      ...(inStockOnly ? { in_stock: "1" } : {}),
      ...extra,
    })}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("stock.title")} />

        {/* Search is a GET form so a narrowed list is a URL somebody can send. */}
        <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
          {lowOnly ? <input type="hidden" name="low" value="1" /> : null}
          {inStockOnly ? <input type="hidden" name="in_stock" value="1" /> : null}
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder={t("stock.search")}
            aria-label={t("stock.search")}
            className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
          />
          <button
            type="submit"
            className="min-h-11 rounded-md border border-line-strong px-4 text-sm text-ink"
          >
            {t("common.search")}
          </button>
        </form>

        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          <Link
            href={hrefWith(lowOnly ? {} : { low: "1" })}
            className={`min-h-11 rounded-md px-3 py-2 ${
              lowOnly ? "bg-brand-soft text-brand" : "text-ink-secondary underline"
            }`}
          >
            {t("stock.filter_low")}
          </Link>
          <Link
            href={hrefWith(inStockOnly ? {} : { in_stock: "1" })}
            className={`min-h-11 rounded-md px-3 py-2 ${
              inStockOnly ? "bg-brand-soft text-brand" : "text-ink-secondary underline"
            }`}
          >
            {t("stock.filter_in_stock")}
          </Link>
        </div>

        {rows.length === 0 ? (
          <EmptyState title={t("stock.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const low = r.reorderPoint !== null && Number(r.available) <= Number(r.reorderPoint);
              return (
                <li key={r.itemId}>
                  <Link
                    href={`/o/${orgId}/stock/${r.itemId}`}
                    className="flex min-h-14 items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {r.sku} — {r.name}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {/*
                         * Reserved is only mentioned when there IS some. A row
                         * reading "reserved 0" on every line trains people to
                         * stop reading the line that says reserved 40.
                         */}
                        {r.locationCount === 1 && r.soleLocationName
                          ? r.soleLocationName
                          : t("stock.locations", { n: r.locationCount })}
                        {Number(r.reserved) !== 0
                          ? ` · ${t("stock.reserved", { n: r.reserved })}`
                          : ""}
                        {r.valueMinor !== null && r.currency
                          ? ` · ${formatMoney(r.valueMinor, r.currency as CurrencyCode, { locale })}`
                          : r.valueIsMixedCurrency
                            ? ` · ${t("stock.value_mixed_currency")}`
                            : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-medium text-ink">
                        {r.available} {r.uom}
                      </span>
                      {low ? <Badge tone="warning">{t("stock.low")}</Badge> : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/*
         * Keyset paging: "next" only. There is no page number to go back to
         * because there are no pages — the cursor is a position in a list that
         * changes as stock moves. Offering a Previous that silently lands
         * somewhere else would be worse than not offering one.
         */}
        {nextCursor ? (
          <div className="mt-3 flex items-center gap-4">
            <Link
              href={hrefWith({ cursor: nextCursor })}
              className="inline-flex min-h-11 items-center text-sm text-brand underline"
            >
              {t("common.next")}
            </Link>
            {sp.cursor ? (
              <Link
                href={hrefWith({})}
                className="inline-flex min-h-11 items-center text-sm text-ink-secondary underline"
              >
                {t("stock.back_to_start")}
              </Link>
            ) : null}
          </div>
        ) : sp.cursor ? (
          <div className="mt-3">
            <Link
              href={hrefWith({})}
              className="inline-flex min-h-11 items-center text-sm text-ink-secondary underline"
            >
              {t("stock.back_to_start")}
            </Link>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
