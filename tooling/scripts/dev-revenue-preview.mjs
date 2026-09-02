/**
 * Run the app against the TEST project with the H27 Revenue Growth Studio ON
 * (plus the H22–H26 surfaces, so linked records, documents and money context
 * are visible). Same law as dev-docstudio-preview.mjs: `.env.test.local`
 * loads FIRST so `.env.local` (production) cannot win, and the production
 * ref is refused.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_REVENUE_STUDIO = "1";
process.env.FEATURE_DOCUMENT_STUDIO = "1";
process.env.FEATURE_MANAGEMENT_STUDIO = "1";
process.env.FEATURE_FINANCE_SURFACES = "1";
process.env.FEATURE_HR_SURFACES = "1";
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(
  `Revenue Studio + document studio + studio + finance + HR + stock ON, database project ${ref}`,
);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3214"], { stdio: "inherit", shell: true });
