import { notFound, redirect } from "next/navigation";
import { Card } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import { publicAppIcon } from "@/modules/companyapp/service";
import { InstallApp } from "../InstallApp";
import { OrgLogo } from "../OrgLogo";
import { installLabels } from "./labels";

/**
 * The permanent install entry for EVERY member (the Company app settings page
 * is for administrators). It shows which company this is, whether this device
 * is already using the installed app, the direct Install button when the
 * browser offers one, and the browser's own steps when it does not.
 */
export default async function InstallPage({ params }: { params: Promise<{ orgId: string }> }) {
  if (!brandedCompanyAppsEnabled()) notFound();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const stored = await publicAppIcon(orgId, 192, true).catch(() => null);
  const iconUrl = stored
    ? `/api/o/${orgId}/icon/192-maskable.png?v=${Date.parse(stored.updatedAt)}`
    : null;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink">{t("app.install_page.title")}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{t("app.install_page.body")}</p>
      </header>
      <Card>
        <div className="flex items-center gap-3">
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the tenant icon route serves a PNG sized for this box
            <img
              src={iconUrl}
              alt=""
              width={56}
              height={56}
              className="size-14 rounded-xl border border-line"
            />
          ) : (
            <div className="shrink-0">
              <OrgLogo
                ctx={resolved.ctx}
                archetype={resolved.archetype}
                orgName={resolved.orgName}
              />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">{resolved.orgName}</p>
            <p className="text-xs text-ink-secondary">{t("app.install_page.identity")}</p>
          </div>
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <InstallApp orgId={orgId} variant="settings" labels={installLabels(t)} />
        </div>
      </Card>
    </div>
  );
}
