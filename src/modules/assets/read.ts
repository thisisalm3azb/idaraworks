/**
 * Reading the asset register (H22F).
 *
 * H22E built identity, custody, maintenance and disposal, and returned raw
 * column bags with foreign keys in them. A screen needs the other half: the
 * custodian's NAME rather than their id, the location's name rather than its
 * id, and the four histories that make an asset's life legible — custody,
 * inspections, maintenance, downtime — each bounded on its own.
 *
 * `getAsset` in register.ts stays exactly as it is; it is the module's checked,
 * tested read for callers that want the record. This is the presentation read,
 * and it is separate so that the shape a page happens to want cannot drift into
 * the contract other code depends on.
 *
 * Bounded, organization scoped, permission checked. Money stays behind the cost
 * wall, nulled rather than dropped.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

/** Per-history cap. Said out loud in the UI when it bites. */
const HISTORY_LIMIT = 25;

export type AssetDetail = {
  id: string;
  assetNo: string;
  nameEn: string;
  nameAr: string | null;
  descriptionEn: string | null;
  status: string;
  condition: string;
  serialNo: string | null;
  barcode: string | null;
  codeKind: string | null;
  categoryName: string | null;
  acquisitionSource: string | null;
  acquiredOn: string | null;
  acquisitionCostMinor: number | null;
  residualValueMinor: number | null;
  usefulLifeMonths: number | null;
  currency: string | null;
  warrantyStartOn: string | null;
  warrantyEndOn: string | null;
  warrantyProvider: string | null;
  custodianUserId: string | null;
  custodianName: string | null;
  custodianSince: string | null;
  warehouseName: string | null;
  locationName: string | null;
  siteNote: string | null;
  supplierName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNo: string | null;
  /** Set when this asset came off a receipt line — its inventory provenance. */
  goodsReceiptLineId: string | null;
  stockSerialId: string | null;
  stockSerialNo: string | null;
  itemId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  disposedAt: string | null;
  notes: string | null;
};

export type CustodyEvent = {
  id: string;
  event: string;
  fromName: string | null;
  toName: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  conditionAtEvent: string | null;
  reason: string | null;
  /** Set on the event that corrects another; both stay in the history. */
  correctsId: string | null;
  effectiveAt: string;
};

export type InspectionRow = {
  id: string;
  inspectedOn: string;
  kind: string;
  passed: boolean;
  conditionFound: string | null;
  findings: string | null;
  nextDueOn: string | null;
  inspectedByName: string | null;
  jobId: string | null;
};

export type MaintenancePlanRow = {
  id: string;
  nameEn: string;
  nameAr: string | null;
  kind: string;
  intervalDays: number | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  active: boolean;
  /** Decided against the database's current_date, not the server's UTC clock. */
  overdue: boolean;
};

export type MaintenanceEventRow = {
  id: string;
  kind: string;
  performedOn: string;
  performedByName: string | null;
  planName: string | null;
  jobId: string | null;
  taskId: string | null;
  vendorName: string | null;
  costMinor: number | null;
  currency: string | null;
  notes: string | null;
};

export type DowntimeRow = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  reason: string;
  detail: string | null;
};

