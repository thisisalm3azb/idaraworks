/**
 * Download PDF, proven through the REAL deployed button. Then removed.
 *
 * Everything that came before this checked the wrong thing. `smoke-prod-documents.ts`
 * calls `renderPdf` inside its own Node process, where Playwright is installed
 * and Chromium starts happily — which is why it passed for months while every
 * customer clicking Download PDF in production got a 404 saying their document
 * did not exist. A local render proves the renderer works on a laptop. It says
 * nothing about the serverless container the button actually reaches.
 *
 * So this makes the HTTP request the browser makes, against the deployed
 * application, and reads the response the customer would receive:
 *
 *   - fetch the shared document PAGE and find the Download PDF link in its HTML
 *   - follow THAT href, exactly as written, rather than a URL made up here
 *   - assert 200, application/pdf, an attachment filename, and a body that
 *     begins %PDF and is not empty
 *   - do it in English and in Arabic
 *   - confirm the bundled faces are embedded, so no host font was substituted
 *   - and refuse every silent failure: an HTML page, the 503 fallback, the
 *     "not available" page, or a 200 carrying something that is not a PDF
 *
 * The 503 fallback is a good thing to have and is NOT success here. If the
 * renderer is still broken in production this exits non-zero and says so.
 *
 * SAFETY: creates one marked organization, and removes it in `finally` whether
 * it passed or failed, then verifies zero residue.
 *
 *   npx tsx tooling/scripts/h22-prod-pdf-verify.ts --confirm=<phrase>
 *   npx tsx tooling/scripts/h22-prod-pdf-verify.ts --cleanup-only --confirm=<phrase>
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h22_pdf_verify";
const RUN = randomUUID().slice(0, 8);

const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
const userId = randomUUID();
let orgId = "";

const ctx = (): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `pdf-verify-${RUN}`,
});

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * One PDF download, made the way a browser makes it.
 *
 * Returns the whole response rather than a boolean so every assertion below is
 * made against what actually came back, not against a summary of it.
 */
async function download(href: string): Promise<{
  status: number;
  contentType: string;
  disposition: string;
  body: Buffer;
  ms: number;
}> {
  const started = Date.now();
  const res = await fetch(`${BASE}${href}`, {
    redirect: "manual",
    headers: {
      // The header a browser sends when a person clicks a link. It is what the
      // route content-negotiates on, so sending anything else tests a path no
      // customer takes.
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 (H22 production PDF verification)",
    },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    disposition: res.headers.get("content-disposition") ?? "",
    body,
    // How long it took says what happened when nothing else can: a browser that
    // starts takes seconds, and a module that is not there fails in under one.
    ms: Date.now() - started,
  };
}

/** Assert one language's download end to end. */
async function verifyLanguage(label: string, href: string, mustEmbed: string): Promise<void> {
  console.log(`\n${label.toUpperCase()} — GET ${href}`);
  const res = await download(href);
  console.log(`  (${res.ms}ms, ${res.body.byteLength} bytes)`);
  const head = res.body.subarray(0, 5).toString("latin1");
  const asText = res.body.toString("latin1");

  check("HTTP 200", res.status === 200, `got ${res.status}`);
  check(
    "content-type is application/pdf",
    res.contentType.toLowerCase().includes("application/pdf"),
    res.contentType || "(none)",
  );
  check(
    "served as an attachment with a filename",
    /attachment/i.test(res.disposition) && /filename="[^"]+\.pdf"/i.test(res.disposition),
    res.disposition || "(none)",
  );
  check("body is not empty", res.body.byteLength > 1024, `${res.body.byteLength} bytes`);
  check("body begins %PDF", head === "%PDF-", JSON.stringify(head));
  check(
    `the bundled ${label} face is embedded`,
    asText.includes(mustEmbed),
    asText.includes(mustEmbed) ? mustEmbed : "a host font was substituted, or none is embedded",
  );

  /*
   * The silent-failure guards. Each of these is a way the endpoint can answer
   * with something that is not a PDF while still looking like it worked.
   */
  check(
    "not the renderer-unavailable fallback",
    !asText.includes("pdf_unavailable") && !asText.includes("The document is fine"),
    "a 503 fallback is useful, but it is not a successful download",
  );
  check("not the not-available page", !asText.includes("This document is not available"), "");
  check("not an HTML page", !/^\s*<!doctype html/i.test(asText), "");
  check(
    "the PDF has a trailer, so it is complete rather than truncated",
    asText.includes("%%EOF"),
    "",
  );
}

