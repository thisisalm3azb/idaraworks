/**
 * U4 — the first-login experience: the full pre-org onboarding journey.
 * Welcome → questionnaire (business/region/scale/work/needs) → template
 * recommendation → configuration proposal → subscription selection → branding
 * → review → EXPLICIT CONFIRM (org + template application) → dashboard.
 *
 * The draft autosaves on every step submit (migration 0073 onboarding_draft,
 * user-scoped RLS) — refresh/logout/login resume to the saved step; ?step=
 * deep-links are clamped to what the answers actually allow. Users who already
 * have a workspace (e.g. invite acceptors) never see this flow — except a
 * founder whose confirm chain created the org but failed mid-way, who resumes
 * at review to finish honestly.
 */
import { redirect } from "next/navigation";
import { AppShell, Badge } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { getSessionUser, listMyOrgs } from "@/platform/auth/resolve";
import { buildSelectionView } from "@/modules/subscription/service";
import {
  emptyDraftData,
  getDraft,
  resolveStep,
  stepProgressPct,
  stepsRemaining,
  FLOW_STEPS,
  type DraftData,
  type FlowStep,
} from "@/modules/onboarding/service";
import {
  BrandingStep,
  BusinessStep,
  NeedsStep,
  PlanStep,
  ProposalStep,
  RegionStep,
  ReviewStep,
  ScaleStep,
  TemplateStep,
  WelcomeStep,
  WorkStep,
} from "./steps";

const ERROR_CODES = new Set([
  "invalid",
  "custom_empty",
  "no_draft",
  "incomplete",
  "in_progress",
  "failed",
]);

export default async function OnboardingFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const draft = await getDraft(user.id);
  const activeDraft = draft && draft.status === "active" ? draft : null;

  const orgs = await listMyOrgs(user.id);
  if (orgs[0] && !activeDraft?.data.confirm.org_id) {
    // Already a member somewhere (invite acceptors included) — never this flow.
    redirect(`/o/${orgs[0].orgId}`);
  }

  const data: DraftData = activeDraft?.data ?? emptyDraftData();
  // Resume: no explicit ?step= lands on the saved step; both are clamped to the
  // first incomplete screen so half-finished answers can't be skipped past.
  const step: FlowStep = resolveStep(sp.step ?? activeDraft?.step, data);
  // A partially-confirmed draft always resumes at review (the finish screen).
  const effectiveStep: FlowStep = data.confirm.org_id ? "review" : step;

  const t = await getT();
  const locale = await getServerLocale();
  const view = buildSelectionView();
  const idx = FLOW_STEPS.indexOf(effectiveStep);
  const pct = stepProgressPct(effectiveStep);
  const remaining = stepsRemaining(effectiveStep);
  const error = sp.error && ERROR_CODES.has(sp.error) ? sp.error : null;

  const stepProps = { t, locale, data };
  const body = (() => {
    switch (effectiveStep) {
      case "welcome":
        return <WelcomeStep {...stepProps} />;
      case "business":
        return <BusinessStep {...stepProps} />;
      case "region":
        return <RegionStep {...stepProps} />;
      case "scale":
        return <ScaleStep {...stepProps} />;
      case "work":
        return <WorkStep {...stepProps} />;
      case "needs":
        return <NeedsStep {...stepProps} />;
      case "template":
        return <TemplateStep {...stepProps} />;
      case "proposal":
        return <ProposalStep {...stepProps} />;
      case "plan":
        return <PlanStep {...stepProps} view={view} />;
      case "branding":
        return <BrandingStep {...stepProps} />;
      case "review":
        return <ReviewStep {...stepProps} view={view} />;
    }
  })();

  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {effectiveStep !== "welcome" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-ink-muted">
              <span>
                {t("onboarding.flow.progress", {
                  current: idx,
                  total: FLOW_STEPS.length - 1,
                })}
              </span>
              <span dir="ltr" className="font-mono">
                {pct}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-brand transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            {remaining > 0 ? (
              <p className="text-xs text-ink-muted">
                {t("onboarding.flow.remaining", { count: remaining })}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div role="alert">
            <Badge tone="danger">{t(`onboarding.flow.error.${error}`)}</Badge>
          </div>
        ) : null}

        {body}
      </div>
    </AppShell>
  );
}
