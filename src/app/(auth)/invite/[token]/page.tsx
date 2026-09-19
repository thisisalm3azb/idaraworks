import Link from "next/link";
import { AppShell, Button, Card, SubmitButton } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { peekInviteDetails } from "@/platform/auth/identity";
import { formatDate } from "@/platform/format";
import { acceptInviteAction, switchAccountForInviteAction } from "../../actions";

/**
 * The invitation landing page.
 *
 * Opening the link changes nothing: the invitation is read, never consumed, so
 * a mail scanner's prefetch or a curious click cannot spend it. The page then
 * says what this is — which company, which role, which address it was sent to,
 * when it expires — and offers exactly one next step:
 *   - signed out → sign in or create an account (the invitation is kept in `next`)
 *   - signed in as the invited address → Accept
 *   - signed in as somebody else → switch account (never accept for them)
 *   - already a member → open the workspace
 *   - expired / withdrawn / already used → say so, and who to ask
 */
const ERROR_KEYS: Record<string, string> = {
  invalid: "auth.invite.invalid",
  expired: "auth.invite.expired",
  revoked: "auth.invite.revoked",
  accepted: "auth.invite.accepted",
  mismatch: "auth.invite.mismatch_short",
  seats: "auth.invite.seats",
  rate_limited: "auth.invite.rate_limited",
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getT();
  const { token } = await params;
  const { error } = await searchParams;
  const [user, details] = await Promise.all([getSessionUser(), peekInviteDetails(token)]);
  const next = `/invite/${encodeURIComponent(token)}`;
  const userEmail = user?.email?.toLowerCase() ?? null;
  const mismatch =
    Boolean(user) && Boolean(details?.email) && details!.email!.toLowerCase() !== userEmail;

  const stateCopy =
    details === null
      ? t("auth.invite.invalid")
      : details.state === "expired"
        ? t("auth.invite.expired")
        : details.state === "revoked"
          ? t("auth.invite.revoked")
          : details.state === "accepted"
            ? t("auth.invite.accepted")
            : null;

  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-2 text-lg font-semibold text-ink">
            {details
              ? t("auth.invite.title_org", { org: details.orgName })
              : t("auth.invite.title")}
          </h1>
          {details ? (
            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-muted">{t("auth.invite.role")}</dt>
              <dd className="text-ink">{details.roleKey}</dd>
              {details.email ? (
                <>
                  <dt className="text-ink-muted">{t("auth.invite.sent_to")}</dt>
                  <dd className="text-ink">{maskEmail(details.email)}</dd>
                </>
              ) : null}
              <dt className="text-ink-muted">{t("auth.invite.expires")}</dt>
              <dd className="text-ink">{formatDate(details.expiresAt)}</dd>
            </dl>
          ) : null}

          {error && ERROR_KEYS[error] ? (
            <p role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t(ERROR_KEYS[error]!)}
            </p>
          ) : null}

          {stateCopy ? (
            <div className="flex flex-col gap-3">
              <p role="status" className="rounded-md bg-sunken p-3 text-sm text-ink">
                {stateCopy}
              </p>
              <p className="text-xs text-ink-muted">{t("auth.invite.ask_inviter")}</p>
              {user ? (
                <Link href="/" className="text-sm text-brand hover:underline">
                  {t("auth.invite.go_home")}
                </Link>
              ) : null}
            </div>
          ) : !user ? (
            <div className="flex flex-col gap-2">
              <p className="mb-1 text-sm text-ink-secondary">
                {details?.email
                  ? t("auth.invite.sign_in_with", { email: maskEmail(details.email) })
                  : t("auth.invite.sign_in_hint")}
              </p>
              <Link href={`/login?next=${encodeURIComponent(next)}`}>
                <Button className="w-full">{t("auth.login.title")}</Button>
              </Link>
              <Link href={`/signup?next=${encodeURIComponent(next)}`}>
                <Button variant="secondary" className="w-full">
                  {t("auth.signup.title")}
                </Button>
              </Link>
            </div>
          ) : mismatch ? (
            <div className="flex flex-col gap-3">
              <p role="alert" className="rounded-md bg-warning/10 p-3 text-sm text-ink">
                {t("auth.invite.mismatch", {
                  current: userEmail ?? "",
                  invited: maskEmail(details!.email!),
                })}
              </p>
              <form action={switchAccountForInviteAction}>
                <input type="hidden" name="token" value={token} />
                <SubmitButton className="w-full" pendingLabel={t("common.working")}>
                  {t("auth.invite.switch_account")}
                </SubmitButton>
              </form>
            </div>
          ) : (
            <form action={acceptInviteAction} className="flex flex-col gap-2">
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-ink-secondary">
                {t("auth.invite.accept_as", { email: userEmail ?? "" })}
              </p>
              <SubmitButton className="w-full" pendingLabel={t("auth.invite.accepting")}>
                {t("auth.invite.accept")}
              </SubmitButton>
            </form>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
