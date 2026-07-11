import { redirect } from "next/navigation";
import { AppShell } from "@/platform/ui";
import { getSessionUser } from "@/platform/auth/resolve";
import { MfaClient } from "./MfaClient";

export default async function MfaPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell brand={<span>IdaraWorks</span>}>
      <div className="mx-auto w-full max-w-sm">
        <MfaClient />
      </div>
    </AppShell>
  );
}
