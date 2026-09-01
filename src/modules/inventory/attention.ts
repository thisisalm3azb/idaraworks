/**
 * What needs attention right now (H22F).
 *
 * H22 raises three kinds of concern that are TRUE OF A DATE rather than caused
 * by an event: a batch approaching its expiry, a service falling due, stock
 * sitting below its reorder point. Nothing happens at the moment any of those
 * becomes true — nobody clicks anything when Tuesday arrives.
 *
 * The obvious design is a nightly job that writes notifications. This system has
 * no worker: Inngest is unprovisioned in production, so a scheduled alert would
 * be code that never runs, and a "you have no alerts" screen that means "nothing
 * is checking". Computing it on READ is worse in theory and better in fact — it
 * cannot go stale, it cannot silently stop, and it needs nothing to be running.
 *
 * Everything here is bounded and organization scoped. A concern nobody can act
 * on is noise, so each row carries the record it is about.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

export type AttentionKind =
  | "stock_below_reorder"
  | "batch_expiring"
  | "batch_expired"
  | "maintenance_due"
  | "maintenance_overdue"
  | "asset_warranty_ending";

export type AttentionItem = {
  kind: AttentionKind;
  /** Worst first: an expired batch outranks one expiring next month. */
  severity: "urgent" | "soon";
  entityType: "item" | "asset";
  entityId: string;
  /** The date the concern turns on, where there is one. */
  on: string | null;
  /*
   * FACTS, NOT SENTENCES.
   *
   * The obvious version of this module returned `title` and `detail` as
   * finished English strings, which quietly makes every Arabic reader's
   * attention list English. What is actually known here is a code, a quantity
   * and a date; the wording belongs to the catalogue, keyed by `kind`.
   */
  vars: Record<string, string | number>;
  /** A stored name, in both languages, for the reader's locale to choose. */
  name?: { en: string; ar: string | null };
};

export type AttentionFeed = {
  items: AttentionItem[];
  /** True when the caps below hid some. Said out loud rather than implied. */
  truncated: boolean;
};

const PER_KIND = 25;

/**
 * Everything the caller may see that wants doing something about.
 *
 * Each block is capped separately, so one very noisy category cannot crowd the
 * others out of the list — a warehouse with two hundred expiring batches would
 * otherwise hide every overdue service behind them.
 */
