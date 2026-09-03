/**
 * H28 — the Inngest cron for queued Idara runs (ADR-59). The executor lives in
 * the module door so the authenticated cron route can call the same code when
 * Inngest is not configured.
 */
import { cron } from "inngest";
import { executeQueuedIdaraRuns, sweepIdaraSchedules } from "@/modules/idara/service";
import { inngest } from "@/platform/events";

export { executeQueuedIdaraRuns, sweepIdaraSchedules };

export const idaraRunExecutor = inngest.createFunction(
  { id: "idara-run-executor", retries: 1, triggers: [cron("*/2 * * * *")] },
  async ({ runId }) => executeQueuedIdaraRuns(`inngest-${runId}`),
);

/** Proactive schedules: hourly sweep; each schedule decides whether it is due in its organisation's timezone. */
export const idaraScheduleSweep = inngest.createFunction(
  { id: "idara-schedule-sweep", retries: 1, triggers: [cron("25 * * * *")] },
  async ({ runId }) => sweepIdaraSchedules(`inngest-${runId}`),
);
