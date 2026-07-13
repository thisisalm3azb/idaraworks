import { redirect } from "next/navigation";
import { Button, Card } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { getMyNotificationPreferences } from "@/platform/notifications";
import { saveNotifPrefsAction } from "./actions";

const KINDS = ["approval_requested", "approval_decided"] as const;
const CHANNELS = ["in_app", "email"] as const;

export default async function NotificationPrefsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const prefs = await getMyNotificationPreferences(resolved.ctx);
  const save = saveNotifPrefsAction.bind(null, orgId);
  const checked = (kind: string, ch: string): boolean => {
    const k = prefs[kind] as Record<string, boolean> | undefined;
    // Default ON for in_app if unset.
    return k?.[ch] ?? ch === "in_app";
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("notif.prefs.title")}</h1>
      {sp.ok ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("notif.prefs.saved")}
        </p>
      ) : null}
      <form action={save} className="flex flex-col gap-3">
        {KINDS.map((kind) => (
          <Card key={kind}>
            <p className="mb-2 font-medium text-ink">{t(`notif.prefs.${kind}`)}</p>
            <div className="flex flex-wrap gap-4">
              {CHANNELS.map((ch) => (
                <label key={ch} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name={`${kind}.${ch}`}
                    defaultChecked={checked(kind, ch)}
                    className="size-5"
                  />
                  {t(`notif.prefs.${ch}`)}
                </label>
              ))}
            </div>
          </Card>
        ))}
        <Button type="submit">{t("common.save")}</Button>
      </form>
    </div>
  );
}
