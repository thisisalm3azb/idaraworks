/**
 * U4 onboarding draft — the DB half (migration 0073 onboarding_draft): per-USER
 * draft persistence under withUserCtx (no org exists yet; the RLS policy keys on
 * app.current_user_id()), plus the two org-scoped confirm-time appliers that the
 * confirm chain (service.ts runConfirmChain) calls AFTER the explicit confirm:
 * tier-selection recording (app_settings — a recorded choice, never an
 * entitlement change; NO org_addon writes, NO plan changes) and the branding
 * stash application through the real wave-1 branding service.
 *
 * Autosave contract: every wizard step submit upserts the whole draft (data +
 * next step), so refresh/logout/login resume exactly where the founder stopped.
 * No DELETE anywhere (D-1.7): completion flips status; a later flow re-activates.
 */
import { sql, withUserCtx, type Ctx } from "@/platform/tenancy";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";
import {
  BrandingError,
  saveBranding,
  uploadLogo,
  validateLogoBytes,
  checkLogoDimensions,
} from "@/modules/branding/service";
import {
  DraftDataSchema,
  TIER_SETTING_KEY,
  tierSettingValue,
  firstIncompleteStep,
  isFlowStep,
  type ConfirmState,
  type DraftBranding,
  type DraftData,
  type FlowStep,
  type TierSelection,
} from "./flow";

export type OnboardingDraft = {
  userId: string;
  data: DraftData;
  step: FlowStep;
  status: "active" | "completed";
  updatedAt: string;
};

/** Read the caller's own draft (RLS: anyone else's row is invisible). */
export async function getDraft(userId: string): Promise<OnboardingDraft | null> {
  return withUserCtx(userId, async (tx) => {
    const rows = (await tx.execute(sql`
      select user_id::text as user_id, data, step, status, updated_at::text as updated_at
      from public.onboarding_draft where user_id = ${userId}
    `)) as unknown as Array<{
      user_id: string;
      data: unknown;
      step: string;
      status: "active" | "completed";
      updated_at: string;
    }>;
    const r = rows[0];
    if (!r) return null;
    // Tolerant read: a draft written by an older shape falls back to empty
    // (the founder restarts the questionnaire rather than crashing the page).
    const parsed = DraftDataSchema.safeParse(r.data ?? {});
    const data = parsed.success ? parsed.data : DraftDataSchema.parse({});
    const step = isFlowStep(r.step) ? r.step : firstIncompleteStep(data);
    return { userId: r.user_id, data, step, status: r.status, updatedAt: r.updated_at };
  });
}

/** Upsert the draft (zod-validated) — the autosave on every step submit. Always
 * re-activates: a user restarting after completion gets a live draft again. */
export async function saveDraft(
  userId: string,
  input: { data: DraftData; step: FlowStep },
): Promise<void> {
  const data = DraftDataSchema.parse(input.data);
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      insert into public.onboarding_draft (user_id, data, step, status)
      values (${userId}, ${JSON.stringify(data)}::jsonb, ${input.step}, 'active')
      on conflict (user_id) do update
        set data = excluded.data, step = excluded.step, status = 'active'
    `),
  );
}

export async function completeDraft(userId: string): Promise<void> {
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      update public.onboarding_draft set status = 'completed'
      where user_id = ${userId} and status = 'active'
    `),
  );
}

// ── Confirm-chain support (double-submit guard + idempotent progress stash) ──
/**
 * Atomically CLAIM the draft for a confirm run (mirrors the applyOnboarding
 * claim idiom): only one submission wins; a stale claim (>10 min — a serverless
 * kill mid-chain) is reclaimable so retries can finish the chain.
 */
