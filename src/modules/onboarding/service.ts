/**
 * S8 onboarding pipeline (doc 11 S8): intake → grounded ConfigProposal → validate (incl F-28)
 * → persist session → preview → apply-as-revision (reuses S1 applyConfigChange, undoable) →
 * session undo. Layer-A is deliberately a validator around templates: apply runs the governed
 * installTemplate + config revisions + F-28-capped approval-rule seeds — nothing bypasses the
 * config pipeline. Every mutation is command()+audit; no hard deletes.
 *
 * Trial-abuse (doc 10 #32 / F-26): each proposal generation is METERED into ai_interaction
 * (feature='config_proposal') and hard-capped per org via limit.ai_onboarding_calls; a
 * platform daily AI-spend circuit breaker guards the metered surface.
 */
import { sql, withCtx, createAppDb, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan, type Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { hasFeature, checkLimit } from "@/platform/entitlements/resolve";
import { installTemplate, applyConfigChange, previewConfigChange } from "@/platform/config";
import { undoRevision, ConfigGuardError } from "@/platform/config";
import { createApprovalRule } from "@/modules/approvals/service";
import { getOnboardingProvider } from "./provider";
import { validateProposal } from "./validate";
import { OnboardingIntakeSchema, ConfigProposalSchema, type ConfigProposal } from "./proposal";

// Bind a JS array into an array COLUMN safely. Drizzle interpolates a bare `${jsArray}` as a
// SQL value LIST — `()` for an empty array (a syntax error), `(a,b)` otherwise — never an array
// literal (the S3 week.ts trap). Round-tripping through jsonb yields a real array, empty-safe.
function pgArray(arr: readonly string[], cast: "text" | "uuid") {
  return cast === "uuid"
    ? sql`array(select jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb))::uuid[]`
    : sql`array(select jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb))::text[]`;
}

export class OnboardingError extends Error {}
export class OnboardingCapError extends OnboardingError {}
export class OnboardingValidationError extends OnboardingError {
  constructor(public readonly errors: string[]) {
    super(`ConfigProposal invalid: ${errors.join("; ")}`);
  }
}

/** Platform daily AI-spend circuit breaker (doc 10 #32): today's metered spend across ALL orgs
 * vs a cap. The cross-org aggregate MUST go through a SECURITY DEFINER helper — a bare app_user
 * (NOBYPASSRLS) read is silently zeroed by RLS and fails OPEN (review). The deterministic
 * onboarding provider spends 0, so this is a live guard for a future real provider. */
const DAILY_SPEND_CAP_MICROS = BigInt(process.env.AI_DAILY_SPEND_CAP_MICROS ?? "100000000000");
async function assertSpendBreaker(): Promise<void> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(
      sql`select app.platform_daily_ai_spend() as spent`,
    )) as unknown as Array<{ spent: string }>;
    if (BigInt(rows[0]?.spent ?? "0") >= DAILY_SPEND_CAP_MICROS) {
      throw new OnboardingCapError("platform daily AI-spend cap reached");
    }
  } finally {
    await end();
  }
}

