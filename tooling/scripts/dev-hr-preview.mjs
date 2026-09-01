/**
 * Run the app against the TEST project with the H23 HR surfaces switched on
 * (and stock too, so the inbox composition can be seen whole). Same law as
 * dev-stock-preview.mjs: `.env.test.local` loads FIRST so `.env.local`
 * (production) cannot win, and the production ref is refused outright.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_HR_SURFACES = "1";
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(`HR + stock surfaces ON, database project ${ref}`);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3211"], { stdio: "inherit", shell: true });
