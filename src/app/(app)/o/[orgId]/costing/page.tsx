import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
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
