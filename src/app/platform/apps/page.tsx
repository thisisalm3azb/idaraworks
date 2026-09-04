import { notFound, redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { getSessionUser } from "@/platform/auth/resolve";
import { isPlatformOperator } from "@/platform/ai";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import { operatorAppReadiness } from "@/modules/companyapp/service";

/**
 * H31 — the operator's answer to "why can this company not install its app".
 *
 * Readiness only. Every column here is about configuration and addressing, and
 * none of it is a customer's data: an operator can see that an icon will be
 * generated rather than uploaded, and cannot see the company's records.
 *
 * There is deliberately no action on this page. Activating a hostname is a
 * deliberate act with its own audit trail and its own DNS prerequisite; making
 * it a button beside a list is how a domain gets reassigned by accident.
 */
export default async function PlatformAppsPage() {
  // Page-level gate: the layout and the page render together, so a layout check
  // would not stop this page's own data fetch.
  if (!brandedCompanyAppsEnabled()) notFound();
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/platform/apps");
  if (!(await isPlatformOperator(user.id))) notFound();

  const t = await getT();
  const rows = await operatorAppReadiness(user.id);

  const ready = rows.filter((r) => r.manifestReady).length;
  const withHost = rows.filter((r) => r.activeHost).length;
  const needsAttention = rows.filter((r) => r.failedHost || !r.manifestReady).length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">{t("platform.apps.title")}</h1>
        <p className="text-sm text-ink-muted">{t("platform.apps.subtitle")}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { key: "ready", value: ready, label: t("platform.apps.ready") },
          { key: "hosted", value: withHost, label: t("platform.apps.hosted") },
          { key: "attention", value: needsAttention, label: t("platform.apps.attention") },
        ].map((s) => (
          <Card key={s.key}>
            <p className="text-2xl font-semibold tabular-nums text-ink">{s.value}</p>
            <p className="text-sm text-ink-secondary">{s.label}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title={t("platform.apps.organisations")} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-muted">
                <th className="py-1 text-start font-normal">{t("platform.apps.company")}</th>
                <th className="py-1 text-start font-normal">{t("platform.apps.app_name")}</th>
                <th className="py-1 text-start font-normal">{t("platform.apps.address")}</th>
                <th className="py-1 text-start font-normal">{t("app.host.status")}</th>
                <th className="py-1 text-start font-normal">{t("platform.apps.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orgId} className="border-t border-line align-top">
                  <td className="py-2 pe-3">{r.orgName}</td>
                  <td className="py-2 pe-3">{r.appName}</td>
                  <td className="py-2 pe-3" dir="ltr">
                    <span className="font-mono text-xs">
                      {r.activeHost ??
                        r.pendingHost ??
                        r.failedHost ??
                        `/o/${r.orgId.slice(0, 8)}…`}
                    </span>
                  </td>
                  <td className="py-2 pe-3">
                    {r.activeHost ? (
                      <Badge tone="success">{t("app.host.active")}</Badge>
                    ) : r.failedHost ? (
                      <Badge tone="danger">{t("app.host.failed")}</Badge>
                    ) : r.pendingHost ? (
                      <Badge tone="warning">{t("app.host.pending")}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("platform.apps.path_mode")}</Badge>
                    )}
                  </td>
                  <td className="py-2">
                    <ul className="flex flex-col gap-0.5">
                      {r.failedReason ? (
                        <li className="text-xs text-danger">{r.failedReason}</li>
                      ) : null}
                      {r.warnings.map((w) => (
                        <li key={w} className="text-xs text-ink-muted">
                          {t(w)}
                        </li>
                      ))}
                      {r.lastVerifiedAt ? (
                        <li className="text-xs text-ink-muted">
                          {t("platform.apps.verified_at", { at: r.lastVerifiedAt })}
                        </li>
                      ) : null}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">{t("platform.apps.empty")}</p>
        ) : null}
      </Card>

      <p className="text-xs text-ink-muted">{t("platform.apps.no_actions")}</p>
    </div>
  );
}
