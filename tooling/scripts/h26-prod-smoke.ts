/**
 * H26 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * Proof that the Document Studio works on the real database and the real
 * deployed application, through the same module functions the screens call
 * plus the REAL HTTP routes. Every step asserts a property that would be
 * expensive to get wrong; the fixture self-destructs pass or fail.
 *
 * What it walks:
 *   1. a service agreement from a built-in template: variables, review,
 *      issue → one immutable snapshot, retention stamped, chain verified
 *   2. a signature room: the owner signs in-app, the counterparty through a
 *      one-time link (resolved the way the public page does); activation;
 *      the used token is dead; evidence hashes in the chain
 *   3. obligations: the renewal decision seeded from the expiry, an overdue
 *      payment completed with evidence, recurrence spawns the next item
 *   4. a governed workflow (value gate): submission opens approval steps in
 *      the shared engine; decisions complete the run; issue is then allowed
 *   5. a form: issued intake form, public link, a validated submission landing
 *      in quarantine, conversion into a customer by a person
 *   6. the assistant fails closed with the owner action; a viewer cannot
 *      create; another organisation sees nothing
 *   7. HTTP with the flag OFF: /documents, /sign/<t>, /f/<t> and the PDF
 *      route all answer not-found. With --surfaces=on: the hub renders, the
 *      PDF route streams real bytes whose header hash equals the stored
 *      snapshot hash, the public form renders, the dead sign link says so.
 *
 * SAFETY: creates one marked organization and one user; touches nothing
 * else; cleanup runs in `finally`; residue and historical counts verified.
 *
 *   npx tsx tooling/scripts/h26-prod-smoke.ts --confirm=<production phrase> [--surfaces=on]
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { ForbiddenError } from "@/platform/authz";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { decideApproval } from "@/modules/approvals/service";
import { getCustomer } from "@/modules/masters/service";
import {
  aiAvailability,
  completeObligation,
  convertSubmission,
  createDocument,
  createFormLink,
  createObligation,
  createSignatureRequest,
  createWorkflow,
  getDocument,
  getRunForDocument,
  getSignatureRequest,
  issueDocument,
  listDocuments,
  listMySteps,
  listObligations,
  listSubmissions,
  resolveFormToken,
  resolveSignerToken,
  saveRevision,
  signAsMember,
  signWithToken,
  submitForm,
  submitForReview,
  WORKFLOW_PRESETS,
} from "@/modules/docstudio/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h26";
const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerPassword = `Smoke-${randomUUID()}`;
const ownerEmail = `h26smoke-${RUN}@example.invalid`;
const INFO = { ip: "203.0.113.26", userAgent: "h26-prod-smoke" };
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h26-smoke-${RUN}`,
});
let checks = 0;
function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) throw new Error(`FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok: ${what}${detail ? ` (${detail})` : ""}`);
}
const plus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function cleanup(): Promise<void> {
  if (!orgId) return;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    }
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    if (ownerUserId) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.refresh_tokens where user_id = $1::text`, [ownerUserId]);
      await tx.unsafe(`delete from auth.sessions where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.identities where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.users where id = $1`, [ownerUserId]);
    }
  });
  const residue = (await owner`
    select
      (select count(*) from public.org where id = ${orgId}) +
      (select count(*) from public.app_settings where org_id = ${orgId}) +
      (select count(*) from public.doc_document where org_id = ${orgId}) +
      (select count(*) from public.doc_snapshot where org_id = ${orgId}) +
      (select count(*) from public.doc_event where org_id = ${orgId}) +
      (select count(*) from public.doc_signer where org_id = ${orgId}) +
      (select count(*) from public.doc_obligation where org_id = ${orgId}) +
      (select count(*) from public.doc_form_submission where org_id = ${orgId}) +
      (select count(*) from public.approval where org_id = ${orgId}) +
      (select count(*) from public.notification where org_id = ${orgId}) +
      (select count(*) from storage.objects where name like ${orgId + "/%"}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.identities where user_id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.sessions where user_id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

/** Sign the owner in against the deployed Supabase and build the SSR cookie. */
async function ownerCookie(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await anon.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (error || !data.session) throw new Error(`owner sign-in failed: ${error?.message}`);
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(data.session), "utf8").toString("base64url");
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `sb-${ref}-auth-token=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) {
    parts.push(`sb-${ref}-auth-token.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  return parts.join("; ");
}

