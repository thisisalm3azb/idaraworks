import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { pickAuthoredText } from "@/platform/i18n";
import {
  listWarehouses,
  receivingReadiness,
  LOCATION_KINDS,
  type LocationKind,
} from "@/modules/inventory/service";
import {
  createLocationAction,
  createUnitAction,
  createWarehouseAction,
  setDefaultReceivingAction,
} from "./actions";

/**
 * H30 LB-2 — warehouse and location setup.
 *
 * The screen H22 owed and never shipped. Without it an organisation could record
 * a goods receipt, see it save, and never see stock: `receivingLocation()` found
 * no default receiving bin and threw, and the failure banner advised checking a
 * "warehouse setup" that did not exist. Najolatech received 34 units that way
 * and holds zero in the ledger to this day.
 *
 * Two decisions are load-bearing:
 *
 *   - the readiness banner is the FIRST thing on the page, phrased as what is
 *     missing rather than as a status code, because the person who arrives here
 *     usually arrives from a failed receipt;
 *   - creating a warehouse offers to create its receiving bay in the same step,
 *     ticked by default. A warehouse with no receiving bin is the exact state
 *     that caused the defect, and nobody chooses it on purpose.
 *
 * Phone first: stacked cards, 44px targets, no table.
 */
export default async function WarehousesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; n?: string }>;
}) {
  // Gated here, before the first await that could render anything: in the App
  // Router the layout and the page render concurrently, so a gate that lives
  // only in a layout does not stop this page's own work.
  if (!stockSurfacesEnabled()) notFound();

  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "inventory.view")) notFound();

  const t = await getT();
  const locale = await getServerLocale();
  const mayManage = can(resolved.archetype, "inventory.adjust");

  const [{ warehouses, truncated }, readiness] = await Promise.all([
    listWarehouses(resolved.ctx, resolved.archetype),
    receivingReadiness(resolved.ctx),
  ]);

  const name = (row: { nameEn: string; nameAr: string | null }) =>
    pickAuthoredText({ en: row.nameEn, ar: row.nameAr ?? undefined }, locale, row.nameEn);

  const notice = sp.ok
    ? t(
        sp.ok === "created"
          ? "stock.setup.created"
          : sp.ok === "location_created"
            ? "stock.setup.location_created"
            : sp.ok === "unit"
              ? "stock.setup.unit_created"
              : sp.ok === "base_unit"
                ? "stock.setup.base_unit_applied"
                : "stock.setup.default_set",
      )
    : null;
  // An unknown error key must never render as a bracketed marker, so an
  // unrecognised value falls back to the generic failure copy.
  const errorText = sp.error?.startsWith("stock.setup.") ? t(sp.error) : null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t("stock.setup.title")}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{t("stock.setup.subtitle")}</p>
      </div>

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-ink"
        >
          {notice}
        </p>
      ) : null}
      {errorText ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink"
        >
          {errorText}
        </p>
      ) : null}

      {/* The answer to "can we receive at all", stated before anything else. */}
      <div
        className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
          readiness.ok
            ? "border-success/40 bg-success/10 text-ink"
            : "border-warning/50 bg-warning/10 text-ink"
        }`}
      >
        <Icon
          name={readiness.ok ? "check" : "alert"}
          size={18}
          aria-hidden
          className="mt-0.5 shrink-0"
        />
        <span>{readiness.ok ? t("stock.setup.ready") : t(readiness.missingKey!)}</span>
      </div>

      {warehouses.length === 0 ? (
        <EmptyState title={t("stock.setup.empty")} description={t("stock.setup.empty_hint")} />
      ) : null}

      {warehouses.map((w) => (
        <Card key={w.id}>
          <CardHeader
            title={`${w.code} — ${name(w)}`}
            meta={
              <span className="flex items-center gap-2">
                {w.city ? <span className="text-sm text-ink-secondary">{w.city}</span> : null}
                {w.active ? null : <Badge tone="neutral">{t("common.inactive")}</Badge>}
              </span>
            }
          />
          <ul className="flex flex-col gap-2">
            {w.locations.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="font-medium text-ink">{l.code}</span>
                <span className="text-sm text-ink-secondary">{name(l)}</span>
                <Badge tone="neutral">{t(`stock.setup.kind.${l.kind}`)}</Badge>
                {l.isDefaultReceiving ? (
                  <Badge tone="success">{t("stock.setup.default_receiving")}</Badge>
                ) : mayManage && l.canHoldStock && l.active ? (
                  <form action={setDefaultReceivingAction.bind(null, orgId)} className="ms-auto">
                    <input type="hidden" name="location_id" value={l.id} />
                    <Button type="submit" variant="secondary" className="min-h-11">
                      {t("stock.setup.make_default")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>

          {mayManage ? (
            <details className="mt-3">
              <summary className="min-h-11 cursor-pointer list-none rounded-md px-2 py-2.5 text-sm font-medium text-brand">
                {t("stock.setup.add_location")}
              </summary>
              <form
                action={createLocationAction.bind(null, orgId)}
                className="mt-2 flex flex-col gap-3"
              >
                <input type="hidden" name="warehouse_id" value={w.id} />
                <Field
                  name="code"
                  label={t("stock.setup.code")}
                  hint={t("stock.setup.code_hint")}
                  required
                  maxLength={24}
                />
                <Field name="name_en" label={t("stock.setup.name")} required maxLength={120} />
                <Field name="name_ar" label={t("stock.setup.name_ar")} maxLength={120} />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`kind-${w.id}`} className="text-sm font-medium text-ink">
                    {t("stock.setup.kind")}
                  </label>
                  <select
                    id={`kind-${w.id}`}
                    name="kind"
                    defaultValue="storage"
                    className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                  >
                    {LOCATION_KINDS.map((k: LocationKind) => (
                      <option key={k} value={k}>
                        {t(`stock.setup.kind.${k}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="can_hold_stock" defaultChecked className="h-5 w-5" />
                  {t("stock.setup.holds_stock")}
                </label>
                <Button type="submit" className="min-h-11">
                  {t("stock.setup.add_location")}
                </Button>
              </form>
            </details>
          ) : null}
        </Card>
      ))}

      {truncated ? (
        <p className="text-sm text-ink-muted">{t("stock.setup.truncated", { count: 200 })}</p>
      ) : null}

      {/*
        H30 LB-7 — the second cause of PO-002.
        A warehouse is necessary and not sufficient: the poster also needs the
        ITEM to carry a base unit, and production holds 35 stock items with none
        and no units at all. Creating a unit and adopting it in one step is the
        only remedy that does not ask somebody to open 35 item records by hand.
        Shown only while there is something to fix, so a healthy workspace is not
        offered a cure for a disease it does not have.
      */}
      {mayManage && readiness.itemsWithoutBaseUnit > 0 ? (
        <Card>
          <CardHeader title={t("stock.setup.units_title")} />
          <p className="text-sm text-ink-secondary">{t("stock.setup.units_hint")}</p>
          <form action={createUnitAction.bind(null, orgId)} className="mt-3 flex flex-col gap-3">
            <Field
              name="code"
              label={t("stock.setup.code")}
              defaultValue="EA"
              required
              maxLength={24}
            />
            <Field
              name="name_en"
              label={t("stock.setup.name")}
              defaultValue="Each"
              required
              maxLength={120}
            />
            <Field name="name_ar" label={t("stock.setup.name_ar")} maxLength={120} />
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
              <input type="checkbox" name="adopt" defaultChecked className="mt-0.5 h-5 w-5" />
              <span>
                {t("stock.setup.apply_base_unit", { count: readiness.itemsWithoutBaseUnit })}
              </span>
            </label>
            <Button type="submit" className="min-h-11">
              {t("stock.setup.add_unit")}
            </Button>
          </form>
        </Card>
      ) : null}

      {mayManage ? (
        <Card>
          <CardHeader title={t("stock.setup.add_warehouse")} />
          <form action={createWarehouseAction.bind(null, orgId)} className="flex flex-col gap-3">
            <Field
              name="code"
              label={t("stock.setup.code")}
              hint={t("stock.setup.code_hint")}
              required
              maxLength={24}
            />
            <Field name="name_en" label={t("stock.setup.name")} required maxLength={120} />
            <Field name="name_ar" label={t("stock.setup.name_ar")} maxLength={120} />
            <Field name="city" label={t("stock.setup.city")} maxLength={80} />
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="with_receiving"
                defaultChecked
                className="mt-0.5 h-5 w-5"
              />
              <span>
                {t("stock.setup.with_receiving")}
                <span className="block text-ink-muted">{t("stock.setup.with_receiving_hint")}</span>
              </span>
            </label>
            <Button type="submit" className="min-h-11">
              {t("stock.setup.add_warehouse")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
