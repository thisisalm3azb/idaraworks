import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { getJob, listJobs } from "@/modules/jobs/service";
import {
  listReportableEmployees,
  listReportableStages,
  listItemsForReport,
  findEditableReportId,
  getReportDetail,
} from "@/modules/reports/service";
import { ReportComposer, type ComposerDict, type ReportInitial } from "./ReportComposer";

export default async function NewReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ job?: string; date?: string }>;
}) {
  const { orgId } = await params;
  const { job: jobParam, date: dateParam } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "reports.create")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);

  // Job picker when no (or an unreachable) job is chosen.
  const job = jobParam ? await getJob(resolved.ctx, a, jobParam) : null;
  if (!job) {
    const jobs = await listJobs(resolved.ctx, a);
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-ink">
          {t("reports.new.title", { daily_report: term("daily_report", terms, "singular") })}
        </h1>
        <p className="text-sm text-ink-secondary">{t("reports.new.pick_job")}</p>
        {jobs.length === 0 ? (
          <EmptyState title={t("jobs.empty", { jobs: term("job", terms, "plural") })} />
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/o/${orgId}/reports/new?job=${j.id}`}
                  className="flex min-h-12 items-center justify-between rounded-md border border-line bg-card px-4 text-ink hover:bg-sunken"
                >
                  <span className="font-medium">{j.reference}</span>
                  <span className="text-sm text-ink-secondary">{j.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const [crew, items, stages] = await Promise.all([
    listReportableEmployees(resolved.ctx, a, job.id),
    listItemsForReport(resolved.ctx, a),
    listReportableStages(resolved.ctx, a, job.id),
  ]);

  // Returned-report re-edit (review finding C): when a date is given and an
  // editable (draft/returned) report exists for it, pre-load the composer with
  // its content so the author corrects rather than re-types.
  let initial: ReportInitial | undefined;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const editId = await findEditableReportId(resolved.ctx, a, job.id, dateParam);
    const detail = editId ? await getReportDetail(resolved.ctx, a, editId) : null;
    if (detail) {
      initial = {
        reportDate: detail.reportDate,
        summary: detail.summary,
        blockers: detail.blockers ?? "",
        work: detail.workLines.map((w) => ({
          stageKey: w.stageKey ?? undefined,
          description: w.description,
          progressNote: w.progressNote ?? undefined,
        })),
        labour: detail.labourLines.map((l) => ({
          employeeId: l.employeeId,
          name: l.employeeName ?? l.employeeId,
          normalHours: Number(l.normalHours),
          otHours: Number(l.otHours),
        })),
        materials: detail.materialLines.map((m) => ({
          itemId: m.itemId ?? undefined,
          itemName: m.itemName,
          qty: Number(m.qty),
          unit: m.unit,
        })),
      };
    }
  }

  const dict: ComposerDict = {
    new_title: t("reports.new.title", { daily_report: term("daily_report", terms, "singular") }),
    date: t("reports.new.date"),
    summary: t("reports.section.summary"),
    work: t("reports.section.work"),
    work_description: t("reports.work.description"),
    labour: t("reports.section.labour"),
    normal_hours: t("reports.labour.normal_hours"),
    ot_hours: t("reports.labour.ot_hours"),
    materials: t("reports.section.materials"),
    materials_search: t("reports.materials.search", { items: t("nav.items") }),
    materials_free: t("reports.materials.free_text"),
    blockers: t("reports.section.blockers"),
    add: t("common.add"),
    submit: t("reports.submit"),
    submitting: t("reports.submitting"),
    retry: t("reports.retry"),
    saved_offline: t("reports.saved_offline"),
    draft_restored: t("reports.draft_restored"),
    err_duplicate: t("reports.duplicate", {
      daily_report: term("daily_report", terms, "singular"),
    }),
    err_identity: t("common.error"),
    err_invalid: t("common.error"),
    err_failed: t("common.error"),
  };

  // Server "today" as YYYY-MM-DD (the composer lets the user change it).
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;

  return (
    <ReportComposer
      orgId={orgId}
      jobId={job.id}
      jobLabel={`${job.reference} — ${job.name}`}
      today={today}
      crew={crew}
      items={items}
      stages={stages.map((s) => ({ stageKey: s.stageKey, label: s.name[locale] || s.name.en }))}
      dict={dict}
      dir={locale === "ar" ? "rtl" : "ltr"}
      initial={initial}
    />
  );
}
