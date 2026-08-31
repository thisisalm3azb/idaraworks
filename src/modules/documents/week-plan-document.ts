/**
 * The weekly plan as a document (H22.0).
 *
 * Shaped for the site, not for accounts. There is no subtotal, no tax and no
 * currency, because a plan has none: the render model makes financial fields
 * optional precisely so an operational document is not forced into an invoice
 * skeleton with empty money columns.
 *
 * One section per job, listing its steps with owner, due date and state, so the
 * page can be read down a column on a workshop floor. The work renders LIVE
 * from the job and task records; the plan record supplies only which work is
 * covered, who is responsible, and the notes and issue history.
 */
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { formatDate } from "@/platform/format";
import type { DocLanguage, DocumentRenderModel, DocumentSection } from "@/platform/documents";
import { assignedJobCondition } from "@/modules/jobs/service";
import { resolveIssuer } from "./issuer-resolve";
import { getWeekPlan } from "./week-plan";

/**
 * Tasks rendered per covered job.
 *
 * The plan names one week, but a job's tasks accumulate over its whole life and
 * completing one does not archive it, so an unbounded join renders every task
 * ever created on every covered job. Sixty per job is far more than a week's
 * work and keeps a long-running job from turning one document into thousands of
 * rows the renderer must lay out.
 */
const TASKS_PER_JOB = 60;

const t = (language: DocLanguage, en: string, ar: string) => (language === "en" ? en : ar);
const dateLocale = (language: DocLanguage): "en" | "ar" => (language === "en" ? "en" : "ar");

/** Step states, in the document's own words rather than raw keys. */
const STATE_LABEL: Record<string, { en: string; ar: string }> = {
  pending: { en: "Not started", ar: "لم تبدأ" },
  ready: { en: "Ready", ar: "جاهزة" },
  in_progress: { en: "In progress", ar: "قيد التنفيذ" },
  blocked: { en: "Blocked", ar: "معطلة" },
  awaiting_approval: { en: "Awaiting approval", ar: "بانتظار الاعتماد" },
  completed: { en: "Completed", ar: "مكتملة" },
  cancelled: { en: "Cancelled", ar: "ملغاة" },
};

