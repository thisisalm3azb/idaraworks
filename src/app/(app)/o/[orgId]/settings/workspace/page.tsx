import { redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { sql, withCtx } from "@/platform/tenancy";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { TERM_KEYS } from "@/platform/registries";
import { WORKSPACE_MODULE_KEYS, moduleStateOf } from "@/platform/workspace";
import { resolveShell } from "../../shell";

/**
 * H16 Part K — "Workspace setup": the restrained, authorized view of the
 * current Intelligent Clay shape, in plain business language. Owners and
 * administrators (config.view) see which areas are on, the organization's
 * own words, the roles that exist, country and currency, and which setup
 * revision is applied and when it was confirmed. No internal keys, hashes,
 * raw JSON or permission matrices — ever. Editing stays in the existing
 * governed configuration surfaces; this page only explains.
 */
export default async function WorkspaceSetupPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}/settings/workspace`);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.view")) redirect(`/o/${orgId}`);

  const t = await getT();
  const locale = await getServerLocale();
  const shell = await resolveShell(resolved);
  const terms = await loadOrgTerminology(resolved.ctx, locale);

  const [orgRow] = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`select country, timezone from public.org where id = ${orgId}`),
  )) as unknown as Array<{ country: string; timezone: string }>;

  const roles = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select rd.key, rd.label, count(m.id)::int as members
      from public.role_definition rd
      left join public.membership m
        on m.org_id = rd.org_id and m.role_key = rd.key and m.deactivated_at is null
      where rd.org_id = ${orgId}
      group by rd.key, rd.label
      order by rd.key
    `),
  )) as unknown as Array<{ key: string; label: { en?: string; ar?: string }; members: number }>;

  const moduleLabel = (key: string) => t(`onboarding.flow.module.${key.slice("cap.".length)}`);
  const on = WORKSPACE_MODULE_KEYS.filter((k) => moduleStateOf(shell.shape, k) !== "disabled");
  const off = WORKSPACE_MODULE_KEYS.filter((k) => moduleStateOf(shell.shape, k) === "disabled");
  const appliedAt = shell.shape?.appliedAt
    ? new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
        dateStyle: "long",
        numberingSystem: "latn",
      }).format(new Date(shell.shape.appliedAt))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("shell.setup.title")}</h1>

      {shell.shape ? (
        <p className="text-sm text-ink-secondary">
          {t("shell.setup.revision_line", {
            revision: shell.shape.revisionNo,
            date: appliedAt ?? "",
          })}
        </p>
      ) : (
        <Card>
          <p className="text-sm leading-relaxed text-ink">{t("shell.setup.legacy_note")}</p>
        </Card>
      )}

      <Card>
        <CardHeader title={t("shell.setup.areas_on")} />
        <ul className="flex flex-wrap gap-2">
          {on.map((k) => (
            <li key={k}>
              <Badge tone="success">{moduleLabel(k)}</Badge>
            </li>
          ))}
        </ul>
        {off.length > 0 ? (
          <>
            <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {t("shell.setup.areas_off")}
            </p>
            <ul className="flex flex-wrap gap-2">
              {off.map((k) => (
                <li key={k}>
                  <Badge tone="neutral">{moduleLabel(k)}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-muted">{t("shell.setup.areas_off_note")}</p>
          </>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={t("shell.setup.terms_title")} />
        <p className="mb-2 text-xs text-ink-muted">{t("shell.setup.terms_note")}</p>
        <ul className="flex flex-wrap gap-2">
          {TERM_KEYS.map((k) => (
            <li key={k}>
              <Badge tone="neutral">{term(k, terms, "singular")}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title={t("shell.setup.roles_title")} />
        <ul className="flex flex-col gap-1.5">
          {roles.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-ink">
                {(locale === "ar" ? r.label?.ar : r.label?.en) ?? r.key}
              </span>
              <span dir="ltr" className="font-mono text-xs text-ink-muted">
                {r.members}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title={t("shell.setup.region_title")} />
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">{t("onboarding.flow.region.country")}</span>
            <span className="font-medium text-ink">
              {t(`onboarding.flow.country.${orgRow?.country ?? "AE"}`)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">{t("onboarding.flow.region.currency")}</span>
            <span dir="ltr" className="font-mono font-medium text-ink">
              {resolved.baseCurrency}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">{t("onboarding.flow.region.timezone")}</span>
            <span dir="ltr" className="font-medium text-ink">
              {orgRow?.timezone ?? ""}
            </span>
          </div>
        </div>
      </Card>

      <p className="text-xs text-ink-muted">{t("shell.setup.edit_note")}</p>
    </div>
  );
}
