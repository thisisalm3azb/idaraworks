/**
 * Run the app against the TEST project with H29 country packs AND Spanish ON,
 * so the UI walk can see both flags in their enabled state before either is
 * turned on in production. Same law as the other previews: `.env.test.local`
 * loads FIRST so `.env.local` (production) cannot win, and the production ref
 * is refused outright.
 *
 * Spanish is enabled HERE and only here. Turning it on locally is how the walk
 * proves the switcher, the layout and the catalogue work; turning it on in
 * production is an owner action that waits on a native review.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_COUNTRY_PACKS = "1";
process.env.FEATURE_LOCALE_ES = "1";
process.env.FEATURE_REVENUE_STUDIO = "1";
process.env.FEATURE_DOCUMENT_STUDIO = "1";
process.env.FEATURE_MANAGEMENT_STUDIO = "1";
process.env.FEATURE_FINANCE_SURFACES = "1";
process.env.FEATURE_HR_SURFACES = "1";
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(`Country packs and Spanish ON, database project ${ref}`);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3216"], { stdio: "inherit", shell: true });
