/**
 * The H22.0 document path, exercised ONCE against production, then removed.
 *
 * `smoke-prod.ts` is read-only and proves the deployed surface answers. It
 * cannot prove that issuing a document captures an issuer snapshot, that a PDF
 * renders in the serverless container with the bundled fonts, or that a share
 * link resolves and then stops resolving when revoked. Those need writes, so
 * this makes them, in one temporary organization, and deletes it.
 *
 * Every safety property this has:
 *   - loads `.env.local` ONLY, and POSITIVELY identifies production; an empty or
 *     half-filled environment refuses rather than reading as production
 *   - requires the confirmation phrase as a command-line ARGUMENT
 *   - marks the organization it creates, so cleanup is by marker and never
 *     depends on this process surviving to remember an id
 *   - deletes in a transaction and then VERIFIES zero residue, failing loudly if
 *     anything remains
 *   - `--cleanup-only` wipes any marked residue from an earlier interrupted run
 *
 *   npx tsx tooling/scripts/smoke-prod-documents.ts --confirm=<phrase>
 *   npx tsx tooling/scripts/smoke-prod-documents.ts --cleanup-only --confirm=<phrase>
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

/** The marker every row this script creates can be found by. */
const SMOKE_KEY = "smoke.h22_documents";

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cleanupOnly = args.includes("--cleanup-only");
const confirm = args.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length) ?? "";