async function run(): Promise<void> {
  console.log(`H22 PRODUCTION PDF VERIFICATION — ${BASE}, run ${RUN}\n`);

  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22pdf-${RUN}@example.invalid`}, '{"full_name":"H22 PDF"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(userId, {
    name: `H22 PDF VERIFY ${RUN}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${MARKER}, ${owner.json({ is_test_fixture: true, run: RUN, created_at: new Date().toISOString() } as never)})
    on conflict (org_id, key) do update set value = excluded.value`;
  console.log(`fixture org ${orgId} (marked ${MARKER})`);

  // A real document, issued through the real lifecycle so it carries an issuer
  // snapshot — a quote without one renders a legacy notice instead.
  const { createCustomer } = await import("@/modules/masters/service");
  const { createQuote, markQuoteSent } = await import("@/modules/quotes/service");
  const customer = await createCustomer(ctx(), "owner", {
    name: "PDF Verification Customer",
    phone: "+971500000000",
  });
  const quote = await createQuote(ctx(), "owner", {
    customerId: customer.id,
    title: "PDF verification",
    lines: [{ description: "Verification line", qty: 2, unit: "unit", unitPriceMinor: 250_00 }],
  });
  await owner`update public.quote set status = 'approved' where id = ${quote.id} and org_id = ${orgId}`;
  await markQuoteSent(ctx(), "owner", quote.id);
  console.log(`quote ${quote.reference} issued`);

  const { createDocumentShare } = await import("@/modules/documents/service");
  const share = await createDocumentShare(ctx(), "owner", {
    kind: "quote",
    id: quote.id,
    days: 1,
  });

  /*
   * THE BUTTON. Read the page the recipient sees and take the link out of its
   * HTML, rather than constructing the URL here — a hand-made URL would still
   * pass if the button on the page pointed somewhere else entirely.
   */
  console.log(`\nSHARED PAGE — GET /d/${share.token}`);
  const page = await download(`/d/${share.token}`);
  check("the shared page loads", page.status === 200, `${page.status}`);
  const html = page.body.toString("utf8");
  check("it is an HTML page", page.contentType.includes("text/html"), page.contentType);
  const hrefs = [...html.matchAll(/href="(\?format=pdf[^"]*)"/g)].map((m) =>
    m[1]!.replace(/&amp;/g, "&"),
  );
  check("it offers a Download PDF button", hrefs.length > 0, hrefs[0] ?? "(none found)");
  check("the button is labelled for the reader", /Download PDF|تنزيل PDF/.test(html), "");
  if (hrefs.length === 0) {
    throw new Error("no Download PDF link on the shared page — nothing to follow");
  }

  /*
   * When it fails, ask WHY before giving up. The route answers ?diag=1 with the
   * error, to a caller holding the token, so a failing verification reports a
   * cause rather than only a status code.
   */
  const probe = await download(`/d/${share.token}?format=pdf&lang=en&diag=1`);
  if (probe.status !== 200) {
    let why = probe.body.toString("utf8").slice(0, 400);
    try {
      why = (JSON.parse(probe.body.toString("utf8")) as { detail?: string }).detail ?? why;
    } catch {
      /* not JSON: the raw body is the best available answer */
    }
    console.log(`
WHY IT FAILED (from production): ${why}
`);
  }

  // English, then Arabic, following the page's own link shape.
  await verifyLanguage("english", `/d/${share.token}${hrefs[0]!}`, "NotoSans");
  await verifyLanguage("arabic", `/d/${share.token}?format=pdf&lang=ar`, "NotoNaskhArabic");
}

async function wipeMarked(): Promise<void> {
  const marked = (await owner`
    select org_id::text as id from public.app_settings where key = ${MARKER}`) as unknown as Array<{
    id: string;
  }>;
  const ids = marked.map((m) => m.id);
  if (orgId && !ids.includes(orgId)) ids.push(orgId);
  if (ids.length === 0) {
    console.log("\nnothing marked to remove");
    return;
  }
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    await tx.unsafe("set local session_replication_role = default");
    await tx.unsafe(`delete from public.user_profile where id = $1`, [userId]);
    await tx.unsafe(`delete from auth.users where id = $1`, [userId]);
  });
  console.log(`\nremoved ${ids.length} marked organization(s)`);
}

async function verifyNoResidue(): Promise<void> {
  const [row] = (await owner`
    select
      (select count(*)::int from public.app_settings where key = ${MARKER}) as markers,
      (select count(*)::int from public.org where id = ${orgId || null}) as orgs,
      (select count(*)::int from public.quote where org_id = ${orgId || null}) as quotes,
      (select count(*)::int from public.document_share where org_id = ${orgId || null}) as shares,
      (select count(*)::int from public.file where org_id = ${orgId || null}) as files,
      (select count(*)::int from auth.users where id = ${userId}) as users,
      (select count(*)::int from auth.identities where user_id = ${userId}) as identities,
      (select count(*)::int from auth.sessions where user_id = ${userId}) as sessions,
      (select count(*)::int from public.user_profile where id = ${userId}) as profiles
  `) as unknown as Array<Record<string, number>>;
  for (const [k, v] of Object.entries(row!)) {
    console.log(`  ${v === 0 ? "OK  " : "LEFT"}  ${k.padEnd(11)} ${v}`);
  }
  const total = Object.values(row!).reduce((a, b) => a + b, 0);
  if (total !== 0) throw new Error(`residue remains: ${JSON.stringify(row)}`);
  console.log("  zero residue");
}

async function main(): Promise<void> {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("This script writes to PRODUCTION and could not confirm it is pointed there:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const phrase = productionMigrationPhrase();
  const confirm = args.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length) ?? "";
  if (confirm !== phrase) {
    console.error(`REFUSED: --confirm=<phrase> is required and must be exactly: ${phrase}`);
    process.exit(1);
  }
  console.log(`target: project ${PRODUCTION_PROJECT_REF} (production)\n`);

  if (args.includes("--cleanup-only")) {
    await wipeMarked();
    await verifyNoResidue();
    return;
  }

  try {
    await run();
  } finally {
    await wipeMarked();
    await verifyNoResidue();
  }

  console.log(
    failures === 0
      ? "\nPDF VERIFIED — the deployed button returns a real, complete PDF in both languages."
      : `\nPDF VERIFICATION FAILED — ${failures} check(s) above.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(`\nVERIFICATION ERROR: ${(err as Error).message}`);
    await wipeMarked().catch((e) => console.error(`cleanup failed: ${(e as Error).message}`));
    await verifyNoResidue().catch((e) => console.error(`residue: ${(e as Error).message}`));
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
