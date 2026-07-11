/**
 * VC-1 hosted spike runner: `pnpm vc1`.
 * Applies migration 0000 ONLY (helpers + role — no real tables), then runs the
 * pooler/RLS mechanism checks. Exit 1 on any failure — in that case STOP and
 * consult the documented fallback (S0 checklist AR-2): per-request session-mode
 * connections for writes, same withCtx seam.
 */
import "./load-env";
import { runMigrations } from "./migrate";
import { runVc1 } from "../vc1/run-vc1";

async function main() {
  const migrated = await runMigrations({ to: "0000" });
  console.log(
    `pre-step: migrations up to 0000 (${migrated.applied.length ? `applied ${migrated.applied}` : "already applied"})`,
  );
  // Watchdog: the whole spike must conclude in 5 minutes — a hang IS a failure
  // with a diagnosis, never a silent CI-timeout (Phase B incident).
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            "VC-1 watchdog: spike exceeded 5 minutes — treat as FAIL and read the last 'vc1:' log line for the hung check",
          ),
        ),
      300_000,
    ).unref(),
  );
  const report = await Promise.race([runVc1(), watchdog]);
  console.log("\nVC-1 — Supavisor GUC/RLS mechanism:");
  for (const r of report.results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.check} — ${r.detail}`);
  }
  console.log(report.passed ? "\nVC-1: ALL CHECKS PASSED" : "\nVC-1: FAILED — do not proceed");
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("VC-1 crashed:", err);
  process.exit(1);
});
