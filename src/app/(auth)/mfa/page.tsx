import { redirect } from "next/navigation";
import { AppShell } from "@/platform/ui";
import { getSessionUser } from "@/platform/auth/resolve";
import { getServerLocale } from "@/platform/i18n/server";
import { MfaClient } from "./MfaClient";

export default async function MfaPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const locale = await getServerLocale();
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <MfaClient locale={locale} />
      </div>
    </AppShell>
  );
}
