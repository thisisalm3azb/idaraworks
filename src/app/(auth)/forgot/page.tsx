import Link from "next/link";
import { AppShell, Button, Card, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { forgotPasswordAction } from "../actions";
import { LanguageToggle } from "../LanguageToggle";

/**
 * Forgot-password (U1 follow-up): email in → reset link out. The success
 * notice is deliberately neutral ("if the account exists…") — this page must
 * never confirm whether an email is registered. Query params are
 * attacker-controlled: only whitelisted keys render, as translated copy.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const t = await getT();
  const { error, notice } = await searchParams;
  return (
    <AppShell brand={<span>IdaraWorks</span>} actions={<LanguageToggle />}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-2 text-lg font-semibold text-ink">{t("auth.forgot.title")}</h1>
          <p className="mb-4 text-sm text-ink-secondary">{t("auth.forgot.help")}</p>
          {notice === "sent" ? (
            <p className="mb-3 rounded-md bg-info-soft p-3 text-sm text-info" role="status">
              {t("auth.forgot.sent")}
            </p>
          ) : null}
          {error === "rate_limited" ? (
            <p role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t("auth.login.rate_limited")}
            </p>
          ) : null}
          <form action={forgotPasswordAction} className="flex flex-col gap-4">
            <Field
              label={t("auth.login.email")}
              name="email"
              type="email"
              autoComplete="email"
              required
            />
            <Button type="submit">{t("auth.forgot.submit")}</Button>
          </form>
          <p className="mt-4 text-sm text-ink-secondary">
            <Link className="font-medium text-brand" href="/login">
              {t("auth.forgot.back")}
            </Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
