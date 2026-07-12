import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { logoutAction, signOutOtherDevicesAction } from "../actions";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const t = await getT();
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { notice } = await searchParams;
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <Card>
          <CardHeader title={t("auth.account.title")} meta={user.email ?? undefined} />
          {notice === "others_signed_out" ? (
            <p className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">
              Other devices were signed out.
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
      </div>
    </AppShell>
  );
}
