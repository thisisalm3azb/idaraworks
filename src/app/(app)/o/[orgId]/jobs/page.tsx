import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import {
  getJobStatusLabels,
  listActivePresets,
  listAssignableMembers,
  listJobs,
} from "@/modules/jobs/service";
import { listCustomers } from "@/modules/masters/service";
import { createJobAction } from "./actions";

const STATUS_TONE = {
  draft: "neutral",
  active: "info",
  on_hold: "warning",
  done: "success",
  cancelled: "neutral",
} as const;

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const { error } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobTerm = term("job", terms, "singular");
  const jobsTerm = term("job", terms, "plural");

  const jobs = await listJobs(resolved.ctx, resolved.archetype);
  const statusLabels = await getJobStatusLabels(resolved.ctx, locale);
  const canCreate = can(resolved.archetype, "jobs.create");
  const presets = canCreate ? await listActivePresets(resolved.ctx, resolved.archetype) : [];
  const members = canCreate ? await listAssignableMembers(resolved.ctx, resolved.archetype) : [];
  const customers = can(resolved.archetype, "customers.view")
    ? await listCustomers(resolved.ctx, resolved.archetype)
    : [];
  const createWithOrg = createJobAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("jobs.title", { jobs: jobsTerm })} />
        {error === "limit" ? (
          <p className="mb-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            {t("jobs.limit_reached", { job: jobTerm, jobs: jobsTerm })}
          </p>
        ) : error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {jobs.length === 0 ? (
          <EmptyState title={t("jobs.empty", { jobs: jobsTerm })} />
        ) : (
          <ul className="divide-y divide-line">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/o/${orgId}/jobs/${j.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {j.reference} — {j.name}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {j.presetCode ?? ""} {j.customerName ? `· ${j.customerName}` : ""}
                      {j.progress !== null && j.progress !== undefined ? ` · ${j.progress}%` : ""}
                    </p>
                    {j.progress !== null && j.progress !== undefined ? (
                      <div className="mt-1 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-sunken">
                        <div className="h-full bg-brand" style={{ width: `${j.progress}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <Badge
                    tone={STATUS_TONE[j.statusCategory as keyof typeof STATUS_TONE] ?? "neutral"}
                  >
                    {statusLabels[j.statusKey] ?? j.statusKey}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canCreate && presets.length > 0 ? (
        <Card>
          <CardHeader title={t("jobs.new.title", { job: jobTerm })} />
          <form action={createWithOrg} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="preset_id" className="text-sm font-medium text-ink">
                {t("jobs.new.preset")}
              </label>
              <select
                id="preset_id"
                name="preset_id"
                required
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {locale === "ar" ? p.names.ar : p.names.en}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t("common.name")} name="name" required />
            {members.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="foreman_user_id" className="text-sm font-medium text-ink">
                  {t("jobs.new.foreman")}
                </label>
                <select
                  id="foreman_user_id"
                  name="foreman_user_id"
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName || m.userId.slice(0, 8)} ({m.roleKey})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {customers.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="customer_id" className="text-sm font-medium text-ink">
                  {t("jobs.new.customer", { customer: term("customer", terms, "singular") })}
                </label>
                <select
                  id="customer_id"
                  name="customer_id"
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {customers
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <Button type="submit">{t("jobs.new.cta", { job: jobTerm })}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
