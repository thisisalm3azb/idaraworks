import { redirect } from "next/navigation";
import Link from "next/link";
import { getInstalledTemplate } from "@/platform/config";
import { getCatalogueEntry } from "@/platform/config/templates";
import { Badge, Card, CardHeader, SubmitButton } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { TEMPLATE_CATALOGUE } from "@/platform/config";
import { startOnboardingAction } from "./actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";
const COUNTRIES = ["AE", "SA", "KW", "BH", "OM", "QA"] as const;

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; again?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "onboarding.run")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const ar = locale === "ar";

  // A workspace that already has its configuration applied is not asked to
  // "set up" again (owner, 2026-09-20). It gets a summary and the places to
  // review or change things; the intake stays one click away for the rare case
  // where somebody really wants to run it again.
  const installed = await getInstalledTemplate(resolved.ctx);
  if (installed && sp.again !== "1") {
    const entry = getCatalogueEntry(installed.key);
    const stages = entry?.manifest.stage_template?.stages ?? [];
    const jobTerm = entry?.manifest.terminology?.job?.[ar ? "ar" : "en"];
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-ink">{t("onboarding.already.title")}</h1>
          <p className="text-sm text-ink-muted">{t("onboarding.already.body")}</p>
        </header>
        <Card>
          <CardHeader
            title={entry ? (ar ? entry.names.ar : entry.names.en) : installed.key}
            meta={<Badge tone="success">{t("onboarding.already.applied")}</Badge>}
          />
          {jobTerm ? (
            <p className="text-sm text-ink">
              {t("onboarding.already.calls_work")}{" "}
              <span className="font-medium">{jobTerm.singular}</span> ·{" "}
              <span className="font-medium">{jobTerm.plural}</span>
            </p>
          ) : null}
          {stages.length > 0 ? (
            <ol className="mt-2 flex flex-wrap gap-1">
              {stages.map((st, i) => (
                <li
                  key={st.stage_key}
                  className="rounded-full bg-sunken px-2 py-1 text-xs text-ink"
                >
                  {i + 1}. {ar ? st.names.ar : st.names.en}
                </li>
              ))}
            </ol>
          ) : null}
        </Card>
        <Card>
          <CardHeader title={t("onboarding.already.next_title")} />
          <ul className="flex flex-col gap-2 text-sm">
            <li>
              <Link
                href={`/o/${orgId}/settings/configuration`}
                className="text-brand hover:underline"
              >
                {t("onboarding.already.review")}
              </Link>
            </li>
            <li>
              <Link href={`/o/${orgId}/settings/branding`} className="text-brand hover:underline">
                {t("onboarding.already.branding")}
              </Link>
            </li>
            <li>
              <Link href={`/o/${orgId}/settings/members`} className="text-brand hover:underline">
                {t("onboarding.already.members")}
              </Link>
            </li>
            <li>
              <Link href={`/o/${orgId}/imports`} className="text-brand hover:underline">
                {t("onboarding.checklist.import")}
              </Link>
            </li>
          </ul>
          <p className="mt-3 text-xs text-ink-muted">
            {t("onboarding.already.again_hint")}{" "}
            <Link href={`/o/${orgId}/onboarding?again=1`} className="text-brand hover:underline">
              {t("onboarding.already.again")}
            </Link>
          </p>
        </Card>
        <Link href={`/o/${orgId}`} className="text-sm text-brand hover:underline">
          {t("onboarding.already.home")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-ink">{t("onboarding.title")}</h1>
        <p className="text-sm text-ink-muted">{t("onboarding.subtitle")}</p>
      </header>
      {sp.error ? <Badge tone="danger">{t(`onboarding.error.${sp.error}`)}</Badge> : null}
      <Card>
        <CardHeader title={t("onboarding.intake.heading")} />
        <form action={startOnboardingAction.bind(null, orgId)} className="flex flex-col gap-3">
          <label className={field}>
            {t("onboarding.intake.business_name")}
            <input name="business_name" required maxLength={120} className={input} />
          </label>
          <label className={field}>
            {t("onboarding.intake.business_description")}
            <textarea
              name="business_description"
              maxLength={600}
              rows={3}
              placeholder={t("onboarding.intake.business_description_placeholder")}
              className={`${input} text-base`}
            />
          </label>
          <p className="text-xs text-ink-muted">
            {t("onboarding.intake.business_description_note")}
          </p>
          <label className={field}>
            {t("onboarding.intake.template_choice")}
            <select name="template_key" defaultValue="" className={input}>
              <option value="">{t("onboarding.intake.template_recommend")}</option>
              {TEMPLATE_CATALOGUE.map((e) => (
                <option key={e.key} value={e.key}>
                  {ar ? e.names.ar : e.names.en}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              {t("onboarding.intake.country")}
              <select name="country" defaultValue="AE" className={input}>
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("onboarding.intake.base_currency")}
              <input name="base_currency" defaultValue="AED" maxLength={3} className={input} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              {t("onboarding.intake.job_term_en")}
              <input
                name="job_term_en"
                maxLength={40}
                placeholder={t("onboarding.intake.job_term_placeholder")}
                className={input}
              />
            </label>
            <label className={field}>
              {t("onboarding.intake.job_term_ar")}
              <input
                name="job_term_ar"
                maxLength={40}
                placeholder={t("onboarding.intake.job_term_placeholder")}
                className={input}
                dir="rtl"
              />
            </label>
          </div>
          <p className="text-xs text-ink-muted">{t("onboarding.intake.job_term_note")}</p>
          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              {t("onboarding.intake.auto_po")}
              <input name="auto_po" type="number" min={0} className={input} inputMode="numeric" />
            </label>
            <label className={field}>
              {t("onboarding.intake.auto_mr")}
              <input name="auto_mr" type="number" min={0} className={input} inputMode="numeric" />
            </label>
          </div>
          <p className="text-xs text-ink-muted">{t("onboarding.intake.auto_note")}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="six_day_week" className="size-5" />
            {t("onboarding.intake.six_day_week")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="vat_registered" defaultChecked className="size-5" />
            {t("onboarding.intake.vat_registered")}
          </label>
          <input type="hidden" name="languages" value="ar" />
          <input type="hidden" name="languages" value="en" />
          <SubmitButton pendingLabel={t("common.submitting")}>
            {t("onboarding.intake.submit")}
          </SubmitButton>
        </form>
      </Card>
    </div>
  );
}
