/**
 * Run the app against the TEST project with H28 Idara Intelligence ON (plus
 * the H22–H27 surfaces, so the dock has records to talk about). Same law as
 * the other previews: `.env.test.local` loads FIRST so `.env.local`
 * (production) cannot win, and the production ref is refused. The
 * DETERMINISTIC provider is enabled so the walk can drive real answers
 * without any external call or credential.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_IDARA_INTELLIGENCE = "1";
process.env.FEATURE_REVENUE_STUDIO = "1";
process.env.FEATURE_DOCUMENT_STUDIO = "1";
process.env.FEATURE_MANAGEMENT_STUDIO = "1";
process.env.FEATURE_FINANCE_SURFACES = "1";
process.env.FEATURE_HR_SURFACES = "1";
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.AI_DETERMINISTIC_PROVIDER = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(`Idara Intelligence ON with the deterministic provider, database project ${ref}`);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3215"], { stdio: "inherit", shell: true });
