import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { countryPacksEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { PACK_COUNTRIES, READINESS_STATES } from "@/platform/country";
import { listEstablishments, organisationReadiness } from "@/modules/country/service";

/**
 * H29E — the Country Readiness Centre.
 *
 * Six states, each shown as its own yes or no. They are deliberately not
 * averaged: "technically configured" and "legally reviewed" answer different
 * questions, and a single percentage would let a workspace look 83% legal.
 * A country pack being installed is not permission to operate in that country,
 * and the page says so where a person will read it.
 */
export default async function CountriesPage({ params }: { params: Promise<{ orgId: string }> }) {
  // Page-level gate: in the App Router the layout and the page render together,
  // so a layout check would not stop this page's own data fetch.
  if (!countryPacksEnabled()) notFound();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "country.view")) redirect(`/o/${orgId}`);
  const t = await getT();

  const [establishments, readiness] = await Promise.all([
    listEstablishments(resolved.ctx),
    organisationReadiness(resolved.ctx),
  ]);
  const byId = new Map(readiness.map((r) => [r.establishmentId, r]));
  const mayManage = can(resolved.archetype, "country.manage");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("country.title")}
          meta={
            mayManage ? (
              <Link href={`/o/${orgId}/settings/countries/new`}>
                <Button variant="secondary">{t("country.add")}</Button>
              </Link>
            ) : null
          }
        />
        <p className="text-sm text-ink-secondary">{t("country.subtitle")}</p>
        <p className="mt-3 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-secondary">
          {t("country.disclaimer")}
        </p>
      </Card>

      {establishments.length === 0 ? (
        <EmptyState title={t("country.empty.title")} description={t("country.empty.hint")} />
      ) : null}

      {establishments.map((e) => {
        const r = byId.get(e.id);
        return (
          <Card key={e.id}>
            <CardHeader
              title={
                <Link href={`/o/${orgId}/settings/countries/${e.id}`} className="hover:underline">
                  {e.legalName}
                </Link>
              }
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{e.code}</Badge>
                  <Badge tone="neutral">{e.country}</Badge>
                  {e.isPrimary ? <Badge tone="brand">{t("country.primary")}</Badge> : null}
                  {e.status === "inactive" ? (
                    <Badge tone="warning">{t("country.inactive")}</Badge>
                  ) : null}
                </div>
              }
            />

            {/* The name in its own script, when one was entered. Never
                transliterated: what the organisation typed is what shows. */}
            {e.legalNameLocal ? (
              <p className="text-sm text-ink-secondary" dir="auto">
                {e.legalNameLocal}
              </p>
            ) : null}

            <p className="mt-2 text-sm text-ink-muted">
              {r?.packKey
                ? t("country.pack_in_force", { pack: r.packKey })
                : t("country.no_pack_adopted")}
            </p>

            {/* Six independent states. A missing state is shown as plainly as a
                met one — this list is the honest answer, not a score. */}
            <ul className="mt-3 flex flex-wrap gap-2">
              {READINESS_STATES.map((state) => (
                <li key={state}>
                  <Badge tone={r?.states[state] ? "success" : "neutral"}>
                    {r?.states[state] ? "✓ " : "· "}
                    {t(`country.state.${state}`)}
                  </Badge>
                </li>
              ))}
            </ul>

            {r && r.blocking.length > 0 ? (
              <div className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-ink">
                <p className="font-medium">{t("country.blocking")}</p>
                <ul className="mt-1 list-disc ps-5">
                  {r.blocking.map((c) => (
                    <li key={c.key}>{t(c.detailKey ?? c.labelKey, c.detail)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        );
      })}

      <Card>
        <CardHeader title={t("country.supported")} />
        <p className="text-sm text-ink-secondary">{t("country.supported_hint")}</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {PACK_COUNTRIES.map((code) => (
            <li key={code}>
              <Badge tone="neutral">{code}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
