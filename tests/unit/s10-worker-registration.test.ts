/**
 * S10 regression (review): retentionPruneCron was imported into src/workers/index.ts but never
 * added to the workerFunctions array, so /api/inngest never served it and the retention cron would
 * never run. Assert the reference identity is registered — an import-but-not-register drops here.
 */
import { describe, it, expect } from "vitest";
import { workerFunctions } from "@/workers";
import { retentionPruneCron } from "@/workers/functions/retention-prune";
import { subscriptionLifecycleCron } from "@/workers/functions/subscription-worker";

describe("S10 worker registration", () => {
  it("registers the retention-prune + subscription-lifecycle crons in workerFunctions", () => {
    expect(workerFunctions).toContain(retentionPruneCron);
    expect(workerFunctions).toContain(subscriptionLifecycleCron);
  });

  it("has no duplicate function references in the registry", () => {
    expect(new Set(workerFunctions).size).toBe(workerFunctions.length);
  });
});
