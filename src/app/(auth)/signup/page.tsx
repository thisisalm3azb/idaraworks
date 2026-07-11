import Link from "next/link";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { t } from "@/platform/i18n/t";
import { signupAction } from "../actions";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.signup.title")}</h1>
          {error ? (
            <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {error === "rate_limited" ? t("auth.login.rate_limited") : t("auth.signup.error")}
            </p>
          ) : null}
          <form action={signupAction} className="flex flex-col gap-4">
            <Field label={t("auth.signup.full_name")} name="full_name" required minLength={2} />
            <Field
              label={t("auth.login.email")}
              name="email"
              type="email"
              autoComplete="email"
              required
            />
            <Field
              label={t("auth.login.password")}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              hint="At least 10 characters."
            />
            <Button type="submit">{t("auth.signup.submit")}</Button>
          </form>
          <p className="mt-4 text-sm text-ink-secondary">
            {t("auth.signup.have_account")}{" "}
            <Link className="font-medium text-brand" href="/login">
              {t("auth.signup.login_link")}
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
