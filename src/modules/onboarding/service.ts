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
import { createOrgForUser } from "@/platform/auth/identity";
import { createApprovalRule } from "@/modules/approvals/service";
import { getOnboardingProvider } from "./provider";
import { validateProposal } from "./validate";
import { OnboardingIntakeSchema, ConfigProposalSchema, type ConfigProposal } from "./proposal";
import { draftToIntake, DraftIncompleteError, type ConfirmState } from "./flow";
import {
  applyDraftBranding,
  claimDraftConfirm,
  completeDraft,
  getDraft,
  recordTierSelection,
  releaseDraftConfirmClaim,
  stashConfirmProgress,
} from "./draft";

// ── U4 pre-org flow public surface (BUILD_BIBLE §3.2: service.ts is the module's
// only public surface — the app layer imports the draft/flow API through here). ──
export {
  getDraft,
  saveDraft,
  completeDraft,
  recordTierSelection,
  applyDraftBranding,
  stashDraftLogo,
  removeDraftLogo,
  type OnboardingDraft,
} from "./draft";
export {
  FLOW_STEPS,
  isFlowStep,
  nextStepAfter,
  prevStepBefore,
  stepProgressPct,
  stepsRemaining,
  stepComplete,
  firstIncompleteStep,
  resolveStep,
  applyStepAnswers,
  emptyDraftData,
  recommendationForDraft,
  buildClassifierText,
  draftToIntake,
  buildReviewSummary,
  reviewMonthlyMinor,
  effectiveUsersBand,
  effectiveCustomerSharing,
  askUsersBand,
  askDepartments,
  askWorkflowDescription,
  askCustomerSharing,
  DraftDataSchema,
  DraftAnswersSchema,
  TierSelectionSchema,
  DraftBrandingSchema,
  FlowValidationError,
  DraftIncompleteError,
  TIER_SETTING_KEY,
  INDUSTRIES,
  EMPLOYEE_BANDS,
  USER_BANDS,
  LOCATION_BANDS,
  DEPARTMENTS,
  WORK_PATTERNS,
  WORK_INTAKE,
  CAPABILITY_CHIPS,
  DEVICES,
  COUNTRY_DEFAULTS,
  FLOW_CURRENCIES,
  FLOW_TIMEZONES,
  type DraftData,
  type DraftAnswers,
  type TierSelection,
  type DraftBranding,
  type FlowStep,
  type FlowRecommendation,
  type ReviewSummary,
} from "./flow";
export { selectTemplate, buildGroundedProposal } from "./provider";
export { validateProposal } from "./validate";

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

  // S10 concurrency: atomically CLAIM the session (→ 'applying') before doing any work, so a
  // double-tapped Apply or two admin devices can't both run the install + revisions + rule seeds
  // (which produced duplicate revisions and raced the approval-rule ambiguity guard). Only one
  // claimant wins the guarded UPDATE; the loser sees 0 rows and bails.
  // Claim 'draft'/'proposed' OR RECLAIM a STALE 'applying' (review fix): a serverless kill/timeout
  // between the claim commit and the final 'applied' write can strand a session in 'applying' with
  // no in-app recovery. A row stuck there for >10 min is presumed abandoned and reclaimable, so a
  // retry can complete (config revisions are convergent — preset ids reuse; rules are 23505-guarded).
  const claimed = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.onboarding_session set status = 'applying', updated_at = now()
      where org_id = ${ctx.orgId} and id = ${sessionId}
        and (status in ('draft', 'proposed')
             or (status = 'applying' and updated_at < now() - interval '10 minutes'))
      returning id`)) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  });
  if (!claimed)
    throw new OnboardingError("this onboarding is already being applied or was applied");

  const revisionIds: string[] = [];
  let rulesCreated = 0;
  let installed = false;
  try {
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
    for (const d of proposal.approval_defaults) {
      await createApprovalRule(ctx, archetype, {
        subjectType: d.subject_type,
        conditionKind: "always",
        autoApproveBelowMinor: d.auto_approve_below_minor,
        assignedRole: "manager",
      });
      rulesCreated++;
    }
  } catch (err) {
    // Release the claim so a corrected retry can run (best-effort; the already-applied config
    // revisions are reverted by undoOnboarding if the operator abandons the session).
    await withCtx(ctx, (tx) =>
      tx.execute(sql`
        update public.onboarding_session set status = 'proposed', updated_at = now()
        where org_id = ${ctx.orgId} and id = ${sessionId} and status = 'applying'`),
    ).catch(() => {});
    throw err;
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

// ── U4: the confirm chain (pre-org flow → real workspace) ─────────────────────
export type ConfirmChainErrorCode = "no_draft" | "incomplete" | "in_progress" | "failed";

export class ConfirmChainError extends OnboardingError {
  constructor(
    public readonly code: ConfirmChainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfirmChainError";
  }
}

export type ConfirmChainResult = { orgId: string; alreadyCompleted: boolean };

/**
 * THE single confirm action's engine (U4 §8): sequential + idempotent. Nothing
 * before this ran against an org — the org creation, the template application
 * (the ONLY one), the tier recording (app_settings; a recorded choice — no
 * org_addon writes, no plan change, no payment) and the branding save all
 * happen HERE, after the founder's explicit confirm.
 *
 * Idempotency: a per-draft claim (status-guarded, stale-reclaimable) blocks
 * double submits; every completed link is stashed in the draft's confirm state,
 * so a failure mid-chain (e.g. org created, template apply failed) is safe to
 * retry — the next confirm resumes at the first unfinished link instead of
 * creating a second org or re-applying the template.
 *
 * The creator is the org OWNER by construction (app.create_org_with_owner seeds
 * the owner membership with cost+price privileges), so the chain runs under an
 * owner ctx without a cookie-bound session — which also makes it directly
 * integration-testable as a function.
 */
export async function runConfirmChain(userId: string): Promise<ConfirmChainResult> {
  const draft = await getDraft(userId);
  if (!draft) throw new ConfirmChainError("no_draft", "no onboarding draft to confirm");
  if (draft.status === "completed") {
    if (draft.data.confirm.org_id) {
      return { orgId: draft.data.confirm.org_id, alreadyCompleted: true };
    }
    throw new ConfirmChainError("no_draft", "draft already completed without an organization");
  }
  if (!draft.data.tier) {
    throw new ConfirmChainError("incomplete", "no subscription choice was made");
  }
  // Validate the full intake BEFORE claiming — an incomplete draft never claims.
  let intake;
  try {
    intake = draftToIntake(draft.data);
  } catch (err) {
    if (err instanceof DraftIncompleteError) {
      throw new ConfirmChainError("incomplete", err.message);
    }
    throw err;
  }

  const claimed = await claimDraftConfirm(userId);
  if (!claimed) {
    throw new ConfirmChainError("in_progress", "workspace creation is already running");
  }

  // Local mirror of the stash so each link sees prior progress without re-reads.
  const confirm: ConfirmState = { ...draft.data.confirm };
  const stash = async (patch: Partial<ConfirmState>) => {
    Object.assign(confirm, patch);
    await stashConfirmProgress(userId, patch);
  };

  try {
    // 1 — organization (existing bootstrap; resumed if a previous run got here).
    let orgId = confirm.org_id;
    if (!orgId) {
      orgId = await createOrgForUser(userId, {
        name: intake.business_name,
        country: intake.country,
        baseCurrency: intake.base_currency,
        timezone: draft.data.answers.timezone ?? "Asia/Dubai",
        languages: intake.languages,
        sixDayWeek: intake.six_day_week,
      });
      await stash({ org_id: orgId });
    }
    const ctx: Ctx = {
      orgId,
      userId,
      costPrivileged: true, // the owner role seeded by create_org_with_owner
      pricePrivileged: true,
      requestId: "onboarding-confirm",
    };

    // 2 — template application through the governed S8 pipeline (the ONLY
    // application; config.template is absent until this point).
    if (!confirm.applied) {
      let sessionId = confirm.session_id;
      if (!sessionId) {
        const started = await startOnboarding(ctx, "owner", intake);
        sessionId = started.sessionId;
        await stash({ session_id: sessionId });
      }
      try {
        await applyOnboarding(ctx, "owner", sessionId);
      } catch (err) {
        // A prior run may have applied but died before stashing — that is success.
        if (!(err instanceof OnboardingError && /already applied/i.test(err.message))) throw err;
      }
      await stash({ applied: true });
    }

    // 3 — record the tier selection (app_settings only — never entitlements).
    if (!confirm.tier_recorded) {
      await recordTierSelection(ctx, draft.data.tier);
      await stash({ tier_recorded: true });
    }

    // 4 — branding stash through the real service (skippable; may be empty).
    if (!confirm.branding_saved) {
      await applyDraftBranding(
        ctx,
        "owner",
        draft.data.branding,
        draft.data.answers.business_name ?? null,
      );
      await stash({ branding_saved: true });
    }

    // 5 — close the draft. The claim marker stays on the completed row as the
    // record of when the chain ran; completed drafts are never claimed again.
    await completeDraft(userId);
    return { orgId, alreadyCompleted: false };
  } catch (err) {
    // Release the claim so the founder can retry; progress stashes are kept —
    // the retry resumes exactly at the failed link (honest, no duplication).
    await releaseDraftConfirmClaim(userId).catch(() => {});
    if (err instanceof ConfirmChainError) throw err;
    throw new ConfirmChainError(
      "failed",
      `workspace setup did not finish: ${(err as Error).message}`,
    );
  }
}
