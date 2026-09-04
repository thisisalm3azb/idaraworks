import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field, Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import {
  getAppIdentity,
  listHosts,
  suggestSlug,
  canManageCompanyApp,
} from "@/modules/companyapp/service";
import { InstallApp } from "../../InstallApp";
import { AppIconPreview } from "./AppIconPreview";
import { claimSubdomainAction, requestCustomDomainAction, saveAppBrandAction } from "./actions";

/**
 * H31 — the App & Branding centre.
 *
 * Deliberately not a settings form with a colour picker bolted on. The person
 * who opens this is deciding what their company's app will look like on their
 * team's phones, so the preview comes first and the fields serve it.
 *
 * The honesty rules that shape the copy here:
 *   - the current working address is shown FIRST, because it works today;
 *   - a reserved short address is labelled "not yet live", never "active", and
 *     the reason is stated;
 *   - moving to a short address later means re-installing, and that is said
 *     before anyone commits rather than discovered afterwards.
 */
export default async function CompanyAppSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  // Gated before the first await that renders anything: layout and page render
  // concurrently in the App Router, so a layout-only gate would not stop this.
  if (!brandedCompanyAppsEnabled()) notFound();

  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.view")) notFound();

  const t = await getT();
  const locale = await getServerLocale();
  const mayManage = canManageCompanyApp(resolved.archetype);

  const [identity, hosts] = await Promise.all([
    getAppIdentity(resolved.ctx),
    listHosts(resolved.ctx, resolved.archetype),
  ]);

  const liveHost = hosts.find((h) => h.status === "active");
  const pendingHost = hosts.find((h) => h.status === "pending");
  // The address that works right now — not the one someone hopes for.
  const currentAddress = liveHost
    ? `https://${liveHost.host}`
    : `https://www.idaraworks.com/o/${orgId}`;

  const notice =
    sp.ok === "saved" ? t("app.saved") : sp.ok === "reserved" ? t("app.slug.reserved_ok") : null;
  const errorText = sp.error?.startsWith("app.") ? t(sp.error) : null;
  const suggestion = suggestSlug(identity.name);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t("app.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-secondary">{t("app.subtitle")}</p>
      </div>

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-ink"
        >
          {notice}
        </p>
      ) : null}
      {errorText ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink"
        >
          {errorText}
        </p>
      ) : null}

      {/* The preview leads, because this page is about how the app will look. */}
      <Card>
        <CardHeader title={t("app.preview")} />
        <p className="mb-3 text-sm text-ink-secondary">{t("app.preview_hint")}</p>
        <AppIconPreview
          name={identity.name}
          shortName={identity.shortName}
          brandColor={identity.brand.value}
          foreground={identity.brand.foreground}
          background={identity.background.value}
          dir={identity.dir}
        />
        {identity.warnings.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {identity.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-sm text-ink-secondary">
                <Icon name="alert" size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
                <span>{t(w)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {/* The address that works today, before any aspiration about a short one. */}
      <Card>
        <CardHeader
          title={t("app.address")}
          meta={
            liveHost ? (
              <Badge tone="success">{t("app.host.active")}</Badge>
            ) : pendingHost ? (
              <Badge tone="warning">{t("app.host.pending")}</Badge>
            ) : undefined
          }
        />
        <p className="text-sm text-ink-secondary">{t("app.address_current")}</p>
        <p dir="ltr" className="mt-1 break-all font-mono text-sm text-ink">
          {currentAddress}
        </p>

        <div className="mt-3">
          <InstallApp
            orgId={orgId}
            variant="settings"
            labels={{
              install: t("app.install"),
              installed: t("app.installed"),
              ios: t("app.install_ios"),
              macSafari: t("app.install_mac_safari"),
              firefox: t("app.install_firefox"),
              generic: t("app.install_generic"),
              later: t("app.install_later"),
              never: t("app.install_never"),
            }}
          />
        </div>

        {pendingHost ? (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
            <p dir="ltr" className="break-all font-mono text-sm text-ink">
              https://{pendingHost.host}
            </p>
            <p className="mt-1 text-sm text-ink">{t("app.host.pending_note")}</p>
          </div>
        ) : null}

        {mayManage && !liveHost && !pendingHost ? (
          <form
            action={claimSubdomainAction.bind(null, orgId)}
            className="mt-4 flex flex-col gap-3"
          >
            <Field
              name="slug"
              label={t("app.slug_label")}
              hint={t("app.slug_hint")}
              defaultValue={suggestion}
              required
              maxLength={63}
              dir="ltr"
            />
            <p className="text-sm text-ink-muted">{t("app.host.move_warning")}</p>
            <Button type="submit" className="min-h-11 w-fit">
              {t("app.slug_claim")}
            </Button>
          </form>
        ) : null}
      </Card>

      {/* Identity. Every field optional: a company that changes nothing still
          gets a complete, working app. */}
      {mayManage ? (
        <Card>
          <CardHeader title={t("app.identity")} />
          <form action={saveAppBrandAction.bind(null, orgId)} className="flex flex-col gap-3">
            <Field
              name="app_name"
              label={t("app.name_label")}
              hint={t("app.name_hint")}
              defaultValue={identity.name}
              maxLength={60}
            />
            <Field
              name="app_short_name"
              label={t("app.short_name_label")}
              hint={t("app.short_name_hint")}
              defaultValue={identity.shortName}
              maxLength={12}
            />
            <Field
              name="app_description"
              label={t("app.description_label")}
              defaultValue={identity.description ?? ""}
              maxLength={300}
            />
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("app.brand_color")}
                <input
                  type="color"
                  name="brand_color"
                  defaultValue={identity.brand.value}
                  className="h-11 w-20 cursor-pointer rounded-md border border-line-strong bg-card"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("app.background_color")}
                <input
                  type="color"
                  name="background_color"
                  defaultValue={identity.background.value}
                  className="h-11 w-20 cursor-pointer rounded-md border border-line-strong bg-card"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("app.default_locale")}
                <select
                  name="default_locale"
                  defaultValue={identity.locale}
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
            </div>
            <Button type="submit" className="min-h-11 w-fit">
              {t("app.save")}
            </Button>
          </form>
        </Card>
      ) : null}

      {/* Customer-owned domains: the foundation exists, the capability does not
          yet. Saying "not yet available" is more useful than a form that
          silently never completes. */}
      <Card>
        <CardHeader title={t("app.domain.custom_title")} />
        <p className="text-sm text-ink-secondary">{t("app.domain.not_available")}</p>
        {mayManage ? (
          <form
            action={requestCustomDomainAction.bind(null, orgId)}
            className="mt-3 flex flex-col gap-3"
          >
            <Field name="domain" label="app.company.com" dir="ltr" maxLength={253} />
            <Button type="submit" variant="secondary" className="min-h-11 w-fit">
              {t("app.domain.custom_title")}
            </Button>
          </form>
        ) : null}
      </Card>

      <p className="text-center text-xs text-ink-muted" lang={locale}>
        {t("app.powered_by")}
      </p>
    </div>
  );
}
