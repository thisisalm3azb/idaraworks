import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { listWeekPlans, weekStartOf, type WeekPlanStatus } from "@/modules/documents/service";
import { listAssignableMembers } from "@/modules/jobs/service";
import { createWeekPlanAction } from "./actions";

const TONE: Record<WeekPlanStatus, "neutral" | "success" | "warning" | "info"> = {
  draft: "neutral",
  issued: "success",
  revised: "warning",
  cancelled: "neutral",
};

export default async function WeekPlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "week.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const manage = can(resolved.archetype, "week.manage");
  const plans = await listWeekPlans(resolved.ctx, resolved.archetype);
  const members = manage ? await listAssignableMembers(resolved.ctx, resolved.archetype) : [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("week_plan.title")}</h1>
        <Link href={`/o/${orgId}/week`} className="text-sm text-brand hover:underline">
          {t("week_plan.live_week")}
        </Link>
      </div>
      {sp.error ? (
        <Badge tone="danger">
          {sp.error === "duplicate_week" ? t("week_plan.error.duplicate_week") : t("common.error")}
        </Badge>
      ) : null}

      {manage ? (
        <Card>
          <CardHeader title={t("week_plan.new")} />
          <form action={createWeekPlanAction.bind(null, orgId)} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-muted">{t("week_plan.week_start")}</span>
              <input
                type="date"
                name="week_start"
                required
                defaultValue={weekStartOf(today)}
                className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-muted">{t("week_plan.plan_title")}</span>
              <input
                name="title"
                maxLength={200}
                className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-muted">{t("week_plan.manager")}</span>
              <select
                name="manager_user_id"
                defaultValue=""
                className="min-h-11 rounded-md border border-line bg-card px-3 text-sm text-ink"
              >
                <option value="">{t("common.none")}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.fullName}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="primary">
              {t("week_plan.create")}
            </Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("week_plan.all")} />
        {plans.length === 0 ? (
          <EmptyState title={t("week_plan.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {plans.map((p) => (
              <li key={p.id} className="py-3">
                <Link
                  href={`/o/${orgId}/week/plans/${p.id}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-ink">
                      <span dir="ltr">{p.reference}</span>
                      {p.title ? ` · ${p.title}` : ""}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {t("week_plan.week_of")} {formatDate(p.weekStart, { locale })} ·{" "}
                      {t("week_plan.jobs", { count: p.jobCount })}
                      {p.managerName ? ` · ${p.managerName}` : ""}
                    </span>
                  </span>
                  <Badge tone={TONE[p.status]}>{t(`week_plan.status.${p.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
