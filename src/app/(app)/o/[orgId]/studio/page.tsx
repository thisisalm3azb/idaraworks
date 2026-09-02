import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { managementStudioEnabled } from "@/platform/flags";
import { formatDate } from "@/platform/format";
import { listStudioPlans } from "@/modules/studio/service";
import { createPlanAction } from "./actions";

/** H25 — the Studio home: every plan the organization is shaping. */
export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!managementStudioEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "studio.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const manages = can(resolved.archetype, "studio.manage");
  const plans = await listStudioPlans(resolved.ctx, resolved.archetype);
  const create = createPlanAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t("studio.title")}</h1>
        <p className="text-sm text-ink-muted">{t("studio.subtitle")}</p>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {manages ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("studio.new_plan")}</h2>
          <form action={create} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted sm:col-span-2">
              {t("studio.plan_name")}
              <input name="name" required maxLength={200} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("studio.plan_description")}
              <input name="description" maxLength={4000} className={input} />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit">{t("studio.new_plan")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {plans.length === 0 ? (
        <EmptyState title={t("studio.empty")} description={t("studio.empty_hint")} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <li key={p.id}>
              <Link
                href={`/o/${orgId}/studio/${p.id}`}
                className="block min-h-11 rounded-lg border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{p.name}</span>
                  <span className="text-xs text-ink-muted" dir="ltr">
                    {p.reference}
                  </span>
                </div>
                {p.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{p.description}</p>
                ) : null}
                <p className="mt-2 text-xs text-ink-muted">
                  {t("studio.node_count", { count: p.nodeCount })} ·{" "}
                  {formatDate(p.updatedAt.slice(0, 10), { locale })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
