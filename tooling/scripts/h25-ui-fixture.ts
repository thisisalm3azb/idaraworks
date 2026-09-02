/**
 * Seed one organization with a plan worth LOOKING at in the Management Studio
 * (H25 counterpart of h23-ui-fixture.ts). TEST project only; leaves the
 * fixture in place to be browsed; `--wipe` removes it.
 *
 *   npx tsx tooling/scripts/h25-ui-fixture.ts          seed, print the sign-in
 *   npx tsx tooling/scripts/h25-ui-fixture.ts --wipe   remove it
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createEmployee } from "@/modules/masters/service";
import { createJobFromPreset, createTask, updateTask } from "@/modules/jobs/service";
import { createStudioPlan, addNode, addEdge, captureBaseline } from "@/modules/studio/service";

const MARKER = "fixture.h25_ui";
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
  const password = "Fixture-H25-ui!";
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const email = `h25ui-owner-${run}@example.invalid`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "H25 Owner" },
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
  }
  const ownerId = created.data.user.id;
  await owner`
    insert into public.user_profile (id, full_name, locale)
    values (${ownerId}, 'H25 Owner', 'en')
    on conflict (id) do update set full_name = excluded.full_name`;

  const orgId = await createOrgForUser(ownerId, {
    name: `H25 UI ${run}`,
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
    requestId: "h25-fixture",
  };
  await installTemplate(A, TEMPLATE_BOATBUILDING.key);

  const emp = await createEmployee(A, "owner", { name: "Salem Al Harfi" });
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgId} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A, "owner", {
    presetId: preset[0]!.id,
    name: `Hull 24 refit ${run}`,
  });

  // Real work: five tasks with durations, one assigned, one milestone-ish.
  const mk = async (title: string, days: number, startDate?: string) => {
    const t = await createTask(A, "owner", {
      jobId: job.id,
      title,
      ...(startDate ? { startDate } : {}),
    });
    await updateTask(A, "owner", t.id, { durationDays: days });
    return t.id;
  };
  const survey = await mk("Survey and strip", 3, "2026-10-05");
  const lamination = await mk("Lamination repairs", 6);
  const rigging = await mk("Rigging refit", 4);
  const electrics = await mk("Electrical rework", 5);
  const finish = await mk("Finishing and polish", 3);
  await updateTask(A, "owner", lamination, { assigneeEmployeeId: emp.id });

  // The plan: linked tasks + a draft milestone + governance shapes.
  const plan = await createStudioPlan(A, "owner", {
    name: `Hull 24 refit plan ${run}`,
    description: "A real refit, planned on the canvas and scheduled from the network.",
  });
  const p = plan.id;
  const node = async (
    nodeType: string,
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ) => (await addNode(A, "owner", { planId: p, nodeType, x, y, ...extra })).id;

  const nSurvey = await node("task", 80, 200, { recordType: "task", recordId: survey });
  const nLam = await node("task", 360, 120, { recordType: "task", recordId: lamination });
  const nRig = await node("task", 360, 300, { recordType: "task", recordId: rigging });
  const nElec = await node("task", 640, 200, { recordType: "task", recordId: electrics });
  const nFinish = await node("task", 920, 200, { recordType: "task", recordId: finish });
  const nHandover = await node("milestone", 1200, 200, { title: "Handover to owner" });
  const nRisk = await node("risk", 640, 420, {
    title: "Resin supply delay",
    data: { likelihood: 3, impact: 4, response: "mitigate", mitigation: "Second supplier quoted" },
  });
  const nDecision = await node("decision", 80, 420, {
    title: "Replace or repair the mast step?",
    data: { question: "Replace or repair?", options: [{ label: "Replace" }, { label: "Repair" }] },
  });
  await node("objective", 640, 20, { title: "Season-ready fleet by November" });

  const dep = (s: string, t: string, lagDays = 0) =>
    addEdge(A, "owner", {
      planId: p,
      sourceNodeId: s,
      targetNodeId: t,
      edgeType: "dependency",
      depKind: "finish_to_start",
      lagDays,
    });
  await dep(nSurvey, nLam);
  await dep(nSurvey, nRig);
  await dep(nLam, nElec);
  await dep(nRig, nElec, 1);
  await dep(nElec, nFinish);
  await dep(nFinish, nHandover);
  await addEdge(A, "owner", {
    planId: p,
    sourceNodeId: nRisk,
    targetNodeId: nLam,
    edgeType: "risk_influence",
  });
  await addEdge(A, "owner", {
    planId: p,
    sourceNodeId: nDecision,
    targetNodeId: nSurvey,
    edgeType: "reference",
  });
  await captureBaseline(A, "owner", { planId: p, name: "Baseline 0" });

  console.log("\nSTUDIO FIXTURE READY");
  console.log(`  org:      ${orgId}`);
  console.log(`  plan:     /o/${orgId}/studio/${p}`);
  console.log(`  sign in:  ${email}  /  ${password}`);
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