const COUNTS = () => owner`
  select (select count(*) from public.org) as orgs,
         (select count(*) from auth.users) as users,
         (select count(*) from public.doc_document) as documents,
         (select count(*) from public.doc_snapshot) as snapshots,
         (select count(*) from public.doc_event) as events,
         (select count(*) from public.doc_obligation) as obligations,
         (select count(*) from public.doc_form_submission) as submissions,
         (select count(*) from public.approval) as approvals,
         (select count(*) from public.job) as jobs,
         (select count(*) from public.invoice) as invoices`;

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  const surfaces = process.argv.includes("--surfaces=on") ? "on" : "off";
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing: the environment does not point only at production:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (confirmArg !== productionMigrationPhrase()) {
    console.error(`Refusing: pass --confirm=${productionMigrationPhrase()}`);
    process.exit(1);
  }
  console.log(
    `H26 production smoke on ${PRODUCTION_PROJECT_REF} (run ${RUN}, surfaces=${surfaces})`,
  );
  const before = (await COUNTS()) as unknown as Array<Record<string, string>>;
  console.log(`before: ${JSON.stringify(before[0])}`);

  try {
    // ── fixture ────────────────────────────────────────────────────────────
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const created = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { full_name: "H26 Smoke" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${ownerUserId}, 'H26 Smoke', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H26 smoke ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN, at: new Date().toISOString() })}::jsonb)
      on conflict (org_id, key) do update set value = excluded.value`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    console.log(`fixture org ${orgId}`);

    // ── 1. agreement: template → variables → review → issue ─────────────────
    const sa = await createDocument(A(), "owner", {
      title: `Smoke refit ${RUN}`,
      category: "agreement",
      language: "bilingual",
      builtinKey: "builtin.service_agreement",
      expiresAt: plus(400),
    });
    await saveRevision(A(), "owner", {
      documentId: sa.id,
      revisionId: sa.revisionId,
      variables: { payment_days: 30 },
    });
    await submitForReview(A(), "owner", { documentId: sa.id, note: "Smoke" });
    const issued = await issueDocument(A(), "owner", { documentId: sa.id });
    const saDetail = await getDocument(A(), "owner", sa.id);
    check(
      "issued once, awaiting signature",
      issued.status === "signature",
      saDetail.document.reference,
    );
    check("one immutable snapshot with a hash", saDetail.snapshot?.contentHash?.length === 64);
    check(
      "retention stamped at issue",
      saDetail.document.retentionUntil !== null,
      saDetail.document.retentionUntil ?? "",
    );
    check("evidence chain verifies", saDetail.chain.ok === true);
    let dup = false;
    try {
      await issueDocument(A(), "owner", { documentId: sa.id });
    } catch {
      dup = true;
    }
    check("a second issue is refused", dup);

    // ── 2. signature room ───────────────────────────────────────────────────
    const room = await createSignatureRequest(A(), "owner", {
      documentId: sa.id,
      mode: "parallel",
      signers: [
        {
          party: "company",
          kind: "member",
          userId: ownerUserId,
          name: "H26 Smoke",
          title: "Owner",
        },
        {
          party: "counterparty",
          kind: "external",
          name: "Maha Saleh",
          email: "maha@example.invalid",
        },
      ],
    });
    const link = room.invitations.find((i) => i.link)?.link ?? "";
    check("external signer got a one-time link", link.includes("/sign/"));
    const signToken = link.split("/sign/")[1]!;
    const req = await getSignatureRequest(A(), "owner", sa.id);
    const me = req!.signers.find((s) => s.partyKind === "member")!;
    await signAsMember(
      A(),
      "owner",
      {
        signerId: me.id,
        capture: { kind: "typed", data: "H26 Smoke", name: "H26 Smoke", consent: true },
      },
      INFO,
    );
    const resolved = await resolveSignerToken(signToken);
    check("the link resolves before use", resolved !== null);
    const done = await signWithToken(
      resolved!,
      { kind: "typed", data: "Maha Saleh", name: "Maha Saleh", consent: true },
      INFO,
    );
    check("the last signature completes the room", done.completed);
    check("the used link is dead", (await resolveSignerToken(signToken)) === null);
    const active = await getDocument(A(), "owner", sa.id);
    check("document active after signatures", active.document.effectiveStatus === "active");
    check(
      "signature evidence in the chain",
      active.events.filter((e) => e.kind === "signed").length === 2 && active.chain.ok === true,
    );

    // ── 3. obligations ──────────────────────────────────────────────────────
    const seeded = await listObligations(A(), "owner", { documentId: sa.id });
    check(
      "renewal decision seeded from the expiry",
      seeded.some((o) => o.kind === "renewal" && o.source === "issue"),
    );
    const pay = await createObligation(A(), "owner", {
      documentId: sa.id,
      kind: "payment",
      title: "Deposit invoice",
      dueOn: plus(-2),
      amountCents: 100000,
      currency: "AED",
      recurrenceMonths: 1,
    });
    check("overdue state computed on read", pay.dueState === "overdue");
    let gated = false;
    try {
      await completeObligation(A(), "owner", { id: pay.id, rowVersion: pay.rowVersion });
    } catch {
      gated = true;
    }
    check("completion is evidence-gated", gated);
    const completed = await completeObligation(A(), "owner", {
      id: pay.id,
      rowVersion: pay.rowVersion,
      note: "Paid, ref SMOKE-1",
    });
    check("recurrence spawned the next item", completed.nextId !== null);

    // ── 4. governed workflow ────────────────────────────────────────────────
    const preset = WORKFLOW_PRESETS.find((p) => p.key === "value_gate") ?? WORKFLOW_PRESETS[0]!;
    const wf = await createWorkflow(A(), "owner", {
      name: `Smoke gate ${RUN}`,
      definition: preset.definition,
    });
    const gatedDoc = await createDocument(A(), "owner", {
      title: `Smoke charter ${RUN}`,
      category: "agreement",
      language: "en",
      builtinKey: "builtin.service_agreement",
      workflowId: wf.id,
    });
    await saveRevision(A(), "owner", {
      documentId: gatedDoc.id,
      revisionId: gatedDoc.revisionId,
      variables: { payment_days: 30 },
    });
    await submitForReview(A(), "owner", { documentId: gatedDoc.id, note: "Smoke" });
    let run = await getRunForDocument(A(), "owner", gatedDoc.id);
    check("workflow run started on submission", run?.status === "running");
    for (let i = 0; i < 6 && run?.status === "running"; i++) {
      const mine = (await listMySteps(A(), "owner")).filter((s) => s.documentId === gatedDoc.id);
      for (const step of mine) {
        if (step.approvalId)
          await decideApproval(A(), "owner", { approvalId: step.approvalId, decision: "approved" });
      }
      run = await getRunForDocument(A(), "owner", gatedDoc.id);
      if (mine.length === 0) break;
    }
    check(
      "approval steps decided through the shared engine; run completed",
      run?.status === "completed",
    );
    const gatedIssued = await issueDocument(A(), "owner", { documentId: gatedDoc.id });
    check("issue allowed once the run completed", gatedIssued.snapshotId.length > 0);

    // ── 5. form ─────────────────────────────────────────────────────────────
    const form = await createDocument(A(), "owner", {
      title: `Smoke intake ${RUN}`,
      category: "form",
      language: "bilingual",
      builtinKey: "builtin.intake_form",
    });
    await issueDocument(A(), "owner", { documentId: form.id });
    const flink = await createFormLink(A(), "owner", {
      documentId: form.id,
      expiresInDays: 1,
      maxUses: 3,
    });
    const formToken = flink.url.split("/f/")[1]!;
    const fres = await resolveFormToken(formToken);
    check("form link resolves", fres !== null);
    const bad = await submitForm(fres!, formToken, { company_name: "" }, INFO);
    check("invalid answers are refused", "problems" in bad);
    const good = await submitForm(
      fres!,
      formToken,
      {
        company_name: `Smoke Trading ${RUN}`,
        contact_name: "Salma",
        email: "salma@example.invalid",
        phone: "+971500000000",
        customer_type: "1",
        consent: "on",
      },
      { ...INFO, name: "Salma", email: "salma@example.invalid" },
    );
    check("valid answers quarantined", "id" in good);
    const sub = (await listSubmissions(A(), "owner", { documentId: form.id }))[0]!;
    const conv = await convertSubmission(A(), "owner", {
      submissionId: sub.id,
      target: "customer",
      mapping: {
        name: "company_name",
        contactName: "contact_name",
        email: "email",
        phone: "phone",
      },
    });
    const cust = await getCustomer(A(), "owner", conv.recordId);
    check("a person converted the answers into a customer", cust?.name === `Smoke Trading ${RUN}`);

    // ── 6. fail-closed assistant, permissions, isolation ────────────────────
    const ai = await aiAvailability(A());
    check(
      "assistant fails closed with the owner action",
      !ai.available && (ai.ownerAction ?? "").length > 0,
    );
    let viewerRefused = false;
    try {
      await createDocument(A(), "viewer", { title: "nope", category: "letter", language: "en" });
    } catch (e) {
      viewerRefused = e instanceof ForbiddenError;
    }
    check("viewer cannot create", viewerRefused);
    const strangerOrg = (await owner`
      select id::text as id from public.org where id <> ${orgId} order by created_at asc limit 1`) as unknown as Array<{
      id: string;
    }>;
    if (strangerOrg[0]) {
      const stranger: Ctx = { ...A(), orgId: strangerOrg[0].id };
      const seen = await listDocuments(stranger, "owner", { search: `Smoke refit ${RUN}` });
      check("another organisation sees nothing", seen.rows.length === 0);
    }

    // ── 7. HTTP on the deployed application ─────────────────────────────────
    const cookie = await ownerCookie();
    const hub = await fetch(`${BASE}/o/${orgId}/documents`, {
      headers: { cookie },
      redirect: "manual",
    });
    const hubBody = await hub.text();
    const notFound = /not found|404|غير موجود/i.test(hubBody);
    const showsStudio =
      hubBody.includes("Document Studio") || hubBody.includes("استوديو المستندات");
    const pdfRes = await fetch(`${BASE}/api/o/${orgId}/documents/studio/${sa.id}?format=pdf`, {
      headers: { cookie },
      redirect: "manual",
    });
    const signRes = await fetch(`${BASE}/sign/${signToken}`, { redirect: "manual" });
    const formRes = await fetch(`${BASE}/f/${formToken}`, { redirect: "manual" });
    if (surfaces === "off") {
      check(
        "hub hidden while the flag is unset",
        (hub.status === 404 || (hub.status === 200 && notFound)) && !showsStudio,
        `${hub.status}`,
      );
      check("PDF route hidden while the flag is unset", pdfRes.status === 404, `${pdfRes.status}`);
      check(
        "public sign page hidden while the flag is unset",
        signRes.status === 404,
        `${signRes.status}`,
      );
      check(
        "public form page hidden while the flag is unset",
        formRes.status === 404,
        `${formRes.status}`,
      );
    } else {
      check("hub renders with the flag on", hub.status === 200 && showsStudio, `${hub.status}`);
      const bytes = Buffer.from(await pdfRes.arrayBuffer());
      const latin = bytes.toString("latin1");
      const pages = (latin.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      check(
        "PDF route streams real bytes from the snapshot",
        pdfRes.status === 200 &&
          (pdfRes.headers.get("content-type") ?? "").startsWith("application/pdf") &&
          latin.slice(0, 5) === "%PDF-" &&
          pages >= 2 &&
          latin.includes("NotoNaskhArabic"),
        `${pdfRes.status} ${bytes.length} bytes, ${pages} pages`,
      );
      check(
        "PDF hash header equals the stored snapshot hash",
        pdfRes.headers.get("x-document-hash") === saDetail.snapshot!.contentHash,
      );
      const formBody = await formRes.text();
      check(
        "public form renders",
        formRes.status === 200 && formBody.includes(`Smoke intake ${RUN}`),
        `${formRes.status}`,
      );
      const signBody = await signRes.text();
      check(
        "used sign link answers honestly",
        signRes.status === 200 && /not available|غير متاح/i.test(signBody),
        `${signRes.status}`,
      );
    }
    console.log(`\nALL ${checks} CHECKS PASSED (surfaces=${surfaces})`);
  } finally {
    await cleanup();
    const after = (await COUNTS()) as unknown as Array<Record<string, string>>;
    const same = JSON.stringify(before[0]) === JSON.stringify(after[0]);
    console.log(
      `historical counts intact: ${same} (before=${JSON.stringify(before[0])} after=${JSON.stringify(after[0])})`,
    );
    if (!same) process.exitCode = 1;
    await owner.end();
    await closeAppDb();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
