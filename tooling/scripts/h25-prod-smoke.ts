/**
 * H25 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * Proof that the Management Studio works on the real database and the real
 * deployed application, through the same module functions the screens call
 * plus the REAL HTTP routes. Every step asserts a property that would be
 * expensive to get wrong; the fixture self-destructs pass or fail.
 *
 * What it walks:
 *   1. a plan from a built-in template: anchored drafts, a real schedule with
 *      a critical chain computed by the engine
 *   2. a draft converted into a canonical task and linked (one record, one
 *      projection); an allocation; capacity demand per person-week
 *   3. registers: a scored risk and an unscored one; KPI catalogue says
 *      "insufficient" before a baseline and measures after
 *   4. a scenario: overlay edit leaves live untouched, compare shows the
 *      delta, Monte Carlo reproduces from its seed, submit → approve → apply
 *      moves the live plan, discard is refused once applied
 *   5. saved view privacy; the advisor's findings; the fail-closed narrative;
 *      the portfolio score components
 *   6. private-channel predicate: the owner passes, a stranger does not
 *   7. viewer refused for shaping; the release gate: /studio answers
 *      not-found while the flag is off (pass --surfaces=on after enabling)
 *
 * SAFETY: creates one marked organization and one user; touches nothing
 * else; cleanup runs in `finally`; residue and historical counts verified.
 *
 *   npx tsx tooling/scripts/h25-prod-smoke.ts --confirm=<production phrase> [--surfaces=on]
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
import { createEmployee } from "@/modules/masters/service";
import { createJobFromPreset, allocateTask, listTaskAllocations } from "@/modules/jobs/service";
import { decideApproval } from "@/modules/approvals/service";
import {
  createPlanFromTemplate,
  scheduleForPlan,
  resolvePlanGraph,
  addNode,
  updateNode,
  convertNode,
  captureBaseline,
  capacityForPlan,
  listRegister,
  computeKpis,
  createScenario,
  compareScenario,
  simulatePlan,
  submitScenario,
  applyScenario,
  discardScenario,
  listScenarios,
  saveView,
  listViews,
  reviewPlan,
  draftReviewNarrative,
  portfolioSummary,
  createStudioPlan,
} from "@/modules/studio/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h25";
const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerPassword = `Smoke-${randomUUID()}`;
const ownerEmail = `h25smoke-${RUN}@example.invalid`;
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h25-smoke-${RUN}`,
});
let checks = 0;
function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) throw new Error(`FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok: ${what}${detail ? ` (${detail})` : ""}`);
}

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
      (select count(*) from public.studio_plan where org_id = ${orgId}) +
      (select count(*) from public.studio_node where org_id = ${orgId}) +
      (select count(*) from public.task_allocation where org_id = ${orgId}) +
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

/** The channel predicate exactly as Realtime evaluates it (authenticated + claims + topic). */
async function channelAllowed(userId: string, topic: string): Promise<boolean> {
  let ok = false;
  await owner
    .begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await tx.unsafe(`set local role authenticated`);
      const r = (await tx.unsafe(`select app.studio_channel_allowed($1) as ok`, [topic])) as Array<{
        ok: boolean;
      }>;
      ok = r[0]?.ok === true;
      throw new Error("__rollback__");
    })
    .catch((e: { message?: string }) => {
      if (e.message !== "__rollback__") throw e;
    });
  return ok;
}

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
    `H25 production smoke on ${PRODUCTION_PROJECT_REF} (run ${RUN}, surfaces=${surfaces})`,
  );

  const before = (await owner`
    select (select count(*) from public.org) as orgs,
           (select count(*) from public.studio_plan) as plans,
           (select count(*) from public.studio_node) as nodes,
           (select count(*) from public.task) as tasks,
           (select count(*) from public.task_allocation) as allocations,
           (select count(*) from public.studio_scenario) as scenarios,
           (select count(*) from public.skill) as skills`) as unknown as Array<
    Record<string, string>
  >;
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
      user_metadata: { full_name: "H25 Smoke" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${ownerUserId}, 'H25 Smoke', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H25 smoke ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    console.log(`fixture org ${orgId}`);

    // ── 1. plan from template, engine schedule ─────────────────────────────
    const plan = await createPlanFromTemplate(A(), "owner", {
      templateKey: "builtin.refit",
      name: `Smoke refit ${RUN}`,
      startDate: "2026-10-05",
    });
    const planId = plan.id;
    check("template instantiated as drafts", plan.nodes === 6 && plan.edges === 6, plan.reference);
    const sched = await scheduleForPlan(A(), "owner", { planId });
    check(
      "engine schedules the network",
      sched.result.ok && sched.byNode.size === 5,
      `${sched.result.projectStart} → ${sched.result.projectFinish}`,
    );
    check(
      "critical chain computed, 12 working days",
      sched.result.projectDurationDays === 12 && sched.result.criticalPaths.length >= 1,
    );
    const graph = await resolvePlanGraph(A(), "owner", { planId });
    const survey = graph.nodes.find((n) => n.title === "Survey and strip")!;
    const repairs = graph.nodes.find((n) => n.title === "Structural repairs")!;
    check(
      "survey is critical, systems refit has float",
      sched.byNode.get(survey.id)!.critical &&
        sched.byNode.get(graph.nodes.find((n) => n.title === "Systems refit")!.id)!.totalFloatDays >
          0,
    );

    // ── 2. convert a draft to a canonical task, allocate, capacity ─────────
    const preset = (await owner`
      select id::text as id from public.job_preset where org_id = ${orgId} limit 1`) as unknown as Array<{
      id: string;
    }>;
    const job = await createJobFromPreset(A(), "owner", {
      presetId: preset[0]!.id,
      name: `Smoke job ${RUN}`,
    });
    const converted = await convertNode(A(), "owner", {
      nodeId: survey.id,
      to: "task",
      jobId: job.id,
    });
    check("draft converted into a task and linked", converted.recordType === "task");
    const emp = await createEmployee(A(), "owner", { name: "Smoke Person" });
    await allocateTask(A(), "owner", {
      taskId: converted.recordId,
      employeeId: emp.id,
      sharePct: 100,
    });
    check(
      "allocation is canonical",
      (await listTaskAllocations(A(), "owner", [converted.recordId])).length === 1,
    );
    const cap = await capacityForPlan(A(), "owner", { planId });
    const person = cap.people.find((p) => p.employeeId === emp.id)!;
    check(
      "capacity demand per person-week from the schedule",
      person.cells["2026-10-05"]!.demandDays === 3,
      JSON.stringify(person.cells["2026-10-05"]),
    );

    // ── 3. registers + KPIs ────────────────────────────────────────────────
    await addNode(A(), "owner", { planId, nodeType: "risk", title: "Unscored risk", x: 0, y: 0 });
    const reg = await listRegister(A(), "owner", { kind: "risk", planId, status: "open" });
    check(
      "risk register: one scored (9), one unscored",
      reg.total === 2 &&
        reg.rows.some((r) => r.score === 9) &&
        reg.rows.some((r) => r.score === null),
    );
    const k1 = await computeKpis(A(), "owner", {
      planId,
      keys: ["plan.duration_days", "plan.finish_variance_days"],
    });
    check(
      "KPI measures duration, refuses variance without baseline",
      k1[0]?.status === "ok" && k1[0].value === 12 && k1[1]?.status === "insufficient",
    );
    await captureBaseline(A(), "owner", { planId, name: "Smoke baseline" });
    const k2 = await computeKpis(A(), "owner", { planId, keys: ["plan.finish_variance_days"] });
    check(
      "KPI measures variance once a baseline exists",
      k2[0]?.status === "ok" && k2[0].value === 0,
    );

    // ── 4. scenario lifecycle ──────────────────────────────────────────────
    const scenario = await createScenario(A(), "owner", { planId, name: "Longer repairs" });
    const ov = await updateNode(A(), "owner", {
      nodeId: repairs.id,
      scenarioId: scenario.id,
      durationDays: 9,
    });
    check("scenario edit is an overlay", ov.routed === "scenario");
    const liveAfter = await scheduleForPlan(A(), "owner", { planId });
    check("live schedule untouched by the overlay", liveAfter.result.projectDurationDays === 12);
    const cmp = await compareScenario(A(), "owner", scenario.id);
    check(
      "compare shows from → to and +3 working days",
      cmp.changes[0]?.oldValue === 6 &&
        cmp.changes[0]?.newValue === 9 &&
        cmp.schedule.finishDeltaDays === 3,
    );
    const s1 = await simulatePlan(A(), "owner", {
      planId,
      scenarioId: scenario.id,
      samples: 300,
      seed: 42,
    });
    const s2 = await simulatePlan(A(), "owner", {
      planId,
      scenarioId: scenario.id,
      samples: 300,
      seed: 42,
    });
    check(
      "Monte Carlo reproduces from its seed",
      s1.ok && s2.ok && JSON.stringify(s1.finish) === JSON.stringify(s2.finish),
      s1.ok ? `P50 ${s1.finish.p50} P80 ${s1.finish.p80}` : "",
    );
    const sub = await submitScenario(A(), "owner", { scenarioId: scenario.id });
    check(
      "submitted through the approval engine",
      sub.status === "under_review" && sub.approvalId.length > 0,
    );
    await decideApproval(A(), "owner", { approvalId: sub.approvalId, decision: "approved" });
    check(
      "approved, not yet applied",
      (await listScenarios(A(), "owner", planId)).find((s) => s.id === scenario.id)!.status ===
        "approved" &&
        (await scheduleForPlan(A(), "owner", { planId })).result.projectDurationDays === 12,
    );
    const applied = await applyScenario(A(), "owner", { scenarioId: scenario.id });
    const liveApplied = await scheduleForPlan(A(), "owner", { planId });
    check(
      "apply replays the change onto the live plan",
      applied.applied === 1 && liveApplied.result.projectDurationDays === 15,
    );
    let discardRefused = false;
    try {
      await discardScenario(A(), "owner", { scenarioId: scenario.id });
    } catch {
      discardRefused = true;
    }
    check("an applied scenario cannot be discarded", discardRefused);

    // ── 5. views, advisor, narrative, portfolio ────────────────────────────
    const view = await saveView(A(), "owner", {
      planId,
      name: "Critical only",
      view: "gantt",
      config: { filters: { criticalOnly: true } },
    });
    check(
      "saved view listed for its owner",
      (await listViews(A(), "owner", planId)).some((v) => v.id === view.id),
    );
    const review = await reviewPlan(A(), "owner", { planId });
    check(
      "advisor names findings with next steps",
      review.findings.some((f) => f.key === "unscored_risks") &&
        review.findings.every((f) => ["high", "medium", "low"].includes(f.severity)),
    );
    const narrative = await draftReviewNarrative(A(), "owner", { planId, locale: "en" });
    check(
      "assistant seam fails closed",
      !narrative.available && narrative.reason === "assistant not provisioned",
    );
    const portfolio = await portfolioSummary(A(), "owner");
    const row = portfolio.rows.find((r) => r.plan.id === planId)!;
    check(
      "portfolio score is the sum of named components",
      row.score !== null && row.components.reduce((s, c) => s + c.points, 0) === row.score,
      `${row.score}`,
    );

    // ── 6. private channel predicate ───────────────────────────────────────
    const topic = `studio:${orgId}:${planId}`;
    check("owner passes the private channel predicate", await channelAllowed(ownerUserId, topic));
    check("a stranger is refused on the same topic", !(await channelAllowed(randomUUID(), topic)));

    // ── 7. permissions + release gate ──────────────────────────────────────
    let viewerRefused = false;
    try {
      await createStudioPlan(A(), "viewer", { name: "nope" });
    } catch (e) {
      viewerRefused = e instanceof ForbiddenError;
    }
    check("viewer cannot shape plans", viewerRefused);
    const cookie = await ownerCookie();
    const gate = await fetch(`${BASE}/o/${orgId}/studio`, {
      headers: { cookie },
      redirect: "manual",
    });
    const body = await gate.text();
    const showsNotFound = /not found|404|غير موجود/i.test(body);
    const showsStudio =
      body.includes("Management Studio") ||
      body.includes("استوديو الإدارة") ||
      body.includes(`Smoke refit ${RUN}`);
    if (surfaces === "off") {
      check(
        "studio hidden while the flag is unset",
        (gate.status === 404 || (gate.status === 200 && showsNotFound)) && !showsStudio,
        `${gate.status}`,
      );
    } else {
      check(
        "studio visible with the flag on",
        gate.status === 200 && showsStudio,
        `${gate.status}`,
      );
      const planPage = await fetch(`${BASE}/o/${orgId}/studio/${planId}`, {
        headers: { cookie },
        redirect: "manual",
      });
      const planBody = await planPage.text();
      check(
        "plan workspace renders on the deployed app",
        planPage.status === 200 && planBody.includes(`Smoke refit ${RUN}`),
        `${planPage.status}`,
      );
      check(
        "three.js is not in the plan page's first load",
        !/WebGPURenderer|requestAdapter/.test(planBody),
      );
    }
    console.log(`\nALL ${checks} CHECKS PASSED (surfaces=${surfaces})`);
  } finally {
    await cleanup();
    const after = (await owner`
      select (select count(*) from public.org) as orgs,
             (select count(*) from public.studio_plan) as plans,
             (select count(*) from public.studio_node) as nodes,
             (select count(*) from public.task) as tasks,
             (select count(*) from public.task_allocation) as allocations,
             (select count(*) from public.studio_scenario) as scenarios,
             (select count(*) from public.skill) as skills`) as unknown as Array<
      Record<string, string>
    >;
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
