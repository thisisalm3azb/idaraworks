/**
 * Print a one-time sign-in link for the Studio UI fixture owner on the TEST
 * project, so a browser session can be established without anyone typing a
 * password. Uses the auth admin API (service role) — TEST project only.
 *
 *   npx tsx tooling/scripts/h25-ui-login-link.ts <email> [redirectTo]
 */
import "./load-env-integration";

if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

async function main(): Promise<void> {
  const email = process.argv[2];
  const redirectTo = process.argv[3] ?? "http://localhost:3212/";
  if (!email) {
    console.error("usage: h25-ui-login-link.ts <email> [redirectTo]");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !data) throw new Error(`generateLink: ${error?.message}`);
  const p = data.properties;
  console.log("action_link:", p.action_link);
  console.log("hashed_token:", p.hashed_token);
  console.log("verification_type:", p.verification_type);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
