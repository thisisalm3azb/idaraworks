import Link from "next/link";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { loginAction, signInWithProviderAction } from "../actions";
import { oauthEnabled } from "@/platform/auth/oauth";

// Whitelisted query-param → i18n-key maps (params are attacker-controlled; only
// known values render, and only as translated copy). Unknown notices render
// nothing; unknown errors fall back to the generic auth.login.error.
const NOTICE_KEYS: Record<string, string> = {
  confirm_email: "auth.login.confirm_email",
  already_confirmed: "auth.login.already_confirmed",
};
const ERROR_KEYS: Record<string, string> = {
  rate_limited: "auth.login.rate_limited",
  confirm_missing: "auth.login.confirm_missing",
  confirm_invalid: "auth.login.confirm_invalid",
};

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
          {notice && NOTICE_KEYS[notice] ? (
            <p className="mb-3 rounded-md bg-info-soft p-3 text-sm text-info" role="status">
              {t(NOTICE_KEYS[notice])}
            </p>
          ) : null}
          {error ? (
            <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t(ERROR_KEYS[error] ?? "auth.login.error")}
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
          {oauthEnabled() ? (
            <div className="mt-4 flex flex-col gap-2">
              <p className="text-center text-xs text-ink-muted">
                {t("auth.login.or_continue_with")}
              </p>
              <form action={signInWithProviderAction}>
                <input type="hidden" name="provider" value="google" />
                <Button type="submit" variant="secondary" className="w-full">
                  {t("auth.login.google")}
                </Button>
              </form>
              <form action={signInWithProviderAction}>
                <input type="hidden" name="provider" value="azure" />
                <Button type="submit" variant="secondary" className="w-full">
                  {t("auth.login.microsoft")}
                </Button>
              </form>
            </div>
          ) : null}
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
