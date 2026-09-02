import Link from "next/link";
import { cn } from "@/lib/cn";
import { can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

export type RevenueTabKey =
  | "hub"
  | "pipeline"
  | "leads"
  | "forecast"
  | "campaigns"
  | "targets"
  | "success"
  | "automations"
  | "reports"
  | "settings";

const TABS: Array<{ key: RevenueTabKey; path: string; lane: string }> = [
  { key: "hub", path: "", lane: "opportunities.view" },
  { key: "pipeline", path: "/pipeline", lane: "opportunities.view" },
  { key: "leads", path: "/leads", lane: "leads.view" },
  { key: "forecast", path: "/forecast", lane: "crm.forecast.view" },
  { key: "campaigns", path: "/campaigns", lane: "crm.campaigns.manage" },
  { key: "targets", path: "/targets", lane: "crm.forecast.view" },
  { key: "success", path: "/success", lane: "customers.view" },
  { key: "automations", path: "/automations", lane: "crm.automations.manage" },
  { key: "reports", path: "/reports", lane: "crm.forecast.view" },
  { key: "settings", path: "/settings", lane: "pipeline.configure" },
];

/** The studio's own navigation: one row, scrolls sideways on phones, current tab announced. */
export function RevenueTabs({
  orgId,
  active,
  archetype,
  labels,
}: {
  orgId: string;
  active: RevenueTabKey;
  archetype: RoleArchetype;
  labels: Record<RevenueTabKey, string>;
}) {
  const visible = TABS.filter((tab) => can(archetype, tab.lane as Parameters<typeof can>[1]));
  return (
    <nav
      aria-label={labels.hub}
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
    >
      {visible.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={`/o/${orgId}/revenue${tab.path}`}
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex min-h-10 shrink-0 items-center rounded-md px-3 text-sm font-medium",
              current
                ? "bg-brand-soft text-brand-strong"
                : "text-ink-secondary hover:bg-sunken hover:text-ink",
            )}
          >
            {labels[tab.key]}
          </Link>
        );
      })}
    </nav>
  );
}
