/**
 * H15 — the Intelligent Clay onboarding journey (first-login, pre-org).
 * Welcome → about your business → customers → delivery → team → materials
 * (branched) → money → priorities → template + terminology → plan → branding
 * → review (the workspace proposal, editable) → EXPLICIT CONFIRM (org +
 * template + H14 blueprint lifecycle) → workspace.
 *
 * The draft autosaves on every step submit (0073 onboarding_draft, user-scoped
 * RLS) with an optimistic two-tab guard; refresh/logout/login resume to the
 * saved step; ?step= deep-links are clamped to what the answers allow. Users
 * who already have a workspace (invite acceptors) never see this flow — except
 * a founder whose confirm chain created the org but failed mid-way, who
 * resumes at review to finish honestly.
 */
import { redirect } from "next/navigation";
import { AppShell, Badge } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { LanguageToggle } from "../LanguageToggle";
import { getSessionUser, listMyOrgs } from "@/platform/auth/resolve";
import { buildSelectionView } from "@/modules/subscription/service";
import {
  emptyDraftData,
  getDraft,
  resolveStep,
  sectionForStep,
  stepNumberOf,
  stepProgressPct,
  type DraftData,
  type FlowStep,
} from "@/modules/onboarding/service";
import {
  BrandingStep,
  BusinessStep,
  CustomersStep,
  MaterialsStep,
  MoneyStep,
  PlanStep,
  PrioritiesStep,
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
  "stale_tab",
]);

export default async function OnboardingFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string; retired?: string; saved?: string }>;
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
  const pct = stepProgressPct(effectiveStep, data.answers);
  const stepNo = stepNumberOf(effectiveStep, data.answers);
  const error = sp.error && ERROR_CODES.has(sp.error) ? sp.error : null;
  const retired = (sp.retired ?? "")
    .split(",")
    .filter((k) => /^[a-z_]{2,40}$/.test(k))
    .slice(0, 6);
  const saved = sp.saved === "1";
  const draftRev = activeDraft?.updatedAt ?? "";

  const currentSection = sectionForStep(effectiveStep);

  const stepProps = { t, locale, data, draftRev };
  const body = (() => {
    switch (effectiveStep) {
      case "welcome":
        return <WelcomeStep {...stepProps} />;
      case "business":
        return <BusinessStep {...stepProps} />;
      case "region":
        return <RegionStep {...stepProps} />;
      case "customers":
        return <CustomersStep {...stepProps} />;
      case "work":
        return <WorkStep {...stepProps} />;
      case "scale":
        return <ScaleStep {...stepProps} />;
      case "materials":
        return <MaterialsStep {...stepProps} />;
      case "money":
        return <MoneyStep {...stepProps} />;
      case "priorities":
        return <PrioritiesStep {...stepProps} />;
      case "template":
        return <TemplateStep {...stepProps} />;
      case "proposal":
        return <ProposalStep {...stepProps} />;
      case "plan":
        return <PlanStep {...stepProps} view={view} />;
      case "branding":
        return <BrandingStep {...stepProps} />;
      case "review":
        return <ReviewStep {...stepProps} view={view} saved={saved} />;
    }
  })();

  // The plan step shows four side-by-side tier cards — it needs the full width
  // the settings page has; every other step is a single-column form.
  const wide = effectiveStep === "plan";

  return (
    <AppShell brand={<span>IdaraWorks</span>} actions={<LanguageToggle />}>
      <div className={`mx-auto flex w-full flex-col gap-4 ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
        {effectiveStep !== "welcome" ? (
          <div className="flex flex-col gap-1.5">
            {/* H15.1: ONE progress model — the section as the page heading,
                "Step X of Y" over the currently visible journey, one bar. */}
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="text-lg font-semibold text-ink">
                {currentSection ? t(`onboarding.flow.section.${currentSection}`) : ""}
              </h1>
              <span className="text-xs text-ink-muted">
                {t("onboarding.flow.progress", {
                  current: stepNo.current,
                  total: stepNo.total,
                })}
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={stepNo.current}
              aria-valuemin={1}
              aria-valuemax={stepNo.total}
              aria-valuetext={t("onboarding.flow.progress", {
                current: stepNo.current,
                total: stepNo.total,
              })}
              aria-label={t("onboarding.flow.progress_label")}
              className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
            >
              <div
                className="h-full rounded-full bg-brand motion-safe:transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            {/* Calm autosave indicator (Part E): announced to screen readers. */}
            {draftRev ? (
              <p role="status" aria-live="polite" className="text-end text-xs text-ink-muted">
                {t("onboarding.flow.saved_note")}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div role="alert">
            <Badge tone="danger">{t(`onboarding.flow.error.${error}`)}</Badge>
          </div>
        ) : null}

        {retired.length > 0 ? (
          <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
            {t("onboarding.flow.retired_note", {
              items: retired
                .map((k) => t(`onboarding.journey.answer_name.${k}`))
                .join(locale === "ar" ? "، " : ", "),
            })}
          </p>
        ) : null}

        {body}
      </div>
    </AppShell>
  );
}
