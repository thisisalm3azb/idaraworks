/**
 * What needs HR attention right now (H23H) — same law as the inventory feed:
 * these concerns are TRUE OF A DATE, nothing fires when the date arrives, and
 * this system has no worker — so they are computed on READ, where they cannot
 * go stale and cannot silently stop.
 *
 * Facts, not sentences: rows carry a kind, a date and variables; the i18n
 * catalogue words them in the reader's language.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

export type HrAttentionKind =
  | "probation_ending"
  | "contract_ending"
  | "document_expiring"
  | "document_expired"
  | "payroll_pending";

export type HrAttentionItem = {
  kind: HrAttentionKind;
  severity: "urgent" | "soon";
  entityType: "employee" | "pay_run";
  entityId: string;
  on: string | null;
  vars: Record<string, string | number>;
  name?: { en: string; ar: string | null };
};

export type HrAttentionFeed = { items: HrAttentionItem[]; truncated: boolean };

const CAP = 30; // per concern — the inbox says out loud when a list is capped

export async function hrAttentionFeed(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { withinDays?: number } = {},
): Promise<HrAttentionFeed> {
  // Naming whose probation ends and whose documents expire is an employee read.
  assertCan(archetype, "employees.view");
  const withinDays = Math.min(Math.max(opts.withinDays ?? 30, 1), 365);
  const seesPayroll = can(archetype, "payroll.view") && ctx.costPrivileged;

  return withCtx(ctx, async (tx) => {
    const items: HrAttentionItem[] = [];
    let truncated = false;

    // Probation ending within 14 days — a decision with a deadline.
    const probation = (await tx.execute(sql`
      select id::text as id, name, name_ar, probation_end_date::text as d
      from public.employee
      where org_id = ${ctx.orgId} and lifecycle = 'active'
        and probation_end_date is not null
        and probation_end_date between current_date and current_date + 14
      order by probation_end_date
      limit ${CAP + 1}
    `)) as unknown as Array<Record<string, string | null>>;
    if (probation.length > CAP) truncated = true;
    for (const r of probation.slice(0, CAP)) {
      items.push({
        kind: "probation_ending",
        severity: "soon",
        entityType: "employee",
        entityId: r.id!,
        on: r.d!,
        vars: {},
        name: { en: r.name!, ar: r.name_ar ?? null },
      });
    }

    // Contracts ending within the window (accepted/issued only — a draft
    // ending is a typo, not a concern).
    const contracts = (await tx.execute(sql`
      select c.id::text as id, c.employee_id::text as employee_id, c.contract_no,
             c.end_date::text as d, e.name, e.name_ar
      from public.employee_contract c
      join public.employee e on e.id = c.employee_id and e.org_id = c.org_id
      where c.org_id = ${ctx.orgId} and c.status in ('issued', 'accepted')
        and c.end_date is not null
        and c.end_date between current_date and current_date + (${withinDays})::int
      order by c.end_date
      limit ${CAP + 1}
    `)) as unknown as Array<Record<string, string | null>>;
    if (contracts.length > CAP) truncated = true;
    for (const r of contracts.slice(0, CAP)) {
      items.push({
        kind: "contract_ending",
        severity: "soon",
        entityType: "employee",
        entityId: r.employee_id!,
        on: r.d!,
        vars: { reference: r.contract_no! },
        name: { en: r.name!, ar: r.name_ar ?? null },
      });
    }

    // Employee documents: expired is urgent, expiring soon is a warning.
    const docs = (await tx.execute(sql`
      select d.id::text as id, d.employee_id::text as employee_id, d.title,
             d.expiry_date::text as d, (d.expiry_date < current_date) as expired,
             e.name, e.name_ar
      from public.employee_document d
      join public.employee e on e.id = d.employee_id and e.org_id = d.org_id
      where d.org_id = ${ctx.orgId} and d.expiry_date is not null
        and e.lifecycle <> 'terminated'
        and d.voided_at is null
        -- Only the LIVE version of a document: one replaced by a newer upload
        -- is history, and history expiring is not a task.
        and not exists (select 1 from public.employee_document n
                        where n.org_id = d.org_id and n.replaces_id = d.id)
        and d.expiry_date <= current_date + (${withinDays})::int
      order by d.expiry_date
      limit ${CAP + 1}
    `)) as unknown as Array<Record<string, unknown>>;
    if (docs.length > CAP) truncated = true;
    for (const r of docs.slice(0, CAP)) {
      items.push({
        kind: r.expired === true ? "document_expired" : "document_expiring",
        severity: r.expired === true ? "urgent" : "soon",
        entityType: "employee",
        entityId: r.employee_id as string,
        on: r.d as string,
        vars: { document: r.title as string },
        name: { en: r.name as string, ar: (r.name_ar as string | null) ?? null },
      });
    }

    // Pay runs waiting on a person (cost-privileged payroll readers only).
    if (seesPayroll) {
      const runs = (await tx.execute(sql`
        select id::text as id, reference, status, updated_at::text as d
        from public.pay_run
        where org_id = ${ctx.orgId} and status in ('review', 'awaiting_approval')
        order by updated_at
        limit ${CAP + 1}
      `)) as unknown as Array<Record<string, string>>;
      if (runs.length > CAP) truncated = true;
      for (const r of runs.slice(0, CAP)) {
        items.push({
          kind: "payroll_pending",
          severity: r.status === "awaiting_approval" ? "urgent" : "soon",
          entityType: "pay_run",
          entityId: r.id!,
          on: null,
          vars: { reference: r.reference!, status: r.status! },
        });
      }
    }

    // Worst first, then by date.
    items.sort((a, b) =>
      a.severity === b.severity
        ? (a.on ?? "9999").localeCompare(b.on ?? "9999")
        : a.severity === "urgent"
          ? -1
          : 1,
    );
    return { items, truncated };
  });
}