async function onboardingCallsUsed(tx: TenantTx, orgId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n from public.ai_interaction
    where org_id = ${orgId} and feature = 'config_proposal'`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export type StartResult = {
  sessionId: string;
  proposal: ConfigProposal;
  callsRemaining: number | null;
};

/** Generate + persist a validated ConfigProposal from a structured intake. */
export async function startOnboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  rawIntake: unknown,
): Promise<StartResult> {
  assertCan(archetype, "onboarding.run" as Action);
  if (!(await hasFeature(ctx, "feat.ai_onboarding"))) {
    throw new OnboardingError("onboarding is not enabled for this organization");
  }
  const intake = OnboardingIntakeSchema.parse(rawIntake);

  // Per-org onboarding-call cap (trial abuse) + platform circuit breaker.
  const used = await withCtx(ctx, (tx) => onboardingCallsUsed(tx, ctx.orgId));
  const room = await checkLimit(ctx, "limit.ai_onboarding_calls", used);
  if (!room.allowed)
    throw new OnboardingCapError("onboarding call cap reached for this organization");
  await assertSpendBreaker();

  // Deterministic grounding (no AI creds required) + hard proposal validation (F-28 etc.).
  const { proposal, provider } = await getOnboardingProvider().propose(intake);
  const verdict = validateProposal(proposal);
  if (!verdict.ok) throw new OnboardingValidationError(verdict.errors);

  return command<StartResult>(
    ctx,
    {
      audit: (r) => ({
        action: "onboarding.propose",
        entityType: "onboarding_session",
        entityId: r.sessionId,
        summary: `Onboarding proposal generated (${provider})`,
      }),
    },
    async (tx) => {
      // Meter the (free, capped) generation — append-only, so the cap counts it.
      await tx.execute(sql`
        insert into public.ai_interaction
          (org_id, feature, provider, credits, cost_micros, validator_verdict, status, subject_type, created_by)
        values (${ctx.orgId}, 'config_proposal', ${provider}, 1, 0, 'na', 'ok', 'onboarding_session', ${ctx.userId})`);
      const rows = (await tx.execute(sql`
        insert into public.onboarding_session
          (org_id, status, template_key, intake, proposal, requires_upgrade, created_by)
        values (${ctx.orgId}, 'proposed', ${proposal.template_key}, ${JSON.stringify(intake)}::jsonb,
                ${JSON.stringify(proposal)}::jsonb, ${pgArray(proposal.requires_upgrade, "text")}, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      return {
        sessionId: rows[0]!.id,
        proposal,
        callsRemaining: room.limit === null ? null : Math.max(0, room.limit - used - 1),
      };
    },
  );
}

export type OnboardingSession = {
  id: string;
  status: string;
  templateKey: string;
  intake: Record<string, unknown>;
  proposal: ConfigProposal | null;
  requiresUpgrade: string[];
  appliedRevisionIds: string[];
};

