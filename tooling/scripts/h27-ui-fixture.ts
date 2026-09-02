/**
 * Seed one organization with a revenue estate worth LOOKING at in the
 * Revenue Growth Studio, past the 1,000-row cap: 1,250 leads and 1,150
 * opportunities (so the board, the lead list and every total must page and
 * aggregate in the database), plus customers with contacts and consent,
 * campaigns with touches, a territory, targets, an automation, a deal with
 * stakeholders, products, risks and a canvas, a forecast snapshot and a
 * scenario. TEST project only; leaves the fixture in place to be browsed;
 * `--wipe` removes it.
 *
 *   npx tsx tooling/scripts/h27-ui-fixture.ts          seed, print the sign-in
 *   npx tsx tooling/scripts/h27-ui-fixture.ts --wipe   remove it
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { addCustomerContact, createCustomer } from "@/modules/masters/service";
import {
  addProductLine,
  addRisk,
  addStakeholder,
  captureForecastSnapshot,
  createAutomation,
  createCampaign,
  createTerritory,
  listStageSettings,
  logActivity,
  recordConsent,
  recordSignal,
  recordTouch,
  saveDealCanvas,
  saveScenario,
  setTarget,
  updateCommercial,
  updateStageSettings,
} from "@/modules/crm/service";

const MARKER = "fixture.h27_ui";
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

const daysFromNow = (n: number) => {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

async function seed(): Promise<void> {
  const run = randomUUID().slice(0, 6);
  const password = "Fixture-H27-ui!";
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const email = `h27ui-owner-${run}@example.invalid`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "H27 Owner" },
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
  }
  const ownerId = created.data.user.id;
  await owner`
    insert into public.user_profile (id, full_name, locale)
    values (${ownerId}, 'H27 Owner', 'en')
    on conflict (id) do update set full_name = excluded.full_name`;
  const orgId = await createOrgForUser(ownerId, {
    name: `H27 UI ${run}`,
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
    requestId: "h27-fixture",
  };
  await installTemplate(A, TEMPLATE_BOATBUILDING.key);
  await owner`
    update public.company set legal_name = 'Najola Marine Works LLC', tax_reg_no = '100123456700003',
      address_en = 'Plot 12, Marine Industrial Area', city = 'Umm Al Quwain'
    where org_id = ${orgId} and is_default`;

  // Stage governance: qualified needs a value and a contact; proposal needs a product line.
  const stages = await listStageSettings(A, "owner", null);
  const qualified = stages.find((s) => s.key === "qualified");
  const proposal = stages.find((s) => s.key === "proposal");
  if (qualified)
    await updateStageSettings(A, "owner", {
      stageKey: qualified.key,
      requirements: ["value", "customer"],
      defaultProbability: 30,
      maxAgeDays: 21,
    });
  if (proposal)
    await updateStageSettings(A, "owner", {
      stageKey: proposal.key,
      requirements: ["value", "customer", "product"],
      defaultProbability: 60,
      maxAgeDays: 30,
    });
  const openStages = stages.filter((s) => s.category === "open").map((s) => s.key);

  // Customers with contacts, consent, signals.
  const names = [
    "Gulf Pearl Charters LLC",
    "Al Marsa Fisheries",
    "Coral Bay Resorts",
    "Blue Horizon Logistics",
    "Dana Marine Services",
    "Khor Fakkan Port Authority",
  ];
  const customers: Array<{ id: string; name: string }> = [];
  for (const [i, name] of names.entries()) {
    const c = await createCustomer(A, "owner", {
      name,
      country: i % 3 === 0 ? "AE" : i % 3 === 1 ? "SA" : "OM",
      email: `${name.split(" ")[0]!.toLowerCase()}-${run}@example.invalid`,
      phone: `+9715000000${10 + i}`,
    });
    customers.push({ id: c.id, name });
    const contact = await addCustomerContact(A, "owner", c.id, {
      name: [
        "Maha Saleh",
        "Omar Haddad",
        "Layla Nasser",
        "Faisal Rahman",
        "Noor Ali",
        "Sami Kamal",
      ][i]!,
      roleTitle: ["Buyer", "Operations", "GM", "Procurement", "Finance", "Director"][i]!,
      email: `contact${i}-${run}@example.invalid`,
      isPrimary: true,
    });
    await recordConsent(A, "owner", {
      contactId: contact.id,
      channel: "email",
      status: i === 4 ? "withdrawn" : "granted",
      source: "written",
      evidence: "Signed intake form",
    });
    if (i === 1)
      await recordSignal(A, "owner", {
        customerId: c.id,
        kind: "churn_risk",
        score: 75,
        status: "at_risk",
        title: "Escalated twice this quarter",
      });
    if (i === 2)
      await recordSignal(A, "owner", {
        customerId: c.id,
        kind: "satisfaction",
        score: 5,
        title: "NPS 9",
      });
  }

  // Territory, targets, campaigns.
  await createTerritory(A, "owner", {
    key: "gcc_north",
    name: { en: "Northern Emirates", ar: "الإمارات الشمالية" },
    rules: { countries: ["AE"] },
    ownerUserId: ownerId,
  });
  const year = daysFromNow(0).slice(0, 4);
  await setTarget(A, "owner", {
    scopeKind: "org",
    metric: "revenue",
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
    amountMinor: 500_000_000,
    currency: "AED",
  });
  await setTarget(A, "owner", {
    scopeKind: "user",
    scopeId: ownerId,
    metric: "activities",
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
    countTarget: 400,
  });
  const boatShow = await createCampaign(A, "owner", {
    name: "Dubai Boat Show",
    channel: "event",
    status: "active",
    budgetMinor: 5_000_000,
    costMinor: 3_200_000,
    currency: "AED",
    startsOn: daysFromNow(-40),
    endsOn: daysFromNow(-35),
  });
  const referral = await createCampaign(A, "owner", {
    name: "Owner referral programme",
    channel: "referral",
    status: "active",
    budgetMinor: 500_000,
    currency: "AED",
  });

  // 1,250 leads and 1,150 opportunities in two statements (TEST-only fixture
  // rows for the paging and aggregate proof; the showcase records below go
  // through the governed services so history, audit and canvas are real).
  const sources = ["manual", "form", "referral", "campaign", "email", "customer"];
  await owner`
    insert into public.lead (org_id, name, contact_name, email, country, source_kind, campaign_id,
                             estimated_value_minor, currency, timeframe, quarantine, created_by, created_at)
    select ${orgId}::uuid,
           'Lead ' || lpad(i::text, 4, '0') || ' ' || (array['Marina','Yacht','Fisheries','Charter','Port'])[1 + i % 5] || ' ' || ${run},
           case when i % 7 = 0 then 'Repeat Contact' else 'Person ' || i end,
           case when i % 50 = 0 then 'dup-' || ${run} || '@example.invalid' else 'lead' || i || '-' || ${run} || '@example.invalid' end,
           (array['AE','SA','OM','QA'])[1 + i % 4],
           (${sources}::text[])[1 + i % 6],
           case when (${sources}::text[])[1 + i % 6] = 'campaign' then ${boatShow.id}::uuid else null end,
           (i % 9) * 2500000 + 1000000, 'AED',
           (array['immediate','quarter','half_year','year','unknown'])[1 + i % 5],
           case when (${sources}::text[])[1 + i % 6] in ('form', 'email') then 'quarantined' else 'trusted' end,
           ${ownerId}::uuid, now() - (i || ' minutes')::interval
    from generate_series(1, 1250) as i`;
  const q =
    (await owner`select count(*)::int as n from public.lead where org_id = ${orgId} and quarantine = 'quarantined'`) as unknown as Array<{
      n: number;
    }>;
  const quarantined = Number(q[0]?.n ?? 0);
  const customerIds = customers.map((c) => c.id);
  await owner`
    insert into public.opportunity (org_id, name, customer_id, stage_key, estimated_value_minor, currency,
                                    expected_close_date, probability, created_by, created_at, stage_entered_at)
    select ${orgId}::uuid,
           (array['Hull refit','New 24C','Engine package','Annual service','Fleet expansion'])[1 + i % 5] || ' ' || lpad(i::text, 4, '0'),
           (${customerIds}::uuid[])[1 + i % ${customerIds.length}],
           (${openStages}::text[])[1 + i % ${openStages.length}],
           ((i % 12) + 1) * 4500000, 'AED',
           current_date + (((i % 8) + 1) * 15), (array[20,40,60,80])[1 + i % 4],
           ${ownerId}::uuid, now() - ((i % 200) || ' days')::interval - (i || ' minutes')::interval,
           now() - ((i % 200) || ' days')::interval - (i || ' minutes')::interval
    from generate_series(1, 1150) as i`;
  const oppRows = (await owner`
    select id::text as id from public.opportunity where org_id = ${orgId} order by created_at desc limit 60`) as unknown as Array<{
    id: string;
  }>;
  const oppIds = oppRows.map((r) => r.id);
  // History: a slice won and lost at various dates (fixture-only direct update; TEST project).
  await owner`
    update public.opportunity set status = 'won', stage_key = 'won', won_at = least(now(), public.opportunity.created_at + ((id_ord % 60) || ' days')::interval)
    from (select id, row_number() over (order by created_at) as id_ord from public.opportunity where org_id = ${orgId}) x
    where public.opportunity.id = x.id and x.id_ord % 23 = 0`;
  await owner`
    update public.opportunity set status = 'lost', stage_key = 'lost', lost_at = least(now(), public.opportunity.created_at + ((id_ord % 45) || ' days')::interval),
      loss_reason = (array['price','timing','competitor','no_budget'])[1 + id_ord % 4]
    from (select id, row_number() over (order by created_at) as id_ord from public.opportunity where org_id = ${orgId}) x
    where public.opportunity.id = x.id and x.id_ord % 29 = 0 and public.opportunity.status = 'open'`;
  // Age a few stage entries so stalled and ageing rules bite.
  await owner`
    update public.opportunity set stage_entered_at = now() - interval '45 days'
    from (select id, row_number() over (order by created_at) as id_ord from public.opportunity where org_id = ${orgId}) x
    where public.opportunity.id = x.id and x.id_ord % 41 = 0 and public.opportunity.status = 'open'`;
  // Campaign touches on a few won deals (attribution).
  for (const id of oppIds.slice(0, 40))
    await recordTouch(A, "owner", { campaignId: boatShow.id, opportunityId: id, kind: "exposure" });
  for (const id of oppIds.slice(20, 50))
    await recordTouch(A, "owner", { campaignId: referral.id, opportunityId: id, kind: "referral" });

  // The showcase deal: stakeholders, products, risks, commercial, canvas, activities.
  const deal = oppIds[2]!;
  const dealRow =
    (await owner`select row_version from public.opportunity where id = ${deal}`) as unknown as Array<{
      row_version: number;
    }>;
  await addStakeholder(A, "owner", {
    opportunityId: deal,
    name: "Maha Saleh",
    roleKind: "decision_maker",
    influence: 5,
    sentiment: "supporter",
  });
  await addStakeholder(A, "owner", {
    opportunityId: deal,
    name: "Khalid Finance",
    roleKind: "economic_buyer",
    influence: 4,
    sentiment: "neutral",
  });
  await addStakeholder(A, "owner", {
    opportunityId: deal,
    name: "Yard supervisor",
    roleKind: "blocker",
    influence: 2,
    sentiment: "detractor",
  });
  await addProductLine(A, "owner", {
    opportunityId: deal,
    description: "24ft Catamaran hull, standard layout",
    qty: 1,
    unit: "ea",
    unitPriceMinor: 38_000_000,
    vatRate: 5,
    unitCostMinor: 26_000_000,
  });
  await addProductLine(A, "owner", {
    opportunityId: deal,
    description: "Twin outboard package",
    qty: 2,
    unit: "ea",
    unitPriceMinor: 6_500_000,
    discountPct: 5,
    vatRate: 5,
  });
  await addProductLine(A, "owner", {
    opportunityId: deal,
    description: "Annual maintenance plan",
    qty: 1,
    unit: "yr",
    unitPriceMinor: 1_200_000,
    vatRate: 5,
    recurrenceMonths: 12,
    optional: true,
  });
  await addRisk(A, "owner", {
    opportunityId: deal,
    kind: "blocker",
    title: "Berth availability at delivery",
    severity: "high",
    mitigation: "Confirm with marina by month end",
  });
  const afterLines =
    (await owner`select row_version from public.opportunity where id = ${deal}`) as unknown as Array<{
      row_version: number;
    }>;
  await updateCommercial(A, "owner", {
    id: deal,
    rowVersion: Number(afterLines[0]?.row_version ?? dealRow[0]?.row_version ?? 1),
    forecastCategory: "commit",
    kind: "new_business",
    decisionCriteria:
      "Delivery before the season; local service coverage; financing over 24 months.",
    needs: "Replace an ageing charter boat; reduce fuel cost per trip.",
    buyingProcess: [
      { step: "Technical evaluation", done: true, owner: "Maha" },
      { step: "Board approval", owner: "Khalid", due: daysFromNow(20) },
      { step: "Contract signature", due: daysFromNow(35) },
    ],
  });
  await saveDealCanvas(A, "owner", {
    opportunityId: deal,
    rowVersion: 0,
    doc: {
      nodes: [
        { id: "n1", kind: "stakeholder", label: "Maha (decision)", x: 60, y: 60 },
        { id: "n2", kind: "stakeholder", label: "Khalid (budget)", x: 320, y: 60 },
        { id: "n3", kind: "decision", label: "Board approval", x: 190, y: 200 },
        { id: "n4", kind: "risk", label: "Berth availability", x: 460, y: 200 },
        { id: "n5", kind: "step", label: "Contract signature", x: 190, y: 330 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n3" },
        { id: "e2", from: "n2", to: "n3", label: "signs off" },
        { id: "e3", from: "n3", to: "n5" },
        { id: "e4", from: "n4", to: "n5", label: "blocks" },
      ],
    },
  });
  await logActivity(A, "owner", {
    opportunityId: deal,
    kind: "meeting",
    title: "Site visit and sea trial",
    body: "Walked the yard; customer keen on the twin outboard option.",
    outcome: "positive",
  });
  await logActivity(A, "owner", {
    opportunityId: deal,
    kind: "follow_up",
    title: "Send revised proposal",
    dueDate: daysFromNow(-2),
  });
  await logActivity(A, "owner", {
    customerId: customers[0]!.id,
    kind: "call",
    title: "Quarterly check-in",
    dueDate: daysFromNow(0),
  });

  // Automation (dry run), forecast snapshot, scenario.
  const automation = await createAutomation(A, "owner", {
    name: "Chase deals ageing in stage",
    trigger: "opportunity_stage_aged",
    conditions: { all: [{ key: "stage_age_days", op: "gte", value: 30 }] },
    actions: [{ kind: "create_task", title: "Chase the aged deal", dueInDays: 2 }],
    enabled: false,
    dryRun: true,
  });
  const snapshot = await captureForecastSnapshot(A, "owner", {
    periodKey: daysFromNow(0).slice(0, 7),
    note: "Fixture snapshot",
  });
  await saveScenario(A, "owner", {
    name: "Season slips a month",
    overlay: {
      excludes: [oppIds[5]!],
      slips: [{ opportunityId: oppIds[6]!, months: 1 }],
      probabilities: [{ opportunityId: deal, probability: 90 }],
      categories: [],
    },
    assumptions: "Two hull deliveries slip into next quarter; the showcase deal firms up.",
  });

  console.log("\nREVENUE STUDIO FIXTURE READY");
  console.log(`  org:         ${orgId}`);
  console.log(`  hub:         /o/${orgId}/revenue`);
  console.log(`  pipeline:    /o/${orgId}/revenue/pipeline`);
  console.log(`  deal room:   /o/${orgId}/revenue/deals/${deal}`);
  console.log(`  customer:    /o/${orgId}/revenue/customers/${customers[0]!.id}`);
  console.log(`  automation:  ${automation.id}`);
  console.log(`  snapshot:    ${snapshot.id}`);
  console.log(`  leads:       1250 (quarantined ${quarantined})`);
  console.log(`  deals:       1150 (showcase among the newest 60)`);
  console.log(`  sign in:     ${email}  /  ${password}`);
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
