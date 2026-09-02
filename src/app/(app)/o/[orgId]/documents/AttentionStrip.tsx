import Link from "next/link";
import type { AttentionFeed } from "@/modules/docstudio/service";

export type AttentionDict = {
  title: string;
  overdue: string;
  dueSoon: string;
  expiring: string;
  mySteps: string;
  awaitingSignature: string;
  submissions: string;
  daysLeft: string;
  nothing: string;
  open: string;
};

/**
 * H26 — the command centre's attention strip (server-rendered): what needs a
 * person now, each tile linking to the place where it is handled.
 */
export function AttentionStrip({
  orgId,
  feed,
  dict,
}: {
  orgId: string;
  feed: AttentionFeed;
  dict: AttentionDict;
}) {
  const tiles: Array<{
    key: string;
    label: string;
    count: number;
    href: string;
    tone: "danger" | "warning" | "info" | "neutral";
    items?: Array<{ id: string; text: string; href: string }>;
  }> = [
    {
      key: "overdue",
      label: dict.overdue,
      count: feed.overdue.length,
      href: `/o/${orgId}/documents/obligations?view=list`,
      tone: "danger",
      items: feed.overdue.slice(0, 3).map((o) => ({
        id: o.id,
        text: `${o.title} · ${o.documentReference}`,
        href: `/o/${orgId}/documents/${o.documentId}?tab=obligations`,
      })),
    },
    {
      key: "due_soon",
      label: dict.dueSoon,
      count: feed.dueSoon.length,
      href: `/o/${orgId}/documents/obligations?view=timeline`,
      tone: "warning",
      items: feed.dueSoon.slice(0, 3).map((o) => ({
        id: o.id,
        text: `${o.title} · ${o.documentReference}`,
        href: `/o/${orgId}/documents/${o.documentId}?tab=obligations`,
      })),
    },
    {
      key: "expiring",
      label: dict.expiring,
      count: feed.expiring.length,
      href: `/o/${orgId}/documents?status=active`,
      tone: "warning",
      items: feed.expiring.slice(0, 3).map((e) => ({
        id: e.id,
        text: `${e.reference} · ${e.title} · ${dict.daysLeft.replace("{n}", String(e.daysLeft))}`,
        href: `/o/${orgId}/documents/${e.id}?tab=details`,
      })),
    },
    {
      key: "my_steps",
      label: dict.mySteps,
      count: feed.mySteps.length,
      href: `/o/${orgId}/approvals`,
      tone: "info",
      items: feed.mySteps.slice(0, 3).map((s) => ({
        id: s.id,
        text: `${s.reference} · ${s.title}`,
        href: `/o/${orgId}/documents/${s.documentId}?tab=workflow`,
      })),
    },
    {
      key: "signature",
      label: dict.awaitingSignature,
      count: feed.awaitingSignature,
      href: `/o/${orgId}/documents?status=signature`,
      tone: "info",
    },
    {
      key: "submissions",
      label: dict.submissions,
      count: feed.pendingSubmissions,
      href: `/o/${orgId}/documents/forms`,
      tone: "info",
    },
  ];
  const live = tiles.filter((x) => x.count > 0);
  return (
    <section aria-label={dict.title} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink">{dict.title}</h2>
      {live.length === 0 ? (
        <p className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-muted">
          {dict.nothing}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          {live.map((x) => (
            <div
              key={x.key}
              className={`flex flex-col gap-1 rounded-lg border p-3 shadow-card ${
                x.tone === "danger"
                  ? "border-danger bg-danger-soft"
                  : x.tone === "warning"
                    ? "border-warning-soft bg-warning-soft"
                    : "border-line bg-card"
              }`}
            >
              <Link href={x.href} className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-ink-secondary">{x.label}</span>
                <span className="text-xl font-semibold tabular-nums text-ink">{x.count}</span>
              </Link>
              {x.items?.length ? (
                <ul className="flex flex-col gap-0.5">
                  {x.items.map((it) => (
                    <li key={it.id} className="truncate text-xs">
                      <Link href={it.href} className="text-ink underline" title={it.text}>
                        {it.text}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
