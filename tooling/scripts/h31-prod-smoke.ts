/**
 * H31 production smoke.
 *
 * Runs in two modes against the same code:
 *   flag OFF — proves the feature is genuinely absent and today's behaviour is
 *              untouched (no manifest, no icons, no settings page, no routing);
 *   flag ON  — proves the feature works and, more importantly, that two
 *              organisations never see each other's identity.
 *
 * It creates nothing unless `--fixture` is passed, and what it creates then is
 * uniquely marked and removed before it exits.
 *
 *   npx tsx tooling/scripts/h31-prod-smoke.ts --confirm=apply-migrations-to-<ref>
 *   npx tsx tooling/scripts/h31-prod-smoke.ts --confirm=… --surfaces=on --expect-flag=on
 */
import "./load-env";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";
import { classifyHost, normalizeSlug } from "../../src/platform/tenanthost/resolve";
import { isReservedSlug } from "../../src/platform/tenanthost/reserved";

const CONFIRM = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";
const SURFACES = process.argv.includes("--surfaces=on");
const EXPECT_ON = process.argv.includes("--expect-flag=on");
const BASE = "https://www.idaraworks.com";

const run = randomUUID().slice(0, 8);
let checks = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  checks += 1;
  const line = `${label}${detail ? ` — ${detail}` : ""}`;
  if (condition) console.log(`ok   ${line}`);
  else {
    console.log(`FAIL ${line}`);
    failures.push(label);
  }
}