export type DisposalRow = {
  id: string;
  reference: string;
  method: string;
  reason: string;
  status: string;
  proposedProceedsMinor: number | null;
  actualProceedsMinor: number | null;
  currency: string | null;
  buyerName: string | null;
  disposedOn: string | null;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

export type AssetFullDetail = {
  asset: AssetDetail;
  custody: CustodyEvent[];
  inspections: InspectionRow[];
  plans: MaintenancePlanRow[];
  maintenance: MaintenanceEventRow[];
  downtime: DowntimeRow[];
  disposals: DisposalRow[];
  /** True when any history hit its cap, so the page can say so. */
  truncated: boolean;
};

/**
 * Everything about one asset, for the detail screen.
 *
 * Null when the asset belongs to another organization — the same answer as for
 * one that does not exist, so a caller cannot probe ids across tenants.
 *
 * A DISPOSED asset still returns in full. H22E's rule is that retired and
 * disposed assets remain historically readable: the record of what a business
 * owned, who held it and what became of it does not stop being needed the day
 * the thing leaves the yard.
 */
export async function assetDetail(
  ctx: Ctx,
  archetype: RoleArchetype,
  assetId: string,
): Promise<AssetFullDetail | null> {
  assertCan(archetype, "assets.view");
  const money = (v: unknown): number | null =>
    ctx.costPrivileged && v !== null && v !== undefined ? Number(v) : null;

  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select a.id::text as id, a.asset_no, a.name_en, a.name_ar, a.description_en,
             a.status, a.condition, a.serial_no, a.barcode, a.code_kind,
             c.name_en as category_name,
             a.acquisition_source, a.acquired_on::text as acquired_on,
             a.acquisition_cost_minor::text as acquisition_cost_minor,
             a.residual_value_minor::text as residual_value_minor,
             a.useful_life_months::text as useful_life_months, a.currency,
             a.warranty_start_on::text as warranty_start_on,
             a.warranty_end_on::text as warranty_end_on, a.warranty_provider,
             a.custodian_user_id::text as custodian_user_id,
             cu.full_name as custodian_name,
             a.custodian_since::text as custodian_since,
             w.name_en as warehouse_name, l.name_en as location_name, a.site_note,
             s.name as supplier_name,
             a.purchase_order_id::text as purchase_order_id, po.reference as purchase_order_no,
             a.goods_receipt_line_id::text as goods_receipt_line_id,
             a.stock_serial_id::text as stock_serial_id, ss.serial_no as stock_serial_no,
             a.item_id::text as item_id,
             a.retired_at::text as retired_at, a.retired_reason,
             a.disposed_at::text as disposed_at, a.notes
      from public.asset a
      left join public.asset_category c on c.id = a.category_id and c.org_id = a.org_id
      left join public.user_profile cu on cu.id = a.custodian_user_id
      left join public.warehouse w on w.id = a.warehouse_id and w.org_id = a.org_id
      left join public.stock_location l on l.id = a.location_id and l.org_id = a.org_id
      left join public.supplier s on s.id = a.supplier_id and s.org_id = a.org_id
      left join public.purchase_order po on po.id = a.purchase_order_id and po.org_id = a.org_id
      left join public.stock_serial ss on ss.id = a.stock_serial_id and ss.org_id = a.org_id
      where a.id = ${assetId} and a.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | null>>;
    const a = rows[0];
    if (!a) return null;

    const [custody, inspections, plans, maintenance, downtime, disposals] = await Promise.all([
      tx.execute(sql`
        select e.id::text as id, e.event,
               fu.full_name as from_name, tu.full_name as to_name,
               fl.name_en as from_location_name, tl.name_en as to_location_name,
               e.condition_at_event, e.reason, e.corrects_id::text as corrects_id,
               e.effective_at::text as effective_at
        from public.asset_assignment e
        left join public.user_profile fu on fu.id = e.from_user_id
        left join public.user_profile tu on tu.id = e.to_user_id
        left join public.stock_location fl on fl.id = e.from_location_id and fl.org_id = e.org_id
        left join public.stock_location tl on tl.id = e.to_location_id and tl.org_id = e.org_id
        where e.asset_id = ${assetId} and e.org_id = ${ctx.orgId}
        order by e.effective_at desc, e.created_at desc
        limit ${HISTORY_LIMIT + 1}
      `),
      tx.execute(sql`
        select i.id::text as id, i.inspected_on::text as inspected_on, i.kind, i.passed,
               i.condition_found, i.findings, i.next_due_on::text as next_due_on,
               u.full_name as inspected_by_name, i.job_id::text as job_id
        from public.asset_inspection i
        left join public.user_profile u on u.id = i.inspected_by
        where i.asset_id = ${assetId} and i.org_id = ${ctx.orgId}
        order by i.inspected_on desc, i.created_at desc
        limit ${HISTORY_LIMIT + 1}
      `),
      tx.execute(sql`
        select id::text as id, name_en, name_ar, kind, interval_days,
               next_due_on::text as next_due_on, last_done_on::text as last_done_on, active,
               (active and next_due_on is not null and next_due_on < current_date) as overdue
        from public.asset_maintenance_plan
        where asset_id = ${assetId} and org_id = ${ctx.orgId}
        order by active desc, next_due_on nulls last, name_en
        limit ${HISTORY_LIMIT + 1}
      `),
      tx.execute(sql`
        select m.id::text as id, m.kind, m.performed_on::text as performed_on,
               u.full_name as performed_by_name, p.name_en as plan_name,
               m.job_id::text as job_id, m.task_id::text as task_id,
               s.name as vendor_name,
               m.cost_minor::text as cost_minor, m.currency, m.notes
        from public.asset_maintenance_event m
        left join public.user_profile u on u.id = m.performed_by
        left join public.asset_maintenance_plan p on p.id = m.plan_id and p.org_id = m.org_id
        left join public.supplier s on s.id = m.vendor_supplier_id and s.org_id = m.org_id
        where m.asset_id = ${assetId} and m.org_id = ${ctx.orgId}
        order by m.performed_on desc, m.created_at desc
        limit ${HISTORY_LIMIT + 1}
      `),
      tx.execute(sql`
        select id::text as id, started_at::text as started_at, ended_at::text as ended_at,
               reason, detail
        from public.asset_downtime
        where asset_id = ${assetId} and org_id = ${ctx.orgId}
        order by started_at desc
        limit ${HISTORY_LIMIT + 1}
      `),
      tx.execute(sql`
        select d.id::text as id, d.reference, d.method, d.reason, d.status,
               d.proposed_proceeds_minor::text as proposed_proceeds_minor,
               d.actual_proceeds_minor::text as actual_proceeds_minor, d.currency,
               d.buyer_name, d.disposed_on::text as disposed_on,
               rq.full_name as requested_by_name, d.requested_at::text as requested_at,
               dc.full_name as decided_by_name, d.decided_at::text as decided_at,
               d.decision_note, d.completed_at::text as completed_at,
               d.cancelled_at::text as cancelled_at
        from public.asset_disposal d
        left join public.user_profile rq on rq.id = d.requested_by
        left join public.user_profile dc on dc.id = d.decided_by
        where d.asset_id = ${assetId} and d.org_id = ${ctx.orgId}
        order by d.requested_at desc
        limit ${HISTORY_LIMIT + 1}
      `),
    ]);

    const cast = (r: unknown) => r as unknown as Array<Record<string, string | boolean | null>>;
    const lists = [custody, inspections, plans, maintenance, downtime, disposals].map(cast);
    const truncated = lists.some((l) => l.length > HISTORY_LIMIT);
    const [cu, ins, pl, mx, dt, dp] = lists.map((l) => l.slice(0, HISTORY_LIMIT));

    return {
      asset: {
        id: a.id!,
        assetNo: a.asset_no!,
        nameEn: a.name_en!,
        nameAr: a.name_ar ?? null,
        descriptionEn: a.description_en ?? null,
        status: a.status!,
        condition: a.condition!,
        serialNo: a.serial_no ?? null,
        barcode: a.barcode ?? null,
        codeKind: a.code_kind ?? null,
        categoryName: a.category_name ?? null,
        acquisitionSource: a.acquisition_source ?? null,
        acquiredOn: a.acquired_on ?? null,
        acquisitionCostMinor: money(a.acquisition_cost_minor),
        residualValueMinor: money(a.residual_value_minor),
        usefulLifeMonths: a.useful_life_months === null ? null : Number(a.useful_life_months),
        currency: ctx.costPrivileged ? (a.currency ?? null) : null,
        warrantyStartOn: a.warranty_start_on ?? null,
        warrantyEndOn: a.warranty_end_on ?? null,
        warrantyProvider: a.warranty_provider ?? null,
        custodianUserId: a.custodian_user_id ?? null,
        custodianName: a.custodian_name ?? null,
        custodianSince: a.custodian_since ?? null,
        warehouseName: a.warehouse_name ?? null,
        locationName: a.location_name ?? null,
        siteNote: a.site_note ?? null,
        supplierName: a.supplier_name ?? null,
        purchaseOrderId: a.purchase_order_id ?? null,
        purchaseOrderNo: a.purchase_order_no ?? null,
        goodsReceiptLineId: a.goods_receipt_line_id ?? null,
        stockSerialId: a.stock_serial_id ?? null,
        stockSerialNo: a.stock_serial_no ?? null,
        itemId: a.item_id ?? null,
        retiredAt: a.retired_at ?? null,
        retiredReason: a.retired_reason ?? null,
        disposedAt: a.disposed_at ?? null,
        notes: a.notes ?? null,
      },
      custody: cu!.map((r) => ({
        id: String(r.id),
        event: String(r.event),
        fromName: (r.from_name as string | null) ?? null,
        toName: (r.to_name as string | null) ?? null,
        fromLocationName: (r.from_location_name as string | null) ?? null,
        toLocationName: (r.to_location_name as string | null) ?? null,
        conditionAtEvent: (r.condition_at_event as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        correctsId: (r.corrects_id as string | null) ?? null,
        effectiveAt: String(r.effective_at),
      })),
      inspections: ins!.map((r) => ({
        id: String(r.id),
        inspectedOn: String(r.inspected_on),
        kind: String(r.kind),
        passed: r.passed === true,
        conditionFound: (r.condition_found as string | null) ?? null,
        findings: (r.findings as string | null) ?? null,
        nextDueOn: (r.next_due_on as string | null) ?? null,
        inspectedByName: (r.inspected_by_name as string | null) ?? null,
        jobId: (r.job_id as string | null) ?? null,
      })),
      plans: pl!.map((r) => ({
        id: String(r.id),
        nameEn: String(r.name_en),
        nameAr: (r.name_ar as string | null) ?? null,
        kind: String(r.kind),
        intervalDays: r.interval_days === null ? null : Number(r.interval_days),
        nextDueOn: (r.next_due_on as string | null) ?? null,
        lastDoneOn: (r.last_done_on as string | null) ?? null,
        active: r.active === true,
        overdue: r.overdue === true,
      })),
      maintenance: mx!.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        performedOn: String(r.performed_on),
        performedByName: (r.performed_by_name as string | null) ?? null,
        planName: (r.plan_name as string | null) ?? null,
        jobId: (r.job_id as string | null) ?? null,
        taskId: (r.task_id as string | null) ?? null,
        vendorName: (r.vendor_name as string | null) ?? null,
        costMinor: money(r.cost_minor),
        currency: ctx.costPrivileged ? ((r.currency as string | null) ?? null) : null,
        notes: (r.notes as string | null) ?? null,
      })),
      downtime: dt!.map((r) => ({
        id: String(r.id),
        startedAt: String(r.started_at),
        endedAt: (r.ended_at as string | null) ?? null,
        reason: String(r.reason),
        detail: (r.detail as string | null) ?? null,
      })),
      disposals: dp!.map((r) => ({
        id: String(r.id),
        reference: String(r.reference),
        method: String(r.method),
        reason: String(r.reason),
        status: String(r.status),
        proposedProceedsMinor: money(r.proposed_proceeds_minor),
        actualProceedsMinor: money(r.actual_proceeds_minor),
        currency: ctx.costPrivileged ? ((r.currency as string | null) ?? null) : null,
        buyerName: (r.buyer_name as string | null) ?? null,
        disposedOn: (r.disposed_on as string | null) ?? null,
        requestedByName: (r.requested_by_name as string | null) ?? null,
        requestedAt: String(r.requested_at),
        decidedByName: (r.decided_by_name as string | null) ?? null,
        decidedAt: (r.decided_at as string | null) ?? null,
        decisionNote: (r.decision_note as string | null) ?? null,
        completedAt: (r.completed_at as string | null) ?? null,
        cancelledAt: (r.cancelled_at as string | null) ?? null,
      })),
      truncated,
    };
  });
}
