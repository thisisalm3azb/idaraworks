/**
 * The calendar service (BUILD_BIBLE §4.10; audit F-41). ALL working-day math goes
 * through here — never raw date arithmetic — so the working week + holidays + Eid
 * are honoured everywhere. Without it the daily/aggregate exception rules (E-01
 * missing report, E-02 overdue stage) would fire critical exceptions across every
 * GCC tenant during Eid — a synchronised, trust-destroying noise storm.
 *
 * The pure functions take a `Calendar` snapshot + `YYYY-MM-DD` business dates (org-
 * local `date`, not timestamps), so they are deterministic and unit-testable
 * against the UAE/KSA/6-day/Eid/Ramadan fixtures (doc 10 #49).
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type HolidayRange = { start: string; end: string }; // inclusive YYYY-MM-DD

export type Calendar = {
  /** The org's working days (e.g. UAE mon–fri, KSA sun–thu, 6-day workshop). */
  workingDays: ReadonlySet<Weekday>;
  /** Inclusive holiday ranges (public holidays, Eid, org closures). */
  holidays: readonly HolidayRange[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday of a YYYY-MM-DD date, computed in UTC to avoid tz drift on a pure date. */
export function weekdayOf(date: string): Weekday {
  if (!DATE_RE.test(date)) throw new Error(`weekdayOf: not a date: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[dow]!;
}

/** True iff `date` is a working day: its weekday is a working day AND it is not a holiday. */
export function isWorkingDay(cal: Calendar, date: string): boolean {
  if (!cal.workingDays.has(weekdayOf(date))) return false;
  for (const h of cal.holidays) {
    if (date >= h.start && date <= h.end) return false;
  }
  return true;
}

/** Add `n` calendar days to a YYYY-MM-DD date (n may be negative). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Count WORKING days strictly after `from` up to and including `to` (from < to).
 * If `to <= from`, returns 0. Used for "N working days since the last report".
 */
export function workingDaysBetween(cal: Calendar, from: string, to: string): number {
  if (to <= from) return 0;
  let count = 0;
  let cur = addDays(from, 1);
  // Guard against pathological ranges; real gaps are days/weeks, not years.
  let guard = 0;
  while (cur <= to && guard < 3660) {
    if (isWorkingDay(cal, cur)) count++;
    cur = addDays(cur, 1);
    guard++;
  }
  return count;
}

/** Load the org's calendar snapshot (working week + holiday ranges) for date math. */
export async function loadCalendar(ctx: Ctx): Promise<Calendar> {
  return withCtx(ctx, async (tx) => {
    const orgRows = (await tx.execute(sql`
      select working_week from public.org where id = ${ctx.orgId}
    `)) as unknown as Array<{ working_week: { days?: string[] } }>;
    const days = orgRows[0]?.working_week?.days ?? ["mon", "tue", "wed", "thu", "fri"];
    const holRows = (await tx.execute(sql`
      select starts_on::text as start, coalesce(ends_on, starts_on)::text as end
      from public.org_holiday_calendar where org_id = ${ctx.orgId}
    `)) as unknown as Array<{ start: string; end: string }>;
    return {
      workingDays: new Set(days.filter((d): d is Weekday => (WEEKDAYS as string[]).includes(d))),
      holidays: holRows.map((r) => ({ start: r.start, end: r.end })),
    };
  });
}
