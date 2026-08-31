/** Integration global setup: refuse production, then env + migrations once per
 * run (idempotent). */
import "../../tooling/scripts/load-env-integration";
import { runMigrations } from "../../tooling/scripts/migrate";
import { requireIntegrationEnv } from "./helpers";
import { assertNotProduction } from "./guard-env";

export default async function globalSetup(): Promise<void> {
  // FIRST — before any connection, migration or test file. This suite creates
  // and deletes organizations, users and records; pointing it at production is
  // never what anyone meant to do.
  assertNotProduction();
  requireIntegrationEnv();
  const r = await runMigrations();
  console.log(
    `[integration setup] migrations: ${r.applied.length ? r.applied.join(", ") : "up to date"}`,
  );
}
