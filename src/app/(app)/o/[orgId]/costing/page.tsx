import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { hasFeature } from "@/platform/entitlements";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { listActiveJobsBrief } from "@/modules/expenses/service";

export default async function CostingIndexPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "costing.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const terms = await loadOrgTerminology(resolved.ctx, await getServerLocale());
  const jobVars = { job: term("job", terms, "singular"), jobs: term("job", terms, "plural") };

  // Add-on enforcement (0070 honesty pass): cap.costing gates the PAGE content —
  // the costing service itself stays ungated (other modules consume it).
  if (!(await hasFeature(resolved.ctx, "cap.costing"))) {
    return (
      <Card>
        <CardHeader title={t("costing.title", jobVars)} />
        <p className="text-sm text-ink-muted">{t("costing.upsell")}</p>
        {can(resolved.archetype, "billing.view") ? (
          <Link
            href={`/o/${orgId}/settings/subscription`}
            className="mt-2 inline-block text-sm text-brand hover:underline"
          >
            {t("costing.upsell_cta")}
          </Link>
        ) : null}
      </Card>
    );
  }
  const jobs = await listActiveJobsBrief(resolved.ctx);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("costing.title", jobVars)}</h1>
      {jobs.length === 0 ? (
        <EmptyState title={t("costing.empty", jobVars)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                href={`/o/${orgId}/costing/${j.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <span className="font-medium text-ink">{j.reference}</span>
                <span className="ms-2 text-sm text-ink-muted">{j.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