export async function claimDraftConfirm(userId: string): Promise<boolean> {
  return withUserCtx(userId, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.onboarding_draft
      set data = jsonb_set(
            jsonb_set(data, '{confirm}', coalesce(data -> 'confirm', '{}'::jsonb), true),
            '{confirm,claimed_at}', to_jsonb(now()::text), true)
      where user_id = ${userId} and status = 'active'
        and (data #>> '{confirm,claimed_at}' is null
             or (data #>> '{confirm,claimed_at}')::timestamptz < now() - interval '10 minutes')
      returning user_id
    `)) as unknown as Array<{ user_id: string }>;
    return rows.length > 0;
  });
}

/** Release a claim after a failed chain so the founder can retry immediately.
 * Progress stashes (org_id / session_id / applied …) are kept — that is what
 * makes the retry resume instead of duplicating work. */
export async function releaseDraftConfirmClaim(userId: string): Promise<void> {
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      update public.onboarding_draft
      set data = data #- '{confirm,claimed_at}'
      where user_id = ${userId} and status = 'active'
    `),
  );
}

/** Merge confirm-chain progress into the draft (each completed link, at once). */
export async function stashConfirmProgress(
  userId: string,
  patch: Partial<ConfirmState>,
): Promise<void> {
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      update public.onboarding_draft
      set data = jsonb_set(data, '{confirm}',
            coalesce(data -> 'confirm', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true)
      where user_id = ${userId}
    `),
  );
}

// ── Confirm-time appliers (org ctx — AFTER the explicit confirm only) ─────────
/**
 * Record the tier selection in app_settings (the same org key-value store the
 * config pipeline's blob artifacts use; upsert-only — the table has no DELETE
 * grant). This is a RECORDED CHOICE: no org_addon rows, no plan change, no
 * payment — the org starts on the standard trial and paid activation stays on
 * the governed D1 path.
 */
export async function recordTierSelection(ctx: Ctx, tier: TierSelection): Promise<void> {
  const value = tierSettingValue(tier, new Date().toISOString());
  await command(
    ctx,
    {
      audit: {
        action: "onboarding.tier_selected",
        entityType: "org",
        entityId: ctx.orgId,
        summary: `Recorded onboarding subscription choice (${tier.mode}) — no payment collected`,
        after: value,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.app_settings (org_id, key, value)
        values (${ctx.orgId}, ${TIER_SETTING_KEY}, ${JSON.stringify(value)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
      `);
    },
  );
}

/**
 * Apply the branding stash through the REAL wave-1 branding service (validation
 * matrix + VC-4 re-encode + audited writes). The stashed logo is already the
 * processLogo 512px PNG, so uploadLogo's own validation accepts it as a clean
 * PNG and re-encodes once more (bytes are never trusted twice).
 */
export async function applyDraftBranding(
  ctx: Ctx,
  archetype: RoleArchetype,
  branding: DraftBranding,
  fallbackDisplayName: string | null,
): Promise<{ savedFields: boolean; savedLogo: boolean }> {
  const hasFields =
    !!branding.accent_color ||
    !!branding.display_name ||
    !!branding.legal_name ||
    !!branding.footer_details;
  let savedFields = false;
  let savedLogo = false;
  if (hasFields) {
    await saveBranding(ctx, archetype, {
      accentColor: branding.accent_color ?? null,
      displayName: branding.display_name ?? fallbackDisplayName,
      legalName: branding.legal_name ?? null,
      footerDetails: branding.footer_details ?? null,
    });
    savedFields = true;
  }
  if (branding.logo_base64) {
    await uploadLogo(ctx, archetype, {
      fileName: "logo.png",
      mime: "image/png",
      bytes: Buffer.from(branding.logo_base64, "base64"),
    });
    savedLogo = true;
  }
  return { savedFields, savedLogo };
}

// ── Pre-org logo stash (the branding STEP; no org, no storage bucket yet) ─────
/**
 * Validate an uploaded logo with the SAME wave-1 matrix (size → MIME whitelist
 * → magic bytes → decoded dimensions), re-encode through the platform image
 * pipeline (VC-4 — raw upload bytes are never kept), and stash ONLY the 512px
 * main PNG variant base64 in the draft. The real uploadLogo runs at confirm.
 */
export async function stashDraftLogo(
  userId: string,
  input: { mime: string; bytes: Buffer },
): Promise<void> {
  const verdict = validateLogoBytes(input.bytes, input.mime);
  if (!verdict.ok) throw new BrandingError(verdict.error, `logo rejected: ${verdict.error}`);

  // sharp loads lazily (the serverless-trace law the branding service follows).
  const { default: sharp } = await import("sharp");
  const { processLogo } = await import("@/platform/files/image");

  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(input.bytes, { failOn: "error" }).metadata();
  } catch {
    throw new BrandingError("bad_image", "the image could not be decoded");
  }
  const dims = checkLogoDimensions(meta.width, meta.height);
  if (dims) throw new BrandingError(dims, `logo rejected: ${dims}`);

  let processed;
  try {
    processed = await processLogo(input.bytes);
  } catch {
    throw new BrandingError("bad_image", "the image could not be re-encoded");
  }

  const draft = await getDraft(userId);
  if (!draft || draft.status !== "active") {
    throw new BrandingError("invalid_input", "no active onboarding draft");
  }
  const data: DraftData = {
    ...draft.data,
    branding: {
      ...draft.data.branding,
      logo_base64: processed.main.buffer.toString("base64"),
      skipped: undefined,
    },
  };
  await saveDraft(userId, { data, step: draft.step });
}

/** Remove the stashed logo from the draft. */
export async function removeDraftLogo(userId: string): Promise<void> {
  const draft = await getDraft(userId);
  if (!draft || draft.status !== "active") return;
  const branding = { ...draft.data.branding };
  delete branding.logo_base64;
  await saveDraft(userId, { data: { ...draft.data, branding }, step: draft.step });
}
