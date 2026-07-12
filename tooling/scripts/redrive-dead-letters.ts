/**
 * Dead-letter redrive (runbooks/dead-letter-recovery.md). Run ONLY after the
 * root cause is fixed and deployed — redriving a poison event just loops it.
 *
 *   pnpm tsx tooling/scripts/redrive-dead-letters.ts
 *
 * Resets attempts on every dead-lettered domain event via the platform-task
 * surface (app.redrive_dead_lettered_domain_events); the next relay tick
 * re-publishes. Consumers are idempotent, so duplicates are harmless.
 */
import "./load-env";
import { redriveDeadLetters, checkDeadLetters } from "@/platform/events";
import { closeAppDb } from "@/platform/tenancy";

async function main() {
  const before = await checkDeadLetters("manual-redrive");
  const redriven = await redriveDeadLetters("manual-redrive");
  console.log(`dead-lettered before: ${before} | redriven (attempts reset): ${redriven}`);
  console.log("Watch /api/health checks.queue — unprocessed should drain within a few ticks.");
  await closeAppDb();
}

void main();
