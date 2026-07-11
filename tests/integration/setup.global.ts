/** Integration global setup: env + migrations once per run (idempotent). */
import "../../tooling/scripts/load-env";
import { runMigrations } from "../../tooling/scripts/migrate";
import { requireIntegrationEnv } from "./helpers";

export default async function globalSetup(): Promise<void> {
  requireIntegrationEnv();
  const r = await runMigrations();
  console.log(
    `[integration setup] migrations: ${r.applied.length ? r.applied.join(", ") : "up to date"}`,
  );
}
