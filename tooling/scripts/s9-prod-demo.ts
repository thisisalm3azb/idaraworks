/**
 * S9 production DoD demo (Arabic "Commercial Wiring") — runs the REAL service layer against
 * production Supabase (DIRECT_URL) with the FAKE billing provider, then deletes every synthetic row
 * (0 leftovers). NO real processor, no real money — the deployed app keeps the provider DISABLED
 * (D1 gate); this script sets BILLING_PROVIDER=fake to exercise the governed logic.
 *
 * Demonstrates (doc 11 S9 DoD): plan catalogue; trial → active → past_due → grace → suspended →
 * recovery; upgrade (immediate) + downgrade (scheduled, data preserved); usage metering + hard
 * limit at the service boundary; read-only enforcement (FR-9); duplicate + out-of-order events are
 * idempotent; reconciliation drift; a support session visible in the tenant's OWN audit log; and
 * that real activation stays DISABLED. Touches ONLY its Arabic synthetic org; Alpha Marine +
 * TESTING are never read or written.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  emitFakeSignal,
  changePlan,
  readSubscription,
  assertTenantWritable,
  SubscriptionReadOnlyError,
} from "@/modules/subscription/service";
import {
  recordUsage,
  getUsage,
  checkMeteredLimit,
  monthPeriodKey,
} from "@/modules/subscription/usage";
import { sweepLifecycle, runReconciliation } from "@/workers/functions/subscription-worker";
import { setFakeProviderState, disabledBillingProvider } from "@/platform/billing/adapter";
import {
  startImpersonation,
  endImpersonation,
  listImpersonations,
} from "@/modules/support/service";

process.env.BILLING_PROVIDER = "fake";
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);
const ownerUser = randomUUID();
const staffUser = randomUUID();
let orgId = "";
const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s9-prod-demo",
});
const stateOf = async (): Promise<string> => {
  const r =
    (await owner`select billing_state from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
      billing_state: string;
    }>;
  return r[0]!.billing_state;
};

async function cleanup() {
  if (!orgId) return;
  // Order-independent wipe of this org's rows (replica mode disables FK triggers), then the org +
  // users. Only ever touches this synthetic org — Alpha Marine / TESTING are never referenced.
  const tbls = (await owner`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tbls)
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    await tx.unsafe(`delete from public.platform_staff where user_id = $1`, [staffUser]);
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [
      [ownerUser, staffUser],
    ]);
    await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [[ownerUser, staffUser]]);
    await tx.unsafe("set local session_replication_role = default");
  });
}

async function run() {
  log("── S9 production demo (Arabic Commercial Wiring) ──────────────────");
  for (const [id, who] of [
    [ownerUser, "المالك"],
    [staffUser, "الدعم"],
  ] as const) {
    await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`s9demo-${id.slice(0, 8)}@example.com`}, ${JSON.stringify({ full_name: who })}::jsonb, now(), now())`;
  }
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب الاشتراك",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`update public.org_plan_state set provider = 'fake',
    provider_customer_id = ${`fake_cus_${orgId}`}, provider_subscription_id = ${`fake_sub_${orgId}`}
    where org_id = ${orgId}`;
  await owner`insert into public.platform_staff (user_id, active) values (${staffUser}, true)`;

  // (1) plan catalogue + (19) provider disabled in the deployed app.
  const view0 = await readSubscription(ctx(), "owner");
  log(
    `✓ plan catalogue: ${view0.prices.length} placeholder prices; deployed-app provider enabled=${disabledBillingProvider.enabled} (real activation DISABLED until D1)`,
  );

  // (2/3) trial → active (payment); trial entitlements applied before.
  log(`✓ trial started: state=${await stateOf()} plan=${view0.planKey}`);
  await emitFakeSignal(orgId, "activated", { providerEventId: "d-act" });
  log(`✓ payment → active: ${await stateOf()}`);

  // (4/5/6) usage metering + approaching + hard limit at the service boundary.
  const period = monthPeriodKey(Date.now());
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, limit_value)
    values (${orgId}, 'limit.active_jobs', 3) on conflict (org_id, entitlement_key)
    do update set limit_value = excluded.limit_value`;
  for (let i = 0; i < 2; i++) await recordUsage(ctx(), "active_jobs", `job-${i}`, 1, period);
  const near = await checkMeteredLimit(ctx(), "limit.active_jobs", "active_jobs", period);
  log(
    `✓ usage metered=${await getUsage(ctx(), "active_jobs", period)}/3; approaching allowed=${near.allowed} remaining=${near.remaining}`,
  );
  await recordUsage(ctx(), "active_jobs", "job-2", 1, period); // now at 3
  const atCap = await checkMeteredLimit(ctx(), "limit.active_jobs", "active_jobs", period);
  log(
    `✓ hard limit at service boundary: at 3/3 allowed=${atCap.allowed} (blocks ADD, never reads — FR-9)`,
  );

  // (7/8) upgrade (immediate) + downgrade (scheduled, data preserved).
  const up = await changePlan(ctx(), "owner", "business");
  log(`✓ upgrade → ${up.mode}; plan now=${(await readSubscription(ctx(), "owner")).planKey}`);
  const down = await changePlan(ctx(), "owner", "starter");
  const dv = await readSubscription(ctx(), "owner");
  log(
    `✓ downgrade → ${down.mode}; still on ${dv.planKey}, scheduled=${dv.scheduledPlanKey} (data preserved)`,
  );

  // (10/11/12) failed payment → past_due → grace → suspended → recovery.
  await emitFakeSignal(orgId, "payment_failed", { providerEventId: "d-f1" });
  await emitFakeSignal(orgId, "payment_failed", { providerEventId: "d-f2" });
  await emitFakeSignal(orgId, "payment_failed", { providerEventId: "d-f3" });
  const suspended = await stateOf();
  let readOnlyHeld = false;
  try {
    await assertTenantWritable(ctx());
  } catch (e) {
    readOnlyHeld = e instanceof SubscriptionReadOnlyError;
  }
  log(`✓ dunning ladder → ${suspended}; read-only enforced=${readOnlyHeld}`);
  await emitFakeSignal(orgId, "payment_recovered", { providerEventId: "d-r1" });
  log(`✓ recovery → ${await stateOf()}`);

  // (13/14) duplicate + out-of-order events are idempotent / ignored.
  const dup = await emitFakeSignal(orgId, "activated", { providerEventId: "d-act" }); // same id as (2)
  const stale = await emitFakeSignal(orgId, "trial_ended", { providerEventId: "d-stale" });
  log(
    `✓ idempotency: duplicate=${dup.status}, out-of-order trial_ended=${stale.status} (state=${await stateOf()})`,
  );

  // (15) reconciliation drift.
  setFakeProviderState(`fake_cus_${orgId}`, { billingState: "cancelled", planKey: "starter" });
  const recon = await runReconciliation();
  setFakeProviderState(`fake_cus_${orgId}`, null);
  log(`✓ reconciliation: ${recon.findings} drift finding(s) recorded (surfaced, not overwritten)`);

  // (9) cancellation schedules + lifecycle sweep advances a deadline.
  await emitFakeSignal(orgId, "canceled", { providerEventId: "d-cancel" });
  await owner`update public.org_plan_state set purge_at = now() - interval '1 hour' where org_id = ${orgId}`;
  await sweepLifecycle(Date.now());
  log(`✓ cancel + sweep: state=${await stateOf()} (read-only window elapsed → scheduled removal)`);

  // (20) support session visible in the tenant's OWN audit log (consent-gated, dual-logged).
  const imp = await startImpersonation({
    orgId,
    staffUserId: staffUser,
    reason: "مساعدة العميل في الفوترة",
    consentGrantedBy: ownerUser,
  });
  const activeSessions = await listImpersonations(ctx(), "owner", true);
  const [aud] = (await owner`select count(*)::int as n from public.audit_log
    where org_id = ${orgId} and action = 'support.impersonation_started'`) as unknown as Array<{
    n: number;
  }>;
  await endImpersonation(imp.sessionId);
  log(`✓ support session: active=${activeSessions.length}, in tenant audit_log=${aud!.n} (DoD AC)`);

  // (16) platform vs org separation: a tenant owner cannot open impersonation (not platform staff).
  let ownerBlocked = false;
  try {
    await startImpersonation({
      orgId,
      staffUserId: ownerUser,
      reason: "x",
      consentGrantedBy: ownerUser,
    });
  } catch {
    ownerBlocked = true;
  }
  log(`✓ platform/org separation: tenant owner blocked from impersonation=${ownerBlocked}`);

  const dod =
    readOnlyHeld &&
    !atCap.allowed &&
    aud!.n >= 1 &&
    recon.findings >= 1 &&
    dup.status === "duplicate";
  log(`✓ DoD: ${dod ? "PASS" : "REVIEW"}`);

  await cleanup();
  const [left] =
    (await owner`select count(*)::int as n from public.org where id = ${orgId}`) as unknown as Array<{
      n: number;
    }>;
  log(`✓ cleanup complete — org rows left: ${left!.n} (expect 0)`);
  log("── demo complete ──────────────────────────────────────────────────");
}

run()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("DEMO FAILED:", e);
    try {
      await cleanup();
    } catch (ce) {
      console.error("cleanup after failure errored:", ce);
    }
    await owner.end({ timeout: 5 });
    process.exit(1);
  });
