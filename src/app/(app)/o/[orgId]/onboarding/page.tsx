import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "onboarding.run")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const ar = locale === "ar";

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
          <Button type="submit">{t("onboarding.intake.submit")}</Button>
        </form>
      </Card>
    </div>
  );
}
