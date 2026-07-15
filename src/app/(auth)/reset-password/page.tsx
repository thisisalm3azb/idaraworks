import { redirect } from "next/navigation";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { PASSWORD_MIN_LENGTH } from "@/platform/auth/password";
import { resetPasswordAction } from "../actions";
import { LanguageToggle } from "../LanguageToggle";

// Whitelisted error keys (params are attacker-controlled — only known values
// render, as translated copy; the action re-validates server-side regardless).
const ERROR_KEYS: Record<string, string> = {
  too_short: "auth.reset.error.too_short",
  mismatch: "auth.reset.error.mismatch",
  failed: "auth.reset.error.failed",
};

/**
 * Set-new-password (U1 follow-up): SESSION-REQUIRED — the recovery link's code
 * was exchanged into a session by /auth/callback; landing here without one
 * means the link expired or was already used.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?error=recovery_expired");
  const t = await getT();
  const { error } = await searchParams;
  return (
    <AppShell brand={<span>IdaraWorks</span>} actions={<LanguageToggle />}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.reset.title")}</h1>
          {error && ERROR_KEYS[error] ? (
            <p role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t(ERROR_KEYS[error])}
            </p>
          ) : null}
          <form action={resetPasswordAction} className="flex flex-col gap-4">
            <Field
              label={t("auth.reset.password")}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              hint={t("auth.signup.password_hint")}
            />
            <Field
              label={t("auth.reset.confirm")}
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
            />
            <Button type="submit">{t("auth.reset.submit")}</Button>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
