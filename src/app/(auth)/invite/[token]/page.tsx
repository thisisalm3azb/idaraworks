import Link from "next/link";
import { AppShell, Button, Card } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { acceptInviteAction } from "../../actions";

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
  const user = await getSessionUser();
  const next = `/invite/${encodeURIComponent(token)}`;
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <Card>
          <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.invite.title")}</h1>
          {error ? (
            <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t("auth.invite.invalid")}
            </p>
          ) : null}
          {user ? (
            <form action={acceptInviteAction}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" className="w-full">
                {t("auth.invite.accept")}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-2">
              <Link href={`/login?next=${encodeURIComponent(next)}`}>
                <Button className="w-full">{t("auth.login.title")}</Button>
              </Link>
              <Link href={`/signup?next=${encodeURIComponent(next)}`}>
                <Button variant="secondary" className="w-full">
                  {t("auth.signup.title")}
                </Button>
              </Link>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
