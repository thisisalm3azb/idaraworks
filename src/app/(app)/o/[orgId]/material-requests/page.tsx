import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
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
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "mr.create")) redirect(`/o/${orgId}`);
  const t = await getT();
  const rows = await listMaterialRequests(resolved.ctx, resolved.archetype);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("mr.title")}</h1>
        <Link href={`/o/${orgId}/material-requests/new`}>
          <Button>{t("mr.new")}</Button>
        </Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("mr.empty")} />
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
