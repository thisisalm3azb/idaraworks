/**
 * Step-timed replay of the H25G integration setup against the TEST project,
 * to find which step hangs. Leaves nothing behind (wipes at the end).
 *
 *   npx tsx tooling/scripts/h25g-diag.ts
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, createTask, updateTask } from "@/modules/jobs/service";
import { createStudioPlan, addNode, addEdge, createScenario } from "@/modules/studio/service";

if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userM = randomUUID();
let orgA = "";

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const timer = setTimeout(() => console.log(`  … ${name} still running after 20s`), 20_000);
  try {
    const r = await fn();
    console.log(`${name}: ${Date.now() - t0}ms`);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let A: Ctx = {
    orgId: "",
    userId: userA,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "diag",
  };
  try {
    for (const [id, name] of [
      [userA, "Owner"],
      [userM, "Manager"],
    ] as const) {
      await step(
        `auth.users ${name}`,
        () => owner`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                ${`h25g-diag-${name.toLowerCase()}-${run}@example.invalid`},
                ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`,
      );
    }
    orgA = await step("createOrgForUser", () =>
      createOrgForUser(userA, { name: "H25G diag", country: "AE", baseCurrency: "AED" }),
    );
    A = { ...A, orgId: orgA };
    await step(
      "user_profile M",
      () => owner`
      insert into public.user_profile (id, full_name, locale) values (${userM}, 'Manager', 'en')
      on conflict (id) do nothing`,
    );
    await step(
      "membership M",
      () => owner`
      insert into public.membership (user_id, org_id, role_key) values (${userM}, ${orgA}, 'manager')`,
    );
    await step("installTemplate", () => installTemplate(A, TEMPLATE_BOATBUILDING.key));
    const preset = (await owner`
      select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
      id: string;
    }>;
    const job = await step("createJobFromPreset", () =>
      createJobFromPreset(A, "owner", { presetId: preset[0]!.id, name: `diag ${run}` }),
    );
    const taskA = (
      await step("createTask A", () =>
        createTask(A, "owner", { jobId: job.id, title: "Survey", startDate: "2026-10-05" }),
      )
    ).id;
    await step("updateTask A", () =>
      updateTask(A, "owner", taskA, {
        durationDays: 3,
        estimateOptimisticDays: 2,
        estimatePessimisticDays: 5,
      }),
    );
    const taskB = (
      await step("createTask B", () =>
        createTask(A, "owner", { jobId: job.id, title: "Lamination" }),
      )
    ).id;
    await step("updateTask B", () =>
      updateTask(A, "owner", taskB, {
        durationDays: 5,
        estimateOptimisticDays: 4,
        estimatePessimisticDays: 9,
      }),
    );
    const planId = (
      await step("createStudioPlan", () => createStudioPlan(A, "owner", { name: "diag" }))
    ).id;
    const nodeA = (
      await step("addNode A", () =>
        addNode(A, "owner", { planId, nodeType: "task", recordType: "task", recordId: taskA }),
      )
    ).id;
    const nodeB = (
      await step("addNode B", () =>
        addNode(A, "owner", { planId, nodeType: "task", recordType: "task", recordId: taskB }),
      )
    ).id;
    await step("addEdge", () =>
      addEdge(A, "owner", {
        planId,
        sourceNodeId: nodeA,
        targetNodeId: nodeB,
        edgeType: "dependency",
        depKind: "finish_to_start",
      }),
    );
    const M: Ctx = { ...A, userId: userM };
    await step("createScenario (manager)", () =>
      createScenario(M, "manager", { planId, name: "diag scenario" }),
    );
    console.log("SETUP OK");
  } finally {
    if (orgA) {
      const tables = (await owner`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
        table_name: string;
      }>;
      await owner.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        for (const t of tables) {
          await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgA]);
        }
        await tx.unsafe(`delete from public.org where id = $1`, [orgA]);
        for (const u of [userA, userM]) {
          await tx.unsafe(`delete from public.user_profile where id = $1`, [u]);
          await tx.unsafe(`delete from auth.users where id = $1`, [u]);
        }
      });
      console.log("wiped");
    }
    await owner.end();
    await closeAppDb();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
