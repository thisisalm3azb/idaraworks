import { redirect } from "next/navigation";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { CURRENCY_CODES } from "@/platform/registries";
import { createOrgAction } from "../actions";

const COUNTRIES = [
  ["AE", "United Arab Emirates"],
  ["SA", "Saudi Arabia"],
  ["QA", "Qatar"],
  ["KW", "Kuwait"],
  ["BH", "Bahrain"],
  ["OM", "Oman"],
  ["US", "United States"],
  ["GB", "United Kingdom"],
] as const;

export default async function OnboardingPage() {
  const t = await getT();
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-md">
        <Card>
          <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.onboarding.title")}</h1>
          <form action={createOrgAction} className="flex flex-col gap-4">
            <Field label={t("auth.onboarding.org_name")} name="name" required minLength={2} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="country" className="text-sm font-medium text-ink">
                {t("auth.onboarding.country")}
              </label>
              <select
                id="country"
                name="country"
                required
                defaultValue="AE"
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="base_currency" className="text-sm font-medium text-ink">
                {t("auth.onboarding.currency")}
              </label>
              <select
                id="base_currency"
                name="base_currency"
                required
                defaultValue="AED"
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="six_day" className="size-4" />
              {t("auth.onboarding.six_day")}
            </label>
            <Button type="submit">{t("auth.onboarding.submit")}</Button>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