export async function attentionFeed(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { withinDays?: number } = {},
): Promise<AttentionFeed> {
  // Seeing what needs attention is the mildest possible read, but it still
  // names records: anybody who may not view stock may not view its problems.
  assertCan(archetype, "inventory.view");
  const withinDays = Math.min(Math.max(opts.withinDays ?? 30, 1), 365);
  const seesAssets = can(archetype, "assets.view");

  return withCtx(ctx, async (tx) => {
    const items: AttentionItem[] = [];
    let truncated = false;

    /*
     * Stock below its reorder point.
     *
     * Compared against what is AVAILABLE, not what is on hand: stock already
     * promised to a job will not be there when the next one needs it, and a
     * reorder point that ignores reservations reorders too late every time.
     */
    const low = (await tx.execute(sql`
      select i.id::text as id, i.sku, i.name,
             trim_scale(i.reorder_point)::text as reorder_point,
             trim_scale(coalesce(sum(b.on_hand - b.reserved), 0))::text as available
      from public.item i
      left join public.stock_balance b on b.item_id = i.id and b.org_id = i.org_id
      where i.org_id = ${ctx.orgId} and i.active and i.reorder_point is not null
        and i.lifecycle = 'active'
      group by i.id, i.sku, i.name, i.reorder_point
      having coalesce(sum(b.on_hand - b.reserved), 0) <= i.reorder_point
      order by (coalesce(sum(b.on_hand - b.reserved), 0) - i.reorder_point), i.sku
      limit ${PER_KIND + 1}
    `)) as unknown as Array<Record<string, string>>;
    truncated = truncated || low.length > PER_KIND;
    for (const r of low.slice(0, PER_KIND)) {
      items.push({
        kind: "stock_below_reorder",
        severity: Number(r.available) <= 0 ? "urgent" : "soon",
        entityType: "item",
        entityId: r.id!,
        on: null,
        vars: {
          sku: r.sku!,
          available: r.available!,
          reorderPoint: r.reorder_point!,
        },
        name: { en: r.name!, ar: null },
      });
    }

    // Batches at or past their date. Expired first — those are already a problem
    // rather than a warning, and they are sitting on a shelf looking usable.
    const batches = (await tx.execute(sql`
      select l.id::text as id, l.code, l.expiry_date::text as expiry_date,
             i.id::text as item_id, i.sku,
             (l.expiry_date < current_date) as expired,
             trim_scale(coalesce(sum(b.on_hand), 0))::text as on_hand
      from public.stock_lot l
      join public.item i on i.id = l.item_id and i.org_id = l.org_id
      left join public.stock_lot_balance b on b.lot_id = l.id and b.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.status = 'active'
        and l.expiry_date is not null
        and l.expiry_date <= current_date + ${withinDays}::int
      group by l.id, l.code, l.expiry_date, i.id, i.sku
      having coalesce(sum(b.on_hand), 0) > 0
      order by l.expiry_date, i.sku
      limit ${PER_KIND + 1}
    `)) as unknown as Array<Record<string, string | boolean>>;
    truncated = truncated || batches.length > PER_KIND;
    for (const r of batches.slice(0, PER_KIND)) {
      const expired = r.expired === true;
      items.push({
        kind: expired ? "batch_expired" : "batch_expiring",
        severity: expired ? "urgent" : "soon",
        entityType: "item",
        entityId: String(r.item_id),
        on: String(r.expiry_date),
        vars: {
          sku: String(r.sku),
          code: String(r.code),
          onHand: String(r.on_hand),
        },
      });
    }

    if (seesAssets) {
      const due = (await tx.execute(sql`
        select a.id::text as id, a.asset_no, p.name_en, p.name_ar,
               p.next_due_on::text as next_due_on,
               (p.next_due_on < current_date) as overdue
        from public.asset_maintenance_plan p
        join public.asset a on a.id = p.asset_id and a.org_id = p.org_id
        where p.org_id = ${ctx.orgId} and p.active
          and a.status not in ('retired', 'disposed')
          and p.next_due_on is not null
          and p.next_due_on <= current_date + ${withinDays}::int
        order by p.next_due_on, a.asset_no
        limit ${PER_KIND + 1}
      `)) as unknown as Array<Record<string, string | boolean>>;
      truncated = truncated || due.length > PER_KIND;
      for (const r of due.slice(0, PER_KIND)) {
        const overdue = r.overdue === true;
        items.push({
          kind: overdue ? "maintenance_overdue" : "maintenance_due",
          severity: overdue ? "urgent" : "soon",
          entityType: "asset",
          entityId: String(r.id),
          on: String(r.next_due_on),
          vars: { assetNo: String(r.asset_no) },
          name: { en: String(r.name_en), ar: (r.name_ar as string | null) ?? null },
        });
      }

      /*
       * Warranties about to run out.
       *
       * Worth surfacing because it is the one where noticing late costs real
       * money: a fault found the week after expiry is paid for twice.
       */
      const warranty = (await tx.execute(sql`
        select id::text as id, asset_no, name_en, name_ar,
               warranty_end_on::text as warranty_end_on
        from public.asset
        where org_id = ${ctx.orgId} and status not in ('retired', 'disposed')
          and warranty_end_on is not null
          and warranty_end_on between current_date and current_date + ${withinDays}::int
        order by warranty_end_on, asset_no
        limit ${PER_KIND + 1}
      `)) as unknown as Array<Record<string, string | null>>;
      truncated = truncated || warranty.length > PER_KIND;
      for (const r of warranty.slice(0, PER_KIND)) {
        items.push({
          kind: "asset_warranty_ending",
          severity: "soon",
          vars: { assetNo: r.asset_no! },
          name: { en: r.name_en!, ar: r.name_ar ?? null },
          entityType: "asset",
          entityId: r.id!,
          on: r.warranty_end_on!,
        });
      }
    }

    // Urgent first, then by the date the concern turns on.
    items.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "urgent" ? -1 : 1;
      return (a.on ?? "9999-12-31").localeCompare(b.on ?? "9999-12-31");
    });
    return { items, truncated };
  });
}
