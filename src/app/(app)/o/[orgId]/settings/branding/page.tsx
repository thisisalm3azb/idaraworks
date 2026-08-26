import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getServerLocale, getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getAddon, hasFeature } from "@/platform/entitlements";
import { formatDate, formatMoney } from "@/platform/format";
import { signRead } from "@/platform/files";
import { supabaseServer } from "@/platform/tenancy";
import { getBranding, getDocumentProfile } from "@/modules/branding/service";
import { BrandingForm, type BrandingDict } from "./BrandingForm";
import { DocumentIdentityForm, type DocumentIdentityDict } from "./DocumentIdentityForm";
import { DocumentPreview } from "./DocumentPreview";
import {
  removeLogoAction,
  saveBrandingAction,
  saveDocumentIdentityAction,
  uploadLogoAction,
} from "./actions";

/**
 * Settings → Brand & Documents (003B.1): ONE governed surface for the org's
 * complete document profile. Visual identity (logo/accent/trading name/footer)
 * lives on org_branding; the LEGAL issuer identity (legal name, TRN, licence,
 * bilingual address, contacts, signatory, payment instructions, document
 * language) lives on the default company row; the page composes both and
 * shows a live SAMPLE letterhead. Basic document identity is a CORE
 * capability — never entitlement-gated (audit §12.1). The add-on gates are
 * honestly scoped: feat.branding_app = in-app placements; feat.branding_docs
 * = ADVANCED document styling (accent/letterhead), never issuer identity.
 */
export default async function BrandingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "config.manage")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();

  const [branding, profile, appOn] = await Promise.all([
    getBranding(resolved.ctx),
    getDocumentProfile(resolved.ctx),
    hasFeature(resolved.ctx, "feat.branding_app"),
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
    footer: t("branding.identity.footer"),
    footer_hint: t("branding.identity.footer_hint"),
    save: t("branding.save"),
    saved: t("branding.saved"),
    reference: t("branding.logo.reference"),
    errors: {
      too_large: t("branding.error.too_large"),
      bad_type: t("branding.error.bad_type"),
      bad_signature: t("branding.error.bad_signature"),
      bad_image: t("branding.error.bad_image"),
      too_small_dims: t("branding.error.too_small_dims"),
      too_large_dims: t("branding.error.too_large_dims"),
      quota_exceeded: t("branding.error.quota_exceeded"),
      invalid_input: t("branding.error.invalid"),
      server_error: t("branding.error.server_error"),
      failed: t("branding.error.failed"),
    },
  };

  const idDict: DocumentIdentityDict = {
    title: t("branding.docs.title"),
    subtitle: t("branding.docs.subtitle"),
    legal_name: t("branding.identity.legal_name"),
    legal_name_hint: t("branding.docs.legal_name_hint"),
    trn: t("branding.docs.trn"),
    license: t("branding.docs.license"),
    address_en: t("branding.docs.address_en"),
    address_ar: t("branding.docs.address_ar"),
    city: t("branding.docs.city"),
    region: t("branding.docs.region"),
    postal_code: t("branding.docs.postal_code"),
    country: t("branding.docs.country"),
    phone: t("branding.docs.phone"),
    email: t("branding.docs.email"),
    website: t("branding.docs.website"),
    signatory_name: t("branding.docs.signatory_name"),
    signatory_title: t("branding.docs.signatory_title"),
    payment_instructions: t("branding.docs.payment_instructions"),
    payment_instructions_hint: t("branding.docs.payment_instructions_hint"),
    doc_language: t("branding.docs.language"),
    doc_language_en: t("branding.docs.language_en"),
    doc_language_ar: t("branding.docs.language_ar"),
    doc_language_bilingual: t("branding.docs.language_bilingual"),
    save: t("branding.save"),
    saved: t("branding.saved"),
    reference: t("branding.logo.reference"),
    errors: {
      invalid_input: t("branding.error.invalid"),
      server_error: t("branding.error.server_error"),
      failed: t("branding.error.failed"),
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("branding.title")} />
        <p className="text-sm text-ink-secondary">{t("branding.subtitle")}</p>
      </Card>

      {/* Honest gating note: document identity is CORE; the add-ons cover
          in-app placements and advanced document styling only. */}
      <Card>
        <CardHeader title={t("branding.gate.title")} />
        <p className="mb-2 text-sm text-ink-secondary">{t("branding.gate.core_note")}</p>
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
            <Badge tone={profile.advancedStyling ? "success" : "neutral"}>
              {profile.advancedStyling ? t("branding.gate.on") : t("branding.gate.locked")}
            </Badge>
            <span className="text-ink-secondary">
              {profile.advancedStyling
                ? t("branding.gate.docs_on")
                : t("branding.gate.docs_off", { price: priceOf("addon.branding_docs") })}
            </span>
          </li>
        </ul>
      </Card>

      <BrandingForm
        orgName={branding.displayName ?? resolved.orgName}
        initial={{
          accentColor: branding.accentColor,
          displayName: branding.displayName,
          footerDetails: branding.footerDetails,
        }}
        logoUrl={logoUrl}
        dict={dict}
        uploadAction={uploadLogoAction.bind(null, orgId)}
        removeAction={removeLogoAction.bind(null, orgId)}
        saveAction={saveBrandingAction.bind(null, orgId)}
      />

      <DocumentIdentityForm
        initial={{
          legalName: profile.identity.legalName,
          taxRegNo: profile.identity.trn,
          tradeLicenseNo: profile.identity.licenseNo,
          addressEn: profile.identity.addressEn,
          addressAr: profile.identity.addressAr,
          city: profile.identity.city,
          region: profile.identity.region,
          postalCode: profile.identity.postalCode,
          country: profile.identity.country,
          phone: profile.identity.phone,
          email: profile.identity.email,
          website: profile.identity.website,
          signatoryName: profile.identity.signatoryName,
          signatoryTitle: profile.identity.signatoryTitle,
          paymentInstructions: profile.identity.paymentInstructions,
          docLanguage: profile.identity.docLanguage,
        }}
        dict={idDict}
        saveAction={saveDocumentIdentityAction.bind(null, orgId)}
      />

      <DocumentPreview
        profile={profile}
        dateText={formatDate(new Date().toISOString(), { locale })}
        dict={{
          title: t("branding.preview.title"),
          sample_note: t("branding.preview.sample_note"),
          frame_title: t("branding.preview.frame_title"),
          sample_title_ar: t("branding.preview.sample_title_ar"),
          sample_title_en: t("branding.preview.sample_title_en"),
          sample_body: t("branding.preview.sample_body"),
        }}
      />
    </div>
  );
}
