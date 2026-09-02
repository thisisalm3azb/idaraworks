"use server";

import { resolveCtxForAction } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { boardPage, leadPage } from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";

export type SearchHit = {
  kind: "lead" | "opportunity" | "customer";
  id: string;
  label: string;
  hint: string;
  href: string;
};

/** Bounded, permission-checked search for the command centre (database-side, 5 per kind). */
export async function searchRevenueAction(orgId: string, q: string): Promise<SearchHit[]> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return [];
  const needle = q.trim().slice(0, 80);
  if (needle.length < 2) return [];
  const out: SearchHit[] = [];
  const { ctx, archetype } = resolved;
  const tasks: Array<Promise<void>> = [];
  if (can(archetype, "opportunities.view"))
    tasks.push(
      boardPage(ctx, archetype, { search: needle, status: "all", limit: 5 }).then((b) => {
        for (const r of b.rows)
          out.push({
            kind: "opportunity",
            id: r.id,
            label: r.customerName ? `${r.name} · ${r.customerName}` : r.name,
            hint: r.stageKey,
            href: `/o/${orgId}/revenue/deals/${r.id}`,
          });
      }),
    );
  if (can(archetype, "leads.view"))
    tasks.push(
      leadPage(ctx, archetype, { search: needle, limit: 5 }).then((p) => {
        for (const r of p.rows)
          out.push({
            kind: "lead",
            id: r.id,
            label: r.name,
            hint: r.status,
            href: `/o/${orgId}/leads/${r.id}`,
          });
      }),
    );
  if (can(archetype, "customers.view"))
    tasks.push(
      listCustomers(ctx, archetype, { status: "all", limit: 50 }).then((rows) => {
        const lower = needle.toLowerCase();
        for (const r of rows.filter((c) => c.name.toLowerCase().includes(lower)).slice(0, 5))
          out.push({
            kind: "customer",
            id: r.id,
            label: r.name,
            hint: "customer",
            href: `/o/${orgId}/revenue/customers/${r.id}`,
          });
      }),
    );
  await Promise.all(tasks);
  return out;
}