export async function getOnboardingSession(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<OnboardingSession | null> {
  assertCan(archetype, "onboarding.run" as Action);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, status, template_key, intake, proposal, requires_upgrade,
             applied_revision_ids
      from public.onboarding_session where org_id = ${ctx.orgId} and id = ${id}`)) as unknown as Array<
      Record<string, unknown>
    >;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      status: r.status as string,
      templateKey: r.template_key as string,
      intake: (r.intake as Record<string, unknown>) ?? {},
      proposal: (r.proposal as ConfigProposal | null) ?? null,
      requiresUpgrade: ((r.requires_upgrade as string[]) ?? []).map(String),
      appliedRevisionIds: ((r.applied_revision_ids as string[]) ?? []).map(String),
    };
  });
}

/** Preview the config the proposal's OVERRIDE artifacts will apply (diffs; install is separate). */
export async function previewOnboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  sessionId: string,
): Promise<{ artifactKey: string; diff: unknown }[]> {
  assertCan(archetype, "onboarding.run" as Action);
  const session = await getOnboardingSession(ctx, archetype, sessionId);
  if (!session?.proposal) throw new OnboardingError("no proposal to preview");
  const out: { artifactKey: string; diff: unknown }[] = [];
  for (const art of session.proposal.artifacts) {
    if (art.key === "config.template" || art.key === "terminology.template") continue;
    const preview = await previewConfigChange(ctx, art.key, art.value);
    out.push({ artifactKey: art.key, diff: preview });
  }
  return out;
}

export type ApplyResult = { revisionIds: string[]; rulesCreated: number; installed: boolean };

/** Apply the proposal: install template #1 (base), apply override artifacts as aiFlag
 * revisions, seed F-28-capped approval defaults. Idempotent-ish: re-apply is blocked by status. */
export async function applyOnboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  sessionId: string,
): Promise<ApplyResult> {
  assertCan(archetype, "onboarding.run" as Action);
  assertCan(archetype, "config.manage" as Action);
  const session = await getOnboardingSession(ctx, archetype, sessionId);
  if (!session) throw new OnboardingError("session not found");
  if (session.status === "applied")
    throw new OnboardingError("this onboarding was already applied");
  const proposal = ConfigProposalSchema.parse(session.proposal); // re-validate shape
  const verdict = validateProposal(proposal);
  if (!verdict.ok) throw new OnboardingValidationError(verdict.errors);

  const revisionIds: string[] = [];
  let installed = false;
  if (proposal.install_template) {
    const res = await installTemplate(ctx, proposal.template_key);
    revisionIds.push(...res.revisionIds);
    installed = res.revisionIds.length > 0;
  }
  for (const art of proposal.artifacts) {
    if (art.key === "config.template" || art.key === "terminology.template") continue;
    const { revisionId } = await applyConfigChange(ctx, art.key, art.value, {
      aiFlag: true,
      summary: `Onboarding: ${art.rationale_en}`,
    });
    revisionIds.push(revisionId);
  }
  // Seed F-28-capped approval defaults as approval rules (governed service). The intake asks
  // "auto-approve BELOW X" — the S4 engine implements that with an `always` rule carrying
  // auto_approve_below_minor = X (review): a submitted subject ALWAYS matches, and the engine
  // auto-approves when amount < X, else routes to the manager. (An `amount_gte X` rule does the
  // OPPOSITE — it never auto-approves below-X and only matches at/above X — so it is wrong here.)
  let rulesCreated = 0;
  for (const d of proposal.approval_defaults) {
    await createApprovalRule(ctx, archetype, {
      subjectType: d.subject_type,
      conditionKind: "always",
      autoApproveBelowMinor: d.auto_approve_below_minor,
      assignedRole: "manager",
    });
    rulesCreated++;
  }

  await command(
    ctx,
    {
      audit: {
        action: "onboarding.apply",
        entityType: "onboarding_session",
        entityId: sessionId,
        summary: `Applied onboarding proposal (${revisionIds.length} revisions, ${rulesCreated} rules)`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.onboarding_session
        set status = 'applied', applied_revision_ids = ${pgArray(revisionIds, "uuid")}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${sessionId}`);
    },
  );
  return { revisionIds, rulesCreated, installed };
}

/** Session undo: revert the applied CONFIG revisions in reverse (restores config). Approval
 * rules + any first job the operator created are operational objects, managed normally. */
export async function undoOnboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  sessionId: string,
): Promise<{ undone: number; retained: number }> {
  assertCan(archetype, "onboarding.run" as Action);
  assertCan(archetype, "config.manage" as Action);
  const session = await getOnboardingSession(ctx, archetype, sessionId);
  if (!session) throw new OnboardingError("session not found");
  if (session.status !== "applied")
    throw new OnboardingError("only an applied onboarding can be undone");
  // Best-effort reverse undo: revert every revision the config pipeline permits. Some
  // artifacts are irreversible BY DESIGN — a custom field, once defined, can only be RETIRED,
  // not removed (D-9.2 ConfigGuardError). We honour that guard: such revisions are RETAINED
  // (the field stays, retired if edited later) rather than forced. The install MARKER
  // (config.template) is unguarded, so it always reverts → the org returns to un-onboarded.
  let undone = 0;
  let retained = 0;
  for (const revId of [...session.appliedRevisionIds].reverse()) {
    try {
      await undoRevision(ctx, revId);
      undone++;
    } catch (err) {
      if (err instanceof ConfigGuardError) {
        retained++;
        continue;
      }
      throw err;
    }
  }
  await command(
    ctx,
    {
      audit: {
        action: "onboarding.undo",
        entityType: "onboarding_session",
        entityId: sessionId,
        summary: `Undid onboarding (${undone} reverted, ${retained} retained by config guards)`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.onboarding_session set status = 'dismissed', updated_at = now()
        where org_id = ${ctx.orgId} and id = ${sessionId}`);
    },
  );
  return { undone, retained };
}
