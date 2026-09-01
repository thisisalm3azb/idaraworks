/**
 * Run the app against the TEST project with the H22 stock surfaces switched on.
 *
 * The screens cannot be verified on production yet: the release flag is an
 * environment variable and turning it on there is the owner's decision, not a
 * thing to do in passing. But the pages themselves — English and Arabic, desktop
 * and phone — can be looked at against the same schema and the same code, and
 * that is what this is for.
 *
 * `.env.test.local` is loaded into process.env FIRST, because Next gives an
 * existing process variable precedence over anything in a .env file: without
 * that ordering `.env.local` would win and point this at production.
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ path: [".env.test.local", ".env.test"], quiet: true });
process.env.FEATURE_STOCK_SURFACES = "1";
process.env.APP_ENV = "dev";

const ref = (process.env.DIRECT_URL ?? "").match(/(?:db|pooler)[.@]([a-z0-9-]+)\./)?.[1] ?? "?";
console.log(`stock surfaces ON, database project ${ref}`);
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

spawn("npx", ["next", "dev", "--port", "3210"], { stdio: "inherit", shell: true });
