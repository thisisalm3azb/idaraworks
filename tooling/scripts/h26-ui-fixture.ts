/**
 * Seed one organization with documents worth LOOKING at in the Document
 * Studio (H26 counterpart of h25-ui-fixture.ts). TEST project only; leaves
 * the fixture in place to be browsed; `--wipe` removes it.
 *
 *   npx tsx tooling/scripts/h26-ui-fixture.ts          seed, print the sign-in
 *   npx tsx tooling/scripts/h26-ui-fixture.ts --wipe   remove it
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer, createEmployee, createSupplier } from "@/modules/masters/service";
import {
  createDocument,
  createFolder,
  getRevision,
  issueDocument,
  saveRevision,
  submitForReview,
  createWorkflow,
  WORKFLOW_PRESETS,
  createSignatureRequest,
  createFormLink,
} from "@/modules/docstudio/service";

const MARKER = "fixture.h26_ui";
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

async function wipe(): Promise<void> {
  const marked = (await owner`
    select org_id::text as id from public.app_settings where key = ${MARKER}`) as unknown as Array<{
    id: string;
  }>;
  const ids = marked.map((m) => m.id);
  if (ids.length === 0) {
    console.log("nothing to remove");
    return;
  }
  const users = (await owner`
    select user_id::text as id from public.membership where org_id = any(${ids}::uuid[])`) as unknown as Array<{
    id: string;
  }>;
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
    for (const u of users) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [u.id]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [u.id]);
      await tx.unsafe(`delete from auth.refresh_tokens where user_id = $1::text`, [u.id]);
      await tx.unsafe(`delete from auth.sessions where user_id = $1`, [u.id]);
      await tx.unsafe(`delete from auth.identities where user_id = $1`, [u.id]);
      await tx.unsafe(`delete from auth.users where id = $1`, [u.id]);
    }
  });
  console.log(`removed ${ids.length} fixture org(s), ${users.length} user(s)`);
}

async function seed(): Promise<void> {
  const run = randomUUID().slice(0, 6);
  const password = "Fixture-H26-ui!";
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const email = `h26ui-owner-${run}@example.invalid`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "H26 Owner" },
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
  }
  const ownerId = created.data.user.id;
  await owner`
    insert into public.user_profile (id, full_name, locale)
    values (${ownerId}, 'H26 Owner', 'en')
    on conflict (id) do update set full_name = excluded.full_name`;

  const orgId = await createOrgForUser(ownerId, {
    name: `H26 UI ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${MARKER}, ${JSON.stringify({ run })}::jsonb)
    on conflict do nothing`;
  const A: Ctx = {
    orgId,
    userId: ownerId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "h26-fixture",
  };
  await installTemplate(A, TEMPLATE_BOATBUILDING.key);
  await owner`
    update public.company set legal_name = 'Najola Marine Works LLC', tax_reg_no = '100123456700003',
      address_en = 'Plot 12, Marine Industrial Area', address_ar = 'قطعة 12، المنطقة الصناعية البحرية',
      city = 'Umm Al Quwain', phone = '+971 6 000 0000', email = 'office@example.invalid',
      signatory_name = 'Abdulla Al Ojan', signatory_title = 'Managing Director'
    where org_id = ${orgId} and is_default`;

  const customer = await createCustomer(A, "owner", {
    name: "Gulf Pearl Charters LLC",
    country: "AE",
    contactName: "Maha Saleh",
    email: "maha@example.invalid",
    phone: "+971 50 000 0000",
    taxRegNo: "100987654300003",
  });
  const supplier = await createSupplier(A, "owner", { name: "Resin and Glass Supplies FZE" });
  const employee = await createEmployee(A, "owner", { name: "Salem Al Harfi" });
  const folder = await createFolder(A, "owner", { name: "Charter agreements" });

  // 1. An NDA in draft (bilingual, with a customer counterparty).
  const nda = await createDocument(A, "owner", {
    title: `NDA with Gulf Pearl ${run}`,
    category: "contract",
    language: "bilingual",
    builtinKey: "builtin.nda",
    counterparty: { kind: "customer", id: customer.id },
    folderId: folder.id,
    tags: ["legal", "nda"],
  });
  const ndaRev = await getRevision(A, "owner", nda.revisionId);
  await saveRevision(A, "owner", {
    documentId: nda.id,
    revisionId: nda.revisionId,
    expectedRowVersion: ndaRev.rowVersion,
    variables: { term_years: 2 },
  });

  // 2. A service agreement issued and active (line items, deposit section shown).
  const sa = await createDocument(A, "owner", {
    title: `Season refit services ${run}`,
    category: "agreement",
    language: "bilingual",
    builtinKey: "builtin.service_agreement",
    counterparty: { kind: "customer", id: customer.id },
    folderId: folder.id,
    tags: ["refit"],
    expiresAt: "2027-06-30",
  });
  const saRev = await getRevision(A, "owner", sa.revisionId);
  const lines = saRev.body.blocks.map((b) =>
    b.type === "line_items"
      ? {
          ...b,
          items: [
            {
              description: { en: "Hull survey and strip", ar: "مسح الهيكل وتجريده" },
              qty: 1,
              unit: "lot",
              unitPriceMinor: 1800000,
              vatRate: 5,
            },
            {
              description: { en: "Lamination repairs", ar: "إصلاحات التصفيح" },
              qty: 12,
              unit: "m²",
              unitPriceMinor: 420000,
              vatRate: 5,
            },
            {
              description: { en: "Rigging refit", ar: "تجديد التجهيزات" },
              qty: 1,
              unit: "lot",
              unitPriceMinor: 2650000,
              vatRate: 5,
            },
          ],
        }
      : b,
  );
  await saveRevision(A, "owner", {
    documentId: sa.id,
    revisionId: sa.revisionId,
    expectedRowVersion: saRev.rowVersion,
    body: { blocks: lines },
    variables: { payment_days: 30 },
  });
  await submitForReview(A, "owner", { documentId: sa.id, note: "Ready for issue" });
  await issueDocument(A, "owner", { documentId: sa.id });

  // 3. An offer letter for an employee, issued (no signatures → active).
  const offer = await createDocument(A, "owner", {
    title: `Offer letter ${run}`,
    category: "letter",
    language: "en",
    builtinKey: "builtin.offer_letter",
    counterparty: { kind: "employee", id: employee.id },
    tags: ["hr"],
  });
  const offerRev = await getRevision(A, "owner", offer.revisionId);
  await saveRevision(A, "owner", {
    documentId: offer.id,
    revisionId: offer.revisionId,
    expectedRowVersion: offerRev.rowVersion,
    variables: { position: "Lamination lead", start_date: "2026-10-01", probation_months: 3 },
  });

  // 4. A supplier framework agreement in review.
  const sup = await createDocument(A, "owner", {
    title: `Resin supply framework ${run}`,
    category: "agreement",
    language: "en",
    builtinKey: "builtin.supplier_agreement",
    counterparty: { kind: "supplier", id: supplier.id },
    expiresAt: "2027-12-31",
    tags: ["procurement"],
  });
  const supRev = await getRevision(A, "owner", sup.revisionId);
  await saveRevision(A, "owner", {
    documentId: sup.id,
    revisionId: sup.revisionId,
    expectedRowVersion: supRev.rowVersion,
    variables: { annual_value: 15000000, volume_discount: 7 },
  });
  await submitForReview(A, "owner", { documentId: sup.id });

  // 5. A value-gated workflow and a document waiting in it (manager approval open).
  const wf = await createWorkflow(A, "owner", {
    name: "Value gate (manager, then owner above 50,000)",
    definition: WORKFLOW_PRESETS.find((p) => p.key === "value_gate")!.definition,
  });
  await createWorkflow(A, "owner", {
    name: "Manager review then owner approval",
    definition: WORKFLOW_PRESETS.find((p) => p.key === "manager_review")!.definition,
  });
  const gated = await createDocument(A, "owner", {
    title: `Charter services 2027 ${run}`,
    category: "agreement",
    language: "bilingual",
    builtinKey: "builtin.service_agreement",
    counterparty: { kind: "customer", id: customer.id },
    workflowId: wf.id,
    tags: ["charter"],
  });
  const gatedRev = await getRevision(A, "owner", gated.revisionId);
  await saveRevision(A, "owner", {
    documentId: gated.id,
    revisionId: gated.revisionId,
    expectedRowVersion: gatedRev.rowVersion,
    body: {
      blocks: gatedRev.body.blocks.map((b) =>
        b.type === "line_items"
          ? {
              ...b,
              items: [
                {
                  description: { en: "Season charter support", ar: "دعم موسم التأجير" },
                  qty: 1,
                  unit: "lot",
                  unitPriceMinor: 7500000,
                  vatRate: 5,
                },
              ],
            }
          : b,
      ),
    },
    variables: { payment_days: 30 },
  });
  await submitForReview(A, "owner", { documentId: gated.id });

  // 6. A signature room on the issued service agreement: the owner signs for the
  // company in-app; the customer gets a one-time link (printed below, no email here).
  const room = await createSignatureRequest(A, "owner", {
    documentId: sa.id,
    mode: "parallel",
    signers: [
      {
        party: "company",
        kind: "member",
        userId: ownerId,
        name: "H26 Owner",
        title: "Managing Director",
      },
      {
        party: "counterparty",
        kind: "external",
        name: "Maha Saleh",
        email: "maha@example.invalid",
      },
    ],
  });
  const signLink = room.invitations.find((i) => i.link)?.link ?? "";

  // 7. An issued intake form with a public link (shown once; only its hash is stored).
  const form = await createDocument(A, "owner", {
    title: "Customer intake form",
    category: "form",
    language: "bilingual",
    builtinKey: "builtin.intake_form",
  });
  await issueDocument(A, "owner", { documentId: form.id });
  const formLink = await createFormLink(A, "owner", {
    documentId: form.id,
    label: "Website",
    expiresInDays: 30,
    maxUses: 20,
  });

  console.log("\nDOCUMENT STUDIO FIXTURE READY");
  console.log(`  org:        ${orgId}`);
  console.log(`  hub:        /o/${orgId}/documents`);
  console.log(`  nda draft:  /o/${orgId}/documents/${nda.id}`);
  console.log(`  issued:     /o/${orgId}/documents/${sa.id}`);
  console.log(`  offer:      /o/${orgId}/documents/${offer.id}`);
  console.log(`  in review:  /o/${orgId}/documents/${sup.id}`);
  console.log(`  workflow:   /o/${orgId}/documents/workflows/${wf.id}`);
  console.log(`  gated doc:  /o/${orgId}/documents/${gated.id}`);
  console.log(`  sign link:  ${signLink}`);
  console.log(`  form doc:   /o/${orgId}/documents/${form.id}`);
  console.log(`  form link:  ${formLink.url}`);
  console.log(`  sign in:    ${email}  /  ${password}`);
}

async function main(): Promise<void> {
  try {
    if (process.argv.includes("--wipe")) await wipe();
    else await seed();
  } finally {
    await owner.end();
    await closeAppDb();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
