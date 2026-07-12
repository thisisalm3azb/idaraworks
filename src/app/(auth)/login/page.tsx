import Link from "next/link";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { loginAction } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const t = await getT();
  const { error, notice } = await searchParams;
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.login.title")}</h1>
          {notice === "confirm_email" ? (
            <p className="mb-3 rounded-md bg-info-soft p-3 text-sm text-info">
              Check your inbox to confirm your email, then sign in.
            </p>
          ) : null}
          {error ? (
            <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {error === "rate_limited" ? t("auth.login.rate_limited") : t("auth.login.error")}
            </p>
          ) : null}
          <form action={loginAction} className="flex flex-col gap-4">
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
              autoComplete="current-password"
              required
            />
            <Button type="submit">{t("auth.login.submit")}</Button>
          </form>
          <p className="mt-4 text-sm text-ink-secondary">
            {t("auth.login.no_account")}{" "}
            <Link className="font-medium text-brand" href="/signup">
              {t("auth.login.signup_link")}
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
