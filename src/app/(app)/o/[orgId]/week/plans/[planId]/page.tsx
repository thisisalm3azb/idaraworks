import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import {
  getWeekPlan,
  listWeekPlanJobIds,
  listDocumentShares,
  type WeekPlanStatus,
} from "@/modules/documents/service";
import { listJobs, listAssignableMembers } from "@/modules/jobs/service";
import { DocumentActions } from "../../../documents/DocumentActions";
import { ShareSection } from "../../../documents/ShareSection";
import {
  updateWeekPlanAction,
  setWeekPlanJobsAction,
  issueWeekPlanAction,
  reviseWeekPlanAction,
  cancelWeekPlanAction,
} from "../actions";

const TONE: Record<WeekPlanStatus, "neutral" | "success" | "warning" | "info"> = {
  draft: "neutral",
  issued: "success",
  revised: "warning",
  cancelled: "neutral",
};

const FIELD = "min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink";

export default async function WeekPlanDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; planId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, planId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "week.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const plan = await getWeekPlan(resolved.ctx, resolved.archetype, planId);
  if (!plan) notFound();

  const manage = can(resolved.archetype, "week.manage");
  const canShare = can(resolved.archetype, "documents.share");
  const draft = plan.status === "draft";
  const selected = new Set(await listWeekPlanJobIds(resolved.ctx, resolved.archetype, planId));
  // The work picker only exists for a draft, so the jobs list is only read there.
  const jobs = manage && draft ? await listJobs(resolved.ctx, resolved.archetype) : [];
  const members =
    manage && draft ? await listAssignableMembers(resolved.ctx, resolved.archetype) : [];
  const shares = canShare
    ? await listDocumentShares(resolved.ctx, resolved.archetype, "week_plan", planId)
    : [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href={`/o/${orgId}/week/plans`} className="text-sm text-brand hover:underline">
        {t("week_plan.back")}
      </Link>
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink" dir="ltr">
          {plan.reference}
        </h1>
        <Badge tone={TONE[plan.status]}>{t(`week_plan.status.${plan.status}`)}</Badge>
      </div>
      {sp.ok ? <Badge tone="success">{t("common.saved")}</Badge> : null}
      {sp.error ? (
        <Badge tone="danger">
          {sp.error === "immutable"
            ? t("week_plan.error.immutable")
            : sp.error === "reason"
              ? t("week_plan.error.reason")
              : t("common.error")}
        </Badge>
      ) : null}

      <Card>
        <CardHeader
          title={`${t("week_plan.week_of")} ${formatDate(plan.weekStart, { locale })}`}
          meta={t("week_plan.jobs", { count: plan.jobCount })}
        />
        <dl className="flex flex-col gap-1 text-sm">
          {plan.title ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.plan_title")}</dt>
              <dd className="text-ink">{plan.title}</dd>
            </div>
          ) : null}
          {plan.managerName ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.manager")}</dt>
              <dd className="text-ink">{plan.managerName}</dd>
            </div>
          ) : null}
          {plan.issuedAt ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.issued_on")}</dt>
              <dd className="text-ink">{formatDate(plan.issuedAt.slice(0, 10), { locale })}</dd>
            </div>
          ) : null}
          {plan.revisionOfId ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.revision_of")}</dt>
              <dd className="text-ink">
                <Link
                  href={`/o/${orgId}/week/plans/${plan.revisionOfId}`}
                  className="text-brand hover:underline"
                >
                  {t("week_plan.previous_plan")}
                </Link>
              </dd>
            </div>
          ) : null}
          {plan.revisionReason ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.revise_reason")}</dt>
              <dd className="text-ink">{plan.revisionReason}</dd>
            </div>
          ) : null}
          {plan.cancelledReason ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t("week_plan.cancel_reason")}</dt>
              <dd className="text-ink">{plan.cancelledReason}</dd>
            </div>
          ) : null}
          {plan.notes ? <p className="mt-1 text-ink-secondary">{plan.notes}</p> : null}
        </dl>
      </Card>

      <Card>
        <CardHeader title={t("documents.title")} />
        <DocumentActions orgId={orgId} kind="week_plan" id={plan.id} />
      </Card>

      {canShare ? (
        <ShareSection orgId={orgId} kind="week_plan" id={plan.id} shares={shares} />
      ) : null}

      {manage && draft ? (
        <>
          <Card>
            <CardHeader title={t("week_plan.details")} meta={t("week_plan.draft_hint")} />
            <form
              action={updateWeekPlanAction.bind(null, orgId)}
              className="flex flex-col gap-3 text-sm"
            >
              <input type="hidden" name="plan_id" value={plan.id} />
              <label className="flex flex-col gap-1">
                <span className="text-ink-muted">{t("week_plan.plan_title")}</span>
                <input
                  name="title"
                  maxLength={200}
                  defaultValue={plan.title ?? ""}
                  className={FIELD}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-ink-muted">{t("week_plan.manager")}</span>
                <select
                  name="manager_user_id"
                  defaultValue={plan.managerUserId ?? ""}
                  className={FIELD}
                >
                  <option value="">{t("common.none")}</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-ink-muted">{t("week_plan.notes")}</span>
                <textarea
                  name="notes"
                  rows={3}
                  maxLength={2000}
                  defaultValue={plan.notes ?? ""}
                  className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink"
                />
              </label>
              <Button type="submit">{t("common.save")}</Button>
            </form>
          </Card>

          <Card>
            <CardHeader title={t("week_plan.select_work")} />
            {jobs.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("week_plan.no_work_available")}</p>
            ) : (
              <form
                action={setWeekPlanJobsAction.bind(null, orgId)}
                className="flex flex-col gap-2"
              >
                <input type="hidden" name="plan_id" value={plan.id} />
                <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <label className="flex min-h-11 items-center gap-3 py-2">
                        <input
                          type="checkbox"
                          name="job_id"
                          value={j.id}
                          defaultChecked={selected.has(j.id)}
                          className="size-5 shrink-0"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm text-ink">
                            <span dir="ltr">{j.reference}</span> · {j.name}
                          </span>
                          <span className="text-xs text-ink-muted">
                            {j.customerName ?? ""}
                            {j.dueDate
                              ? ` · ${t("jobs.due")}: ${formatDate(j.dueDate, { locale })}`
                              : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <Button type="submit">{t("week_plan.save_selection")}</Button>
              </form>
            )}
          </Card>

          <Card>
            <CardHeader title={t("week_plan.issue")} meta={t("week_plan.issue_hint")} />
            <form action={issueWeekPlanAction.bind(null, orgId)}>
              <input type="hidden" name="plan_id" value={plan.id} />
              <Button type="submit" variant="primary">
                {t("week_plan.issue")}
              </Button>
            </form>
          </Card>
        </>
      ) : null}

      {manage && plan.status === "issued" ? (
        <Card>
          <CardHeader title={t("week_plan.revise")} meta={t("week_plan.revise_hint")} />
          <div className="flex flex-col gap-3">
            <form action={reviseWeekPlanAction.bind(null, orgId)} className="flex flex-col gap-2">
              <input type="hidden" name="plan_id" value={plan.id} />
              <input
                name="reason"
                required
                maxLength={500}
                placeholder={t("week_plan.revise_reason")}
                className={FIELD}
              />
              <Button type="submit">{t("week_plan.revise")}</Button>
            </form>
            <form action={cancelWeekPlanAction.bind(null, orgId)} className="flex flex-col gap-2">
              <input type="hidden" name="plan_id" value={plan.id} />
              <input
                name="reason"
                required
                maxLength={500}
                placeholder={t("week_plan.cancel_reason")}
                className={FIELD}
              />
              <Button type="submit" variant="danger">
                {t("week_plan.cancel")}
              </Button>
            </form>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
