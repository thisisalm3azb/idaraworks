import { brandedCompanyAppsEnabled } from "@/platform/flags";
import { publicAppIdentity } from "@/modules/companyapp/service";

/**
 * H31 — the tags that make a workspace installable as this company's app.
 *
 * ── Why these are rendered here and not in `generateMetadata` ───────────────
 * Next's metadata API owns `<head>` for a route, and this needs to be present on
 * EVERY page inside an organisation, keyed on the organisation, without adding
 * a `generateMetadata` to fifty route files. React hoists `<link>` and `<meta>`
 * out of the body into the head, so a component in the layout is the smallest
 * correct place for it.
 *
 * ── Why there is no <title> or description here ─────────────────────────────
 * Those belong to the page. This component only claims the app identity.
 *
 * With the flag off it renders nothing at all, which is what keeps today's
 * production behaviour byte-identical.
 */
export async function CompanyAppHead({ orgId }: { orgId: string }) {
  if (!brandedCompanyAppsEnabled()) return null;

  const identity = await publicAppIdentity(orgId);
  if (!identity) return null;

  const manifestUrl = `/api/o/${orgId}/manifest`;
  const icon = (size: number, maskable = false) =>
    `/api/o/${orgId}/icon/${size}${maskable ? "-maskable" : ""}.png`;

  return (
    <>
      <link rel="manifest" href={manifestUrl} />
      {/*
        The browser UI colour. Kept in step with the manifest's theme_color so
        the address bar and the installed title bar do not disagree.
      */}
      <meta name="theme-color" content={identity.brandColor} />
      {/*
        iOS reads none of the manifest for the home-screen icon: it wants an
        apple-touch-icon link, and it wants the app name from a meta tag. Both
        are per-organisation here, which is the whole point.
      */}
      <link rel="apple-touch-icon" href={icon(180)} />
      <meta name="apple-mobile-web-app-title" content={identity.shortName} />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      <link rel="icon" type="image/png" sizes="32x32" href={icon(32)} />
      <link rel="icon" type="image/png" sizes="192x192" href={icon(192)} />
    </>
  );
}
