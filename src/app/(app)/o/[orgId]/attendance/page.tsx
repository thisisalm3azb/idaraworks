import { redirect } from "next/navigation";
import { Badge, Card } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import {
  listAttendanceForDate,
  ATTENDANCE_STATUSES,
  type AttendanceGridRow,
} from "@/modules/attendance/service";
import { markAttendanceAction } from "./actions";

function todayIso(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(
    n.getUTCDate(),
  ).padStart(2, "0")}`;
}

export default async function AttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ date?: string; ok?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "attendance.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const a = resolved.archetype;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso();
  const rows = await listAttendanceForDate(resolved.ctx, a, date);
  const canMark = can(a, "attendance.manage");
  const mark = markAttendanceAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("attendance.title")}</h1>
        <form method="get" className="flex items-center gap-2">
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
          />
        </form>
      </div>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("attendance.saved")}
        </p>
      ) : null}
      <Card>
        <ul className="divide-y divide-line">
          {rows.map((r: AttendanceGridRow) => (
            <li key={r.employeeId} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{r.employeeName}</span>
                {r.status ? (
                  <Badge tone={r.status === "present" ? "success" : "warning"}>
                    {t(`attendance.status.${r.status}`)}
                    {r.source ? (
                      <span className="ms-1 text-xs opacity-70">
                        · {t(`attendance.source.${r.source}`)}
                      </span>
                    ) : null}
                  </Badge>
                ) : (
                  <span className="text-sm text-ink-muted">{t("attendance.not_marked")}</span>
                )}
              </div>
              {canMark ? (
                <div className="flex flex-wrap gap-1.5">
                  {ATTENDANCE_STATUSES.map((s) => (
                    <form key={s} action={mark}>
                      <input type="hidden" name="date" value={date} />
                      <input type="hidden" name="employee_id" value={r.employeeId} />
                      <input type="hidden" name="status" value={s} />
                      <button
                        type="submit"
                        className={`min-h-11 rounded-full border px-3 text-xs ${
                          r.status === s
                            ? "border-brand bg-brand text-ink-inverse"
                            : "border-line-strong bg-card text-ink"
                        }`}
                      >
                        {t(`attendance.status.${s}`)}
                      </button>
                    </form>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
          {rows.length === 0 ? (
            <li className="py-3 text-sm text-ink-muted">{t("attendance.not_marked")}</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