export async function weekPlanModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  assertCan(archetype, "week.view");
  const plan = await getWeekPlan(ctx, archetype, id);
  if (!plan) throw new Error(`no weekly plan ${id}`);

  // F-6: a foreman reaches only assigned work, always. The document is a read of
  // the same jobs and tasks as every other surface, so it narrows the same way.
  // Without this a plan hands a foreman the whole workshop's week.
  const foreman = archetype === "foreman";

  const [meta] = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select issuer_snapshot from public.week_plan where id = ${id} and org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<{ issuer_snapshot: unknown }>;

  // One bounded query for every step in the covered work, rather than a query
  // per job: a plan covering twenty jobs must not cost twenty round trips.
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as job_id, j.reference as job_reference, j.name as job_name,
             j.status_key, j.due_date::text as job_due,
             wpj.sort as job_sort, wpj.note as job_note,
             tk.id::text as task_id, tk.title as task_title, tk.status as task_status,
             tk.due_date::text as task_due, e.name as owner_name,
             (select count(*)::int from public.task_dependency d
               join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
               where d.org_id = tk.org_id and d.task_id = tk.id and d.removed_at is null
                 and up.status not in ('completed', 'cancelled')) as blockers
      from public.week_plan_job wpj
      join public.job j on j.id = wpj.job_id and j.org_id = wpj.org_id
      left join lateral (
        select tk.* from public.task tk
        where tk.job_id = j.id and tk.org_id = j.org_id and tk.archived = false
        order by tk.due_date nulls last, tk.created_at
        limit ${TASKS_PER_JOB}
      ) tk on true
      left join public.employee e on e.id = tk.assignee_employee_id and e.org_id = tk.org_id
      where wpj.org_id = ${ctx.orgId} and wpj.week_plan_id = ${id}
        and wpj.removed_at is null
        ${foreman ? sql`and ${assignedJobCondition(ctx)}` : sql``}
      order by wpj.sort, j.reference, tk.due_date nulls last, tk.created_at
    `),
  )) as unknown as Array<Record<string, unknown>>;

  const byJob = new Map<
    string,
    { name: string; reference: string; note: string | null; lines: Array<Record<string, unknown>> }
  >();
  for (const r of rows) {
    const key = r.job_id as string;
    if (!byJob.has(key)) {
      byJob.set(key, {
        name: r.job_name as string,
        reference: r.job_reference as string,
        note: (r.job_note as string | null) ?? null,
        lines: [],
      });
    }
    if (r.task_id) byJob.get(key)!.lines.push(r);
  }

  const columns = [
    t(language, "Step", "الخطوة"),
    t(language, "Owner", "المسؤول"),
    t(language, "Due", "الاستحقاق"),
    t(language, "State", "الحالة"),
  ];

  const sections: DocumentSection[] = [...byJob.entries()].map(([, job]) => ({
    title: `${job.reference} · ${job.name}`,
    columns,
    lines: job.lines.map((l) => {
      const state = STATE_LABEL[l.task_status as string];
      const blockers = Number(l.blockers ?? 0);
      return {
        description: l.task_title as string,
        detail:
          blockers > 0
            ? t(language, `Waiting on ${blockers} step(s)`, `بانتظار ${blockers} خطوة`)
            : (job.note ?? null),
        state: state ? t(language, state.en, state.ar) : (l.task_status as string),
        quantity: (l.owner_name as string | null) ?? t(language, "Unassigned", "غير مسند"),
        unitPrice: l.task_due
          ? formatDate(l.task_due as string, { locale: dateLocale(language) })
          : t(language, "No date", "بلا تاريخ"),
      };
    }),
    emptyText: t(language, "No steps recorded for this work.", "لا توجد خطوات مسجلة لهذا العمل."),
  }));

  // The one resolver every document type uses. The inline version this replaced
  // had both arms of its ternary producing the same value and dropped the
  // notice, so an issued plan with no usable snapshot silently presented today's
  // identity as the one it was issued under.
  const { issuer, notice } = await resolveIssuer(
    ctx,
    meta?.issuer_snapshot,
    plan.status !== "draft",
  );

  return {
    kind: "week_plan",
    language,
    issuer,
    titleEn: "Weekly plan",
    titleAr: "الخطة الأسبوعية",
    reference: plan.reference,
    dateText: `${formatDate(plan.weekStart, { locale: dateLocale(language) })} – ${formatDate(plan.weekEnd, { locale: dateLocale(language) })}`,
    statusText: plan.status,
    noticeText: notice,
    revisionText: plan.revisionOfId ? t(language, "Revision", "مراجعة") : undefined,
    watermark: plan.status === "draft" ? "draft" : plan.status === "cancelled" ? "cancelled" : null,
    fields: [
      {
        label: t(language, "Week", "الأسبوع"),
        value: `${plan.weekStart} – ${plan.weekEnd}`,
        ltr: true,
      },
      ...(plan.managerName
        ? [{ label: t(language, "Responsible", "المسؤول"), value: plan.managerName }]
        : []),
      ...(plan.title ? [{ label: t(language, "Title", "العنوان"), value: plan.title }] : []),
    ],
    sections:
      sections.length > 0
        ? sections
        : [
            {
              columns,
              lines: [],
              emptyText: t(
                language,
                "No work has been added to this plan.",
                "لم تتم إضافة أي عمل إلى هذه الخطة.",
              ),
            },
          ],
    // No totals: a plan has no money in it, and the render model does not
    // require any.
    notesTitle: plan.notes ? t(language, "Notes", "ملاحظات") : null,
    notes: plan.notes,
    attribution: [
      ...(plan.revisionReason
        ? [{ label: t(language, "Revision reason", "سبب المراجعة"), value: plan.revisionReason }]
        : []),
      ...(plan.cancelledReason
        ? [{ label: t(language, "Cancelled", "ملغاة"), value: plan.cancelledReason }]
        : []),
    ],
    showSignatory: true,
  };
}
