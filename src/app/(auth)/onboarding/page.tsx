/**
 * The founder's first-login setup (pre-org): four short screens.
 * Your business → how you work → what matters now → ready. The EXPLICIT confirm
 * on the last screen creates the organisation, applies the chosen template
 * and the blueprint, records the choices, and opens the workspace.
 *
 * The draft autosaves on every step submit (0073 onboarding_draft, user-scoped
 * RLS) with an optimistic two-tab guard; refresh/logout/login resume to the
 * saved screen; ?step= deep-links are clamped to what the answers allow. Users
 * who already have a workspace (invite acceptors) never see this flow — except
 * a founder whose confirm chain created the org but failed mid-way, who
 * resumes at the ready screen to finish honestly.
 */
import { redirect } from "next/navigation";
import { AppShell, Badge } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { LanguageToggle } from "../LanguageToggle";
import { getSessionUser, listMyOrgs } from "@/platform/auth/resolve";
import {
  emptyDraftData,
  getDraft,
  resolveStep,
  stepNumberOf,
  stepProgressPct,
  type DraftData,
  type FlowStep,
} from "@/modules/onboarding/service";
import { BusinessScreen, PrioritiesScreen, ReadyScreen, SetupScreen } from "./screens";

const ERROR_CODES = new Set([
  "invalid",
  "no_draft",
  "incomplete",
  "in_progress",
  "failed",
  "stale_tab",
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
  // A partially-confirmed draft always resumes at the finish screen.
  const effectiveStep: FlowStep = data.confirm.org_id ? "ready" : step;

  const t = await getT();
  const locale = await getServerLocale();
  const pct = stepProgressPct(effectiveStep, data.answers);
  const stepNo = stepNumberOf(effectiveStep, data.answers);
  const error = sp.error && ERROR_CODES.has(sp.error) ? sp.error : null;
  const draftRev = activeDraft?.updatedAt ?? "";

  const props = { t, locale, data, draftRev };
  const body = (() => {
    switch (effectiveStep) {
      case "business":
        return <BusinessScreen {...props} />;
      case "setup":
        return <SetupScreen {...props} />;
      case "priorities":
        return <PrioritiesScreen {...props} />;
      case "ready":
        return <ReadyScreen {...props} />;
    }
  })();

  return (
    <AppShell brand={<span>IdaraWorks</span>} actions={<LanguageToggle />}>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-xl font-semibold text-ink">
              {t(`onb.step.${effectiveStep}.title`)}
            </h1>
            <span className="text-xs text-ink-muted">
              {t("onboarding.flow.progress", { current: stepNo.current, total: stepNo.total })}
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
          {draftRev ? (
            <p role="status" aria-live="polite" className="text-end text-xs text-ink-muted">
              {t("onboarding.flow.saved_note")}
            </p>
          ) : null}
        </div>

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