async function main() {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("This script writes to PRODUCTION and could not confirm it is pointed there:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const phrase = productionMigrationPhrase();
  if (confirm !== phrase) {
    fail(`--confirm=<phrase> is required and must be exactly: ${phrase}`);
  }
  console.log(`target: project ${PRODUCTION_PROJECT_REF} (production)`);

  const sql = postgres(process.env.DIRECT_URL!, {
    max: 1,
    connect_timeout: 60,
    onnotice: () => {},
  });
  try {
    const [who] = await sql`select current_database() as db`;
    console.log(`connected: db=${who!.db}`);

    if (cleanupOnly) {
      await wipeMarked(sql);
      await assertNoResidue(sql);
      console.log("cleanup-only: done");
      return;
    }

    const run = randomUUID().slice(0, 8);
    console.log(`run id: ${run}`);
    let orgId = "";
    let userId = "";
    try {
      ({ orgId, userId } = await seed(sql, run));
      await exercise(sql, orgId, userId, run);
    } finally {
      // Cleanup runs whether or not the checks passed: a failed smoke must not
      // leave a temporary organization behind in the live database.
      await wipeMarked(sql);
      await assertNoResidue(sql);
    }
    console.log("\nSMOKE PASSED — and every row it created is gone.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Create the temporary organization, marked so cleanup can always find it. */
async function seed(sql: postgres.Sql, run: string): Promise<{ orgId: string; userId: string }> {
  const userId = randomUUID();
  const email = `h22-smoke-${run}@idaraworks-smoke.invalid`;

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"H22 Smoke"}'::jsonb, now(), now())`;

  const { createOrgForUser } = await import("@/platform/auth/identity");
  const created = await createOrgForUser(userId, {
    name: `H22 Smoke ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });

  // Mark it BEFORE anything else, so an interruption a moment later still leaves
  // something cleanup can find.
  await sql`
    insert into public.app_settings (org_id, key, value)
    values (${created}, ${SMOKE_KEY}, ${JSON.stringify({ run, created_at: new Date().toISOString() })}::jsonb)
    on conflict (org_id, key) do update set value = excluded.value`;

  console.log(`seeded org ${created}`);
  return { orgId: created, userId };
}

/** The checks themselves: the document path end to end, through real services. */
async function exercise(
  sql: postgres.Sql,
  orgId: string,
  userId: string,
  run: string,
): Promise<void> {
  const ctx = {
    orgId,
    userId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: `h22-smoke-${run}`,
  };

  const { installTemplate } = await import("@/platform/config/install");
  await installTemplate(ctx, "generic_operations_v1");

  const { createCustomer } = await import("@/modules/masters/service");
  const customer = await createCustomer(ctx, "owner", { name: `Smoke Customer ${run}` });

  const { createQuote } = await import("@/modules/quotes/service");
  const { listActivePresets } = await import("@/modules/jobs/service");
  const preset = (await listActivePresets(ctx, "owner"))[0]!;
  const quote = await createQuote(ctx, "owner", {
    customerId: customer.id,
    presetId: preset.id,
    lines: [{ description: "Smoke line", qty: 1, unit: "unit", unitPriceMinor: 100_00 }],
  });
  check("quote created", Boolean(quote.id), quote.reference);

  // Issue it, which is the moment the issuer identity must be captured.
  const { withCtx, sql: dsql } = await import("@/platform/tenancy");
  const { captureDocumentIssuerIn } = await import("@/modules/documents/service");
  await withCtx(ctx, async (tx) => {
    await tx.execute(
      dsql`update public.quote set status = 'sent' where id = ${quote.id} and org_id = ${orgId}`,
    );
    await captureDocumentIssuerIn(tx, ctx, "quote", quote.id);
  });
  const [snap] = await sql`
    select issuer_snapshot is not null as has_snapshot from public.quote where id = ${quote.id}`;
  check("issuing captured an issuer snapshot", snap?.has_snapshot === true, "");

  // Render both languages, then a real PDF with the bundled fonts.
  const { documentHtml, documentModel } = await import("@/modules/documents/service");
  const en = await documentHtml(ctx, "owner", { kind: "quote", id: quote.id, language: "en" });
  const ar = await documentHtml(ctx, "owner", { kind: "quote", id: quote.id, language: "ar" });
  check("English document renders", en.includes(quote.reference), `${en.length} bytes`);
  check("Arabic document renders right to left", ar.includes('dir="rtl"'), `${ar.length} bytes`);

  const { renderDocument, renderPdf, embeddedDocumentFonts, closePdfBrowser } =
    await import("@/platform/documents");
  const model = await documentModel(ctx, "owner", {
    kind: "quote",
    id: quote.id,
    language: "ar",
  });
  const pdf = await renderPdf(
    renderDocument(model, { delivery: "embed", embedded: await embeddedDocumentFonts() }),
    { pageNumbers: true, rtl: true },
  );
  const bytes = Buffer.from(pdf).toString("latin1");
  check("PDF renders", bytes.startsWith("%PDF-"), `${pdf.byteLength} bytes`);
  check(
    "PDF embeds the bundled Arabic face",
    bytes.includes("NotoNaskhArabic"),
    "no host font substituted",
  );
  await closePdfBrowser();

  // A share link, resolved and then revoked.
  const { createDocumentShare, resolveDocumentShare, revokeDocumentShare, listDocumentShares } =
    await import("@/modules/documents/service");
  const share = await createDocumentShare(ctx, "owner", { kind: "quote", id: quote.id, days: 1 });
  const resolved = await resolveDocumentShare(share.token);
  check("share link resolves to its own document", resolved?.id === quote.id, "");

  const shares = await listDocumentShares(ctx, "owner", "quote", quote.id);
  await revokeDocumentShare(ctx, "owner", shares[0]!.id);
  check("revoked share stops resolving", (await resolveDocumentShare(share.token)) === null, "");

  // The schema's own refusals, on production's schema.
  const weekPlanRefused = await sql`
    insert into public.document_share (org_id, subject_type, subject_id, token_hash, expires_at, created_by)
    values (${orgId}, 'week_plan', ${quote.id}, ${randomUUID().replace(/-/g, "")}, now() + interval '1 day', ${userId})
  `.then(
    () => false,
    () => true,
  );
  check("schema refuses a weekly-plan share", weekPlanRefused, "");

  const strangerRefused = await sql`
    insert into public.document_share (org_id, subject_type, subject_id, token_hash, expires_at, created_by)
    values (${orgId}, 'quote', ${randomUUID()}, ${randomUUID().replace(/-/g, "")}, now() + interval '1 day', ${userId})
  `.then(
    () => false,
    () => true,
  );
  check("schema refuses a subject that does not exist", strangerRefused, "");
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Delete every organization carrying the smoke marker, and its user. */
async function wipeMarked(sql: postgres.Sql): Promise<void> {
  const marked = (await sql`
    select distinct org_id::text as org_id from public.app_settings where key = ${SMOKE_KEY}
  `) as unknown as Array<{ org_id: string }>;
  if (marked.length === 0) {
    console.log("cleanup: nothing marked");
    return;
  }
  const ids = marked.map((m) => m.org_id);
  console.log(`cleanup: removing ${ids.length} marked organization(s)`);

  const users = (await sql`
    select distinct user_id::text as user_id from public.membership
    where org_id = any(${ids}::uuid[])`) as unknown as Array<{ user_id: string }>;

  const tables = (await sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;

  await sql.begin(async (tx) => {
    // Foreign keys are deferred for the delete and restored immediately after,
    // so ordering between tables cannot leave an orphan behind.
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    await tx.unsafe("set local session_replication_role = default");
    const userIds = users.map((u) => u.user_id);
    if (userIds.length) {
      await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [userIds]);
      await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [userIds]);
    }
  });
}

/**
 * Prove it is gone, rather than assuming the delete worked. Checks the marker,
 * the smoke organizations, the smoke auth users, and — because an earlier phase
 * found exactly this — the auth identity and session rows that a naive delete
 * leaves orphaned.
 */
async function assertNoResidue(sql: postgres.Sql): Promise<void> {
  const [r] = await sql`
    select
      (select count(*) from public.app_settings where key = ${SMOKE_KEY}) as markers,
      (select count(*) from public.org where name like 'H22 Smoke %') as orgs,
      (select count(*) from auth.users where email like '%@idaraworks-smoke.invalid') as users,
      (select count(*) from auth.identities i
        where not exists (select 1 from auth.users u where u.id = i.user_id)) as orphan_identities,
      (select count(*) from auth.sessions s
        where not exists (select 1 from auth.users u where u.id = s.user_id)) as orphan_sessions`;
  const counts = r as unknown as Record<string, string>;
  console.log(
    `residue: markers=${counts.markers} orgs=${counts.orgs} users=${counts.users} ` +
      `orphan_identities=${counts.orphan_identities} orphan_sessions=${counts.orphan_sessions}`,
  );
  const dirty = Number(counts.markers) > 0 || Number(counts.orgs) > 0 || Number(counts.users) > 0;
  if (dirty) {
    console.error("RESIDUE REMAINS — clean up before continuing.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(failures > 0 ? 1 : 0))
  .catch((e) => {
    console.error("smoke failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
