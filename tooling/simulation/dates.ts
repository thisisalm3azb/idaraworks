/**
 * Date helpers anchored to ONE explicit simulation as-of date (the real execution
 * date). Every historical record is derived relative to it so: current dashboard
 * periods have activity, recent weeks are dense, overdue rows are really overdue,
 * upcoming deadlines are really upcoming, and nothing lands in the future by
 * accident. Pure UTC arithmetic from the as-of string — no wall-clock reads.
 */

/** A calendar clock built from the as-of date; all offsets are relative to it. */
export class SimClock {
  readonly asOf: string; // YYYY-MM-DD
  private readonly base: number; // ms at UTC midnight of asOf
  constructor(asOf: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`bad asOf: ${asOf}`);
    this.asOf = asOf;
    this.base = Date.parse(`${asOf}T00:00:00.000Z`);
  }
  /** date string N days before as-of (negative N = future). */
  dayAgo(n: number): string {
    return new Date(this.base - n * 86400000).toISOString().slice(0, 10);
  }
  /** date string N days after as-of. */
  dayAhead(n: number): string {
    return this.dayAgo(-n);
  }
  /** date string N whole months before as-of (same day-of-month, clamped). */
  monthAgo(n: number): string {
    const d = new Date(this.base);
    const targetMonth = d.getUTCMonth() - n;
    const y = d.getUTCFullYear() + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12;
    const day = Math.min(
      d.getUTCDate(),
      new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), // last day of that month
    );
    return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
  }
  /** ISO timestamp at a given days-ago and hour (for created_at / submitted_at). */
  tsAgo(n: number, hourUtc = 9, minute = 0): string {
    return new Date(this.base - n * 86400000 + hourUtc * 3600000 + minute * 60000).toISOString();
  }
  /** whole days between two YYYY-MM-DD dates (a - b). */
  static diffDays(a: string, b: string): number {
    return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
  }
  /** days-ago value for an arbitrary date string, vs this clock's as-of. */
  daysAgoOf(date: string): number {
    return SimClock.diffDays(this.asOf, date);
  }
}
