/**
 * H33 Pilot Lab — the launcher.
 *
 *   npm run lab:open                       # list companies and personas
 *   npm run lab:open -- tradeline finance  # start the app on the test env and open that persona
 *   npm run lab:open -- tradeline finance --no-browser   # print the link only
 *
 * What it does, in order:
 *   1. Loads `.env.test.local` and REFUSES anything that is not the isolated
 *      test project (guard.ts). Production is unreachable from here by
 *      construction, not by care.
 *   2. Finds the company's marked organisation and the persona's login.
 *   3. Mints a ONE-TIME sign-in link through the Supabase Admin API — no
 *      password is ever known, printed, stored or typed — and points it at the
 *      app's own /auth/confirm route, which consumes it exactly once.
 *   4. Starts `next dev` on port 3000 against the test env with every lab
 *      surface flag on (and AI / country packs / Spanish OFF), unless something
 *      already answers there.
 *   5. Opens the browser at the link.
 *
 * Nothing here is publishable: it is local, it needs the service-role key that
 * lives only on this machine, and the link it mints dies on first use.
 */
import { spawn, exec } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { COMPANIES, companyByKey, personaEmail } from "./companies";
import { findLabOrg } from "./provision";
import { ENABLED_TEST_CAPABILITIES } from "./run";
import type { PersonaKey } from "./types";

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const NO_BROWSER = process.argv.includes("--no-browser");
const NO_SERVER = process.argv.includes("--no-server");

function list(): void {
  console.log("\nH33 Pilot Lab — companies and personas\n");
  for (const c of COMPANIES) {
    console.log(
      `${c.key.padEnd(10)} ${c.nameEn}  ·  ${c.nameAr}  (${c.country}, ${c.currency}, ${c.templateKey})`,
    );
    for (const p of c.personas)
      console.log(
        `   ${p.key.padEnd(11)} ${p.roleKey.padEnd(12)} ${p.fullName.padEnd(22)} ${p.describes}`,
      );
    console.log();
  }
  console.log("Open one:   npm run lab:open -- <company> <persona>");
  console.log("Example:    npm run lab:open -- tradeline finance\n");
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  if (await serverUp()) {
    console.log(
      `app already answering on ${BASE} — reusing it (make sure it was started against the TEST env)`,
    );
    return;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const f of ENABLED_TEST_CAPABILITIES) env[f] = "1";
  // Never on, whatever the shell says.
  delete env.FEATURE_IDARA_INTELLIGENCE;
  delete env.FEATURE_COUNTRY_PACKS;
  delete env.FEATURE_LOCALE_ES;
  env.CI = "";
  console.log(
    `starting next dev on ${BASE} against the test project (flags: ${ENABLED_TEST_CAPABILITIES.join(", ")})`,
  );
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "dev", "-p", String(PORT)],
    {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      shell: process.platform === "win32",
    },
  );
  child.unref();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the app did not start within two minutes; check the terminal output");
}

async function main() {
  if (argv.length < 2) {
    list();
    return;
  }
  const env = loadLabEnv();
  const company = companyByKey(argv[0]!);
  const personaKey = argv[1] as PersonaKey;
  const persona = company.personas.find((p) => p.key === personaKey);
  if (!persona)
    throw new Error(
      `unknown persona ${argv[1]}; one of ${company.personas.map((p) => p.key).join(", ")}`,
    );

  const sql = openOwner(env);
  try {
    const orgId = await findLabOrg(sql, company.key);
    if (!orgId)
      throw new Error(
        `${company.nameEn} is not provisioned in the test project — run npm run lab:seed first`,
      );
    const email = personaEmail(company.key, persona.key);
    const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token)
      throw link.error ?? new Error("could not mint a sign-in link");
    const url =
      `${BASE}/auth/confirm?token_hash=${encodeURIComponent(link.data.properties.hashed_token)}` +
      `&type=magiclink&next=${encodeURIComponent(`/o/${orgId}`)}`;

    console.log(`\nPilot Lab — test project ${env.ref}`);
    console.log(`Company : ${company.nameEn} · ${company.nameAr}`);
    console.log(`Persona : ${persona.fullName} — ${persona.describes}`);
    console.log(`Role    : ${persona.roleKey}   Locale: ${persona.locale}`);
    console.log(`Org     : ${orgId}`);

    if (!NO_SERVER) await startServer();
    console.log(`\nOne-time sign-in link (dies on first use, ~1 hour):\n  ${url}\n`);
    if (!NO_BROWSER) {
      const cmd =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd);
      console.log("opened in your browser.");
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
