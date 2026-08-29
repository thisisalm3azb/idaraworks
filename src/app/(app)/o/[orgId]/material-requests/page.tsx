import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState, FilterBar } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { mrHref, parseMrSearch } from "@/modules/dashboard/service";
import { listMaterialRequests } from "@/modules/supply/service";

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  converted: "success",
  cancelled: "neutral",
};

export default async function MaterialRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "mr.create")) redirect(`/o/${orgId}`);
  const t = await getT();
  // H18 drill-down contract: ?status narrows to the dashboard rule; unknown
  // values are safely ignored.
  const { status } = parseMrSearch(sp);
  const all = await listMaterialRequests(resolved.ctx, resolved.archetype);
  const rows = status ? all.filter((r) => r.status === status) : all;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("mr.title")}</h1>
        <Link href={`/o/${orgId}/material-requests/new`}>
          <Button>{t("mr.new")}</Button>
        </Link>
      </div>
      {status ? (
        <FilterBar
          summary={t(`filters.mr.${status}`)}
          countLabel={t("filters.count", { count: rows.length })}
          clearHref={mrHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={status ? t("filters.empty") : t("mr.empty")}
          description={status ? t("filters.empty_hint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/o/${orgId}/material-requests/${r.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.reference}</span>
                  <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {t(`mr.status.${r.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {r.jobReference ? `${r.jobReference} · ` : ""}
                  {t(`mr.urgency.${r.urgency}`)} · {r.createdByName ?? "—"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
