import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getAddon, hasFeature } from "@/platform/entitlements";
import { formatMoney } from "@/platform/format";
import { signRead } from "@/platform/files";
import { supabaseServer } from "@/platform/tenancy";
import { getBranding } from "@/modules/branding/service";
import { BrandingForm, type BrandingDict } from "./BrandingForm";
import { removeLogoAction, saveBrandingAction, uploadLogoAction } from "./actions";

/**
 * Settings → Branding (U2): the ONE governed source for the org's identity.
 * The page itself is config.manage-gated; the PLACEMENTS are honestly add-on
 * gated (feat.branding_app / feat.branding_docs) — a short note names exactly
 * which placements are locked and their price. During the growth trial both
 * features resolve true, so new users see their logo everywhere immediately.
 */
export default async function BrandingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.manage")) redirect(`/o/${orgId}`);
  const t = await getT();

  const branding = await getBranding(resolved.ctx);
  const [appOn, docsOn] = await Promise.all([
    hasFeature(resolved.ctx, "feat.branding_app"),
    hasFeature(resolved.ctx, "feat.branding_docs"),
  ]);

  // Preview URL: the same authenticated signed-read path every file uses —
  // the logo is never publicly addressable. Failure degrades to the avatar.
  let logoUrl: string | null = null;
  if (branding.logoFileId) {
    try {
      const store = await cookies();
      const token = (await supabaseServer(store).auth.getSession()).data.session?.access_token;
      if (token) {
        logoUrl = (
          await signRead(resolved.ctx, resolved.archetype, token, branding.logoFileId, "main")
        ).url;
      }
    } catch {
      logoUrl = null;
    }
  }

  const priceOf = (key: string): string => {
    const addon = getAddon(key);
    if (!addon) return "";
    return `${formatMoney(addon.usdMonthlyMinor, "USD")} / ${formatMoney(addon.aedMonthlyMinor, "AED")}`;
  };

  const dict: BrandingDict = {
    logo_title: t("branding.logo.title"),
    logo_hint: t("branding.logo.hint"),
    logo_drop: t("branding.logo.drop"),
    logo_choose: t("branding.logo.choose"),
    logo_uploading: t("branding.logo.uploading"),
    logo_remove: t("branding.logo.remove"),
    logo_replace: t("branding.logo.replace"),
    logo_empty: t("branding.logo.empty"),
    accent_title: t("branding.accent.title"),
    accent_hex: t("branding.accent.hex"),
    identity_title: t("branding.identity.title"),
    display_name: t("branding.identity.display_name"),
    display_name_hint: t("branding.identity.display_name_hint"),
    legal_name: t("branding.identity.legal_name"),
    footer: t("branding.identity.footer"),
    footer_hint: t("branding.identity.footer_hint"),
    save: t("branding.save"),
    saved: t("branding.saved"),
    errors: {
      too_large: t("branding.error.too_large"),
      bad_type: t("branding.error.bad_type"),
      bad_signature: t("branding.error.bad_signature"),
      bad_image: t("branding.error.bad_image"),
      too_small_dims: t("branding.error.too_small_dims"),
      too_large_dims: t("branding.error.too_large_dims"),
      quota_exceeded: t("branding.error.quota_exceeded"),
      invalid_input: t("branding.error.invalid"),
      failed: t("branding.error.failed"),
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("branding.title")} />
        <p className="text-sm text-ink-secondary">{t("branding.subtitle")}</p>
      </Card>

      {/* Honest placement gating: name what is on/locked and the price. */}
      <Card>
        <CardHeader title={t("branding.gate.title")} />
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone={appOn ? "success" : "neutral"}>
              {appOn ? t("branding.gate.on") : t("branding.gate.locked")}
            </Badge>
            <span className="text-ink-secondary">
              {appOn
                ? t("branding.gate.app_on")
                : t("branding.gate.app_off", { price: priceOf("addon.branding_app") })}
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone={docsOn ? "success" : "neutral"}>
              {docsOn ? t("branding.gate.on") : t("branding.gate.locked")}
            </Badge>
            <span className="text-ink-secondary">
              {docsOn
                ? t("branding.gate.docs_on")
                : t("branding.gate.docs_off", { price: priceOf("addon.branding_docs") })}
            </span>
          </li>
        </ul>
        {!appOn || !docsOn ? (
          <p className="mt-2 text-sm text-ink-muted">{t("branding.gate.fallback")}</p>
        ) : null}
      </Card>

      <BrandingForm
        orgName={branding.displayName ?? resolved.orgName}
        initial={{
          accentColor: branding.accentColor,
          displayName: branding.displayName,
          legalName: branding.legalName,
          footerDetails: branding.footerDetails,
        }}
        logoUrl={logoUrl}
        dict={dict}
        uploadAction={uploadLogoAction.bind(null, orgId)}
        removeAction={removeLogoAction.bind(null, orgId)}
        saveAction={saveBrandingAction.bind(null, orgId)}
      />
    </div>
  );
}
