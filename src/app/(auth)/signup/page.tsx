import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { languageListFor } from "@/platform/i18n/offered";
import { directionFor } from "@/platform/i18n";
import { sanitizeNext } from "@/platform/auth/callback";
import { oauthEnabled } from "@/platform/auth/oauth";
import { getSessionUser } from "@/platform/auth/resolve";
import { registerAction, resendConfirmationAction, signInWithProviderAction } from "../actions";
import { LanguageToggle } from "../LanguageToggle";
import { AuthGateway } from "./AuthGateway";
import { AuthVisual } from "./AuthVisual";

/**
 * Registration gateway (005B) — the new Get Started destination. An original
 * split-screen: the identity form on one side, an IdaraWorks operational
 * illustration on the other. Signed-out visitors register with email or (when
 * ready) Google; a signed-in visitor is sent straight to their landing rather
 * than re-registering. `next` (an invite/workspace context) is preserved
 * end-to-end and open-redirect-guarded.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNext(sp.next ?? "", "");
  // A signed-in visitor never re-registers — honour an invite/workspace next,
  // otherwise the public homepage.
  const user = await getSessionUser();
  if (user) redirect(next || "/");

  const t = await getT();
  const locale = await getServerLocale();
  const dir = directionFor(locale);
  const oauthOn = oauthEnabled();
  const loginHref = `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1fr_1fr]" dir={dir}>
      {/* Main panel — the priority. */}
      <div className="flex flex-col bg-page">
        <div className="flex min-h-14 items-center justify-between px-5 pt-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse"
            >
              <Icon name="grid" size={16} />
            </span>
            <span>IdaraWorks</span>
          </Link>
          <LanguageToggle />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-8">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {t("auth.gateway.title")}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
              {t("auth.gateway.subtitle", { languages_or: languageListFor(locale, "disjunction") })}
            </p>
            <div className="mt-6">
              <AuthGateway
                oauthOn={oauthOn}
                loginHref={loginHref}
                googleNext={next}
                registerAction={registerAction.bind(null, next)}
                resendAction={resendConfirmationAction.bind(null, next)}
                googleAction={signInWithProviderAction}
                dict={{
                  google: t("auth.gateway.google"),
                  or: t("auth.gateway.or"),
                  full_name: t("auth.signup.full_name"),
                  email: t("auth.gateway.email"),
                  email_hint: t("auth.gateway.email_hint"),
                  password: t("auth.login.password"),
                  password_hint: t("auth.signup.password_hint"),
                  submit: t("auth.gateway.submit"),
                  submitting: t("auth.gateway.submitting"),
                  have_account: t("auth.gateway.have_account"),
                  login: t("auth.login.title"),
                  agree_pre: t("auth.gateway.agree_pre"),
                  terms: t("auth.gateway.terms"),
                  agree_mid: t("auth.gateway.agree_mid"),
                  privacy: t("auth.gateway.privacy"),
                  confirm_title: t("auth.gateway.confirm_title"),
                  confirm_sent_to: t("auth.gateway.confirm_sent_to"),
                  confirm_explain: t("auth.gateway.confirm_explain"),
                  confirm_spam: t("auth.gateway.confirm_spam"),
                  confirm_expired: t("auth.gateway.confirm_expired"),
                  resend: t("auth.gateway.resend"),
                  resend_cooldown: t("auth.gateway.resend_cooldown"),
                  resend_sent: t("auth.gateway.resend_sent"),
                  resend_rate: t("auth.gateway.resend_rate"),
                  change_email: t("auth.gateway.change_email"),
                  verified_already: t("auth.gateway.verified_already"),
                  errors: {
                    invalid: t("auth.gateway.error_invalid"),
                    rate_limited: t("auth.login.rate_limited"),
                    failed: t("auth.gateway.error_failed"),
                  },
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Visual panel — hidden on small screens so the form owns the priority. */}
      <div className="hidden p-3 lg:block">
        <AuthVisual t={t} />
      </div>
    </div>
  );
}