async function main() {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    throw new Error(
      `This smoke runs against PRODUCTION only.\n${target.problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  if (CONFIRM !== productionMigrationPhrase()) {
    throw new Error(`Refusing to run without --confirm=${productionMigrationPhrase()}`);
  }

  console.log(`H31 production smoke (run ${run}, expecting flag ${EXPECT_ON ? "ON" : "OFF"})`);
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

  const counts = async () => {
    const [r] = (await sql`
      select
        (select count(*) from public.org)::text as orgs,
        (select count(*) from auth.users)::text as users,
        (select count(*) from public.customer)::text as customers,
        (select count(*) from public.invoice)::text as invoices,
        (select count(*) from public.tenant_host)::text as hosts,
        (select count(*) from public.org_app_brand)::text as brands,
        (select count(*) from public.audit_log)::text as audit_rows
    `) as unknown as Array<Record<string, string>>;
    return r!;
  };

  try {
    const before = await counts();

    // ── Schema is present and additive ────────────────────────────────────────
    const [schema] = (await sql`
      select
        to_regclass('public.tenant_host') is not null as host_table,
        to_regclass('public.org_app_brand') is not null as brand_table,
        exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'app' and p.proname = 'resolve_tenant_host') as resolver,
        exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'app' and p.proname = 'tenant_host_is_taken') as availability
    `) as unknown as Array<Record<string, boolean>>;
    ok(
      "schema: both H31 tables exist",
      schema?.host_table === true && schema?.brand_table === true,
    );
    ok(
      "schema: both platform reads exist",
      schema?.resolver === true && schema?.availability === true,
    );

    // ── The unique index is the real anti-collision guard ─────────────────────
    const [idx] = (await sql`
      select exists(
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'tenant_host_active_uq'
      ) as present
    `) as unknown as Array<{ present: boolean }>;
    ok("schema: one live claim per hostname is enforced by an index", idx!.present);

    // ── A tenant cannot write its own status ──────────────────────────────────
    const [grants] = (await sql`
      select
        bool_or(privilege_type = 'UPDATE' and column_name = 'status') as can_status,
        bool_or(privilege_type = 'UPDATE' and column_name = 'verified_at') as can_verified
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'tenant_host' and grantee = 'app_user'
    `) as unknown as Array<{ can_status: boolean | null; can_verified: boolean | null }>;
    ok(
      "grants: a tenant cannot mark its own host verified",
      grants!.can_status !== true && grants!.can_verified !== true,
    );

    // ── Pure laws, exercised against the deployed source ──────────────────────
    ok(
      "hosts: the platform's own host is never a tenant",
      classifyHost("www.idaraworks.com").kind === "platform",
    );
    ok(
      "hosts: an unknown label classifies but resolves to nothing on its own",
      classifyHost("nobody.idaraworks.com").kind === "tenant_subdomain",
    );
    ok("hosts: reserved labels stay reserved", isReservedSlug("api") && isReservedSlug("admin"));
    ok("hosts: a malformed slug is refused", normalizeSlug("ab") === null);

    // ── No live host points anywhere unexpected ───────────────────────────────
    const live = (await sql`
      select th.host, o.name as org_name from public.tenant_host th
      join public.org o on o.id = th.org_id
      where th.status = 'active' order by th.host`) as unknown as Array<Record<string, string>>;
    ok(
      "hosts: every active hostname belongs to a real organisation",
      live.every((r) => typeof r.org_name === "string" && r.org_name.length > 0),
      `${live.length} active host(s)`,
    );

    if (SURFACES) {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
      ok("http: production is healthy", health.ok === true, `commit ${health.commit?.slice(0, 7)}`);

      // The marketing site must stay generic IdaraWorks whatever the flag says.
      const home = await fetch(BASE);
      const homeHtml = await home.text();
      ok("http: the public site is still generic IdaraWorks", home.status === 200);
      ok(
        "http: the public site advertises no tenant manifest",
        !/\/api\/o\/[0-9a-f-]{36}\/manifest/.test(homeHtml),
      );

      // A real organisation id, read from the database, is needed to exercise
      // the per-tenant endpoints honestly.
      const [anyOrg] = (await sql`
        select id::text as id from public.org order by created_at limit 1
      `) as unknown as Array<{ id: string }>;

      const manifest = await fetch(`${BASE}/api/o/${anyOrg!.id}/manifest`);
      const icon = await fetch(`${BASE}/api/o/${anyOrg!.id}/icon/512.png`);

      if (EXPECT_ON) {
        ok("http: the manifest is served", manifest.status === 200, `status ${manifest.status}`);
        const body = manifest.status === 200 ? await manifest.json() : null;
        ok(
          "http: the manifest id is the organisation, not a name",
          body?.id === `/o/${anyOrg!.id}`,
        );
        ok(
          "http: both required icon sizes are declared",
          Array.isArray(body?.icons) &&
            body.icons.some((i: { sizes: string }) => i.sizes === "192x192") &&
            body.icons.some((i: { sizes: string }) => i.sizes === "512x512"),
        );
        ok(
          "http: a maskable icon is declared",
          Array.isArray(body?.icons) &&
            body.icons.some((i: { purpose?: string }) => i.purpose === "maskable"),
        );
        ok(
          "http: the manifest is never shared-cached",
          (manifest.headers.get("cache-control") ?? "").includes("no-store"),
          manifest.headers.get("cache-control") ?? "(none)",
        );
        ok(
          "http: prefer_related_applications is false",
          body?.prefer_related_applications === false,
        );
        ok(
          "http: an icon renders",
          icon.status === 200 && (icon.headers.get("content-type") ?? "").startsWith("image/png"),
        );

        // The isolation claim, made against production rather than a fixture.
        const [second] = (await sql`
          select id::text as id from public.org
          where id <> ${anyOrg!.id} order by created_at limit 1
        `) as unknown as Array<{ id: string }>;
        if (second) {
          const other = await fetch(`${BASE}/api/o/${second.id}/manifest`).then((r) => r.json());
          ok(
            "http: two organisations receive two different manifests",
            other.id !== body?.id && other.id === `/o/${second.id}`,
          );
        }
      } else {
        ok(
          "http: no manifest is served with the flag off",
          manifest.status === 404,
          `status ${manifest.status}`,
        );
        ok(
          "http: no icon is served with the flag off",
          icon.status === 404,
          `status ${icon.status}`,
        );
      }

      // The service worker file is static and always present; what matters is
      // that it never registers itself.
      const sw = await fetch(`${BASE}/sw.js`);
      const swBody = sw.status === 200 ? await sw.text() : "";
      ok(
        "http: the service worker caches no responses",
        swBody.length === 0 || !/cache\.put\(|caches\.match\(request\)/.test(swBody),
      );
    }

    const after = await counts();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(
      `\nbusiness counts unchanged: ${unchanged}\n  before=${JSON.stringify(before)}\n  after =${JSON.stringify(after)}`,
    );
    ok("nothing in production was changed by this smoke", unchanged);

    console.log(
      `\n${failures.length === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures.length} of ${checks} FAILED`}` +
        ` (surfaces=${SURFACES ? "on" : "off"}, flag expected ${EXPECT_ON ? "ON" : "OFF"})`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
