import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { getServerLocale } from "@/platform/i18n/server";
import { logoutAction, signOutOtherDevicesAction, changeLanguageAction } from "../actions";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const t = await getT();
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { notice } = await searchParams;
  const locale = await getServerLocale();
  const noticeText =
    notice === "others_signed_out"
      ? t("auth.account.others_signed_out")
      : notice === "language_changed"
        ? t("auth.account.language_changed")
        : null;
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <Card>
          <CardHeader title={t("auth.account.title")} meta={user.email ?? undefined} />
          {noticeText ? (
            <p className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success" role="status">
              {noticeText}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Link href="/mfa">
              <Button variant="secondary" className="w-full">
                {t("auth.mfa.title")}
              </Button>
            </Link>
            <form action={signOutOtherDevicesAction}>
              <Button type="submit" variant="secondary" className="w-full">
                {t("auth.account.sign_out_others")}
              </Button>
            </form>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" className="w-full">
                {t("auth.account.sign_out")}
              </Button>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("auth.account.language")} />
          <div className="flex gap-2">
            <form action={changeLanguageAction} className="flex-1">
              <input type="hidden" name="locale" value="en" />
              <Button
                type="submit"
                variant={locale === "en" ? "primary" : "secondary"}
                className="w-full"
                aria-pressed={locale === "en"}
              >
                English
              </Button>
            </form>
            <form action={changeLanguageAction} className="flex-1">
              <input type="hidden" name="locale" value="ar" />
              <Button
                type="submit"
                variant={locale === "ar" ? "primary" : "secondary"}
                className="w-full"
                aria-pressed={locale === "ar"}
              >
                العربية
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
