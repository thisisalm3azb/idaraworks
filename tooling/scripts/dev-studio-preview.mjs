/**
 * Run the app against the TEST project with the H25 Management Studio ON
 * (plus the H22/H23/H24 surfaces, so linked records and money context are
 * visible). Same law as dev-hr-preview.mjs: `.env.test.local` loads FIRST so
 * `.env.local` (production) cannot win, and the production ref is refused.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_MANAGEMENT_STUDIO = "1";
process.env.FEATURE_FINANCE_SURFACES = "1";
process.env.FEATURE_HR_SURFACES = "1";
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(`Studio + finance + HR + stock surfaces ON, database project ${ref}`);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3212"], { stdio: "inherit", shell: true });
