/**
 * H28 — grant, list or revoke IdaraWorks platform-operator access (ADR-55).
 *
 * The operator centre (/platform/ai) is gated by an active row in
 * `public.platform_operator`, which no application path can write: only this
 * script, through the OWNER connection, and only with an explicit confirm
 * phrase naming the target project. Nothing here touches business data.
 *
 *   npx tsx tooling/scripts/platform-operator.ts list
 *   npx tsx tooling/scripts/platform-operator.ts grant <email> --confirm=<phrase> [--note="..."]
 *   npx tsx tooling/scripts/platform-operator.ts revoke <email> --confirm=<phrase>
 *
 * The confirm phrase is `grant-platform-operator-<project ref>`.
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import postgres from "postgres";

function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return new URL(url).hostname.split(".")[0]!;
}

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2);
  const confirm = process.argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
  const note = process.argv.find((a) => a.startsWith("--note="))?.slice("--note=".length) ?? null;
  const ref = projectRef();
  const phrase = `grant-platform-operator-${ref}`;
  if (!command || !["list", "grant", "revoke"].includes(command)) {
    console.error(
      "usage: platform-operator.ts list | grant <email> --confirm=<phrase> | revoke <email> --confirm=<phrase>",
    );
    process.exitCode = 1;
    return;
  }
  const owner = postgres(process.env.DIRECT_URL!, { max: 1, prepare: false });
  try {
    if (command === "list") {
      const rows = await owner`
        select p.user_id::text as user_id, u.email, p.note, p.granted_at::text as granted_at, p.revoked_at::text as revoked_at
        from public.platform_operator p
        left join auth.users u on u.id = p.user_id
        order by p.granted_at desc`;
      console.log(`project ${ref}: ${rows.length} operator row(s)`);
      for (const r of rows) {
        console.log(
          ` ${r.revoked_at ? "revoked" : "active "} ${String(r.email ?? r.user_id)}${r.note ? ` (${r.note})` : ""} granted ${String(r.granted_at).slice(0, 19)}`,
        );
      }
      return;
    }
    if (!target) {
      console.error("an email is required");
      process.exitCode = 1;
      return;
    }
    if (confirm !== phrase) {
      console.error(`Refusing: pass --confirm=${phrase}`);
      process.exitCode = 1;
      return;
    }
    const users =
      await owner`select id::text as id from auth.users where lower(email) = lower(${target}) limit 1`;
    const userId = users[0]?.id as string | undefined;
    if (!userId) {
      console.error(`no user with email ${target} in project ${ref}`);
      process.exitCode = 1;
      return;
    }
    if (command === "grant") {
      await owner`insert into public.user_profile (id, full_name, locale) values (${userId}, ${target}, 'en') on conflict (id) do nothing`;
      await owner`
        insert into public.platform_operator (user_id, note, granted_at)
        values (${userId}, ${note}, now())
        on conflict (user_id) do update set revoked_at = null, note = excluded.note, granted_at = now()`;
      await owner`
        insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
        values (${userId}, 'platform_operator.grant', 'user', ${userId}, ${`granted by script on ${ref}${note ? `: ${note}` : ""}`})`;
      console.log(`granted platform operator to ${target} on ${ref}`);
      return;
    }
    await owner`update public.platform_operator set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
    await owner`
      insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
      values (${userId}, 'platform_operator.revoke', 'user', ${userId}, ${`revoked by script on ${ref}`})`;
    console.log(`revoked platform operator from ${target} on ${ref}`);
  } finally {
    await owner.end();
  }
}

await main();
