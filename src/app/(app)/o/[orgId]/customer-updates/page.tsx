import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listUpdates } from "@/modules/customer-updates/service";

const TONE: Record<string, "neutral" | "success"> = { draft: "neutral", sent: "success" };

export default async function CustomerUpdatesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "customer_updates.draft")) redirect(`/o/${orgId}`);
  const t = await getT();
  const rows = await listUpdates(resolved.ctx, resolved.archetype);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("customer_updates.title")}</h1>
        <Link href={`/o/${orgId}/customer-updates/new`}>
          <Button>{t("customer_updates.new")}</Button>
        </Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("customer_updates.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((u) => (
            <li key={u.id}>
              <Link
                href={`/o/${orgId}/customer-updates/${u.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{u.title}</span>
                  <Badge tone={TONE[u.status] ?? "neutral"}>
                    {t(`customer_updates.status.${u.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{u.customerName ?? u.jobName ?? "—"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
