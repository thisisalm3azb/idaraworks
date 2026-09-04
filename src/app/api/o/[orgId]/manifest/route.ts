/**
 * H31 — the per-tenant web app manifest.
 *
 * ── Why this is a route and not a static file ───────────────────────────────
 * Every organisation installs a different application. The manifest carries the
 * company's name, colours and icons, so it is generated per organisation and
 * addressed per organisation.
 *
 * ── The cache decision, which is the whole security story ───────────────────
 * A manifest is fetched by the browser without credentials in some paths and
 * with them in others, and it is exactly the sort of small JSON a CDN loves to
 * keep. If Company A's manifest were ever served to Company B, B's home screen
 * would carry A's name and logo.
 *
 * Two independent defences, because one is a configuration and configurations
 * drift:
 *   1. the URL contains the organisation id, so two tenants never share a cache
 *      key however aggressive the CDN is;
 *   2. `private, no-store` says not to keep it at all.
 *
 * A manifest contains no secret — a name, a colour, an icon URL — so `private`
 * is about correctness rather than confidentiality. Membership is NOT required
 * to read it: an installed app fetches its manifest before the user signs in,
 * and refusing would break the signed-out launch the mandate requires. What the
 * manifest exposes is the same public-facing identity the login page shows.
 */
import { NextResponse } from "next/server";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import { publicAppIdentity } from "@/modules/companyapp/service";

export const dynamic = "force-dynamic";

const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<NextResponse> {
  if (!brandedCompanyAppsEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { orgId } = await params;
  if (!ORG_ID_RE.test(orgId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const identity = await publicAppIdentity(orgId);
  if (!identity) {
    // An unknown organisation and a private one produce the identical answer,
    // so this endpoint cannot be used to discover which companies exist.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const base = `${origin}/o/${orgId}`;
  const iconUrl = (size: number, maskable: boolean) =>
    `${origin}/api/o/${orgId}/icon/${size}${maskable ? "-maskable" : ""}.png`;

  const manifest = {
    /*
     * The installed identity, keyed on the organisation id and nothing else.
     *
     * Not the slug, not the display name. A company that renames itself, or
     * moves to a subdomain later, must not acquire a second installed app or
     * lose the one it has — and the spec says a matching id replaces the
     * existing manifest rather than creating a new app.
     */
    id: `/o/${orgId}`,
    name: identity.name,
    short_name: identity.shortName,
    description: identity.description ?? undefined,
    start_url: `${base}?source=pwa`,
    scope: `${base}/`,
    display: "standalone",
    // If a browser cannot honour standalone it should degrade to a plain
    // browser tab rather than to fullscreen, which hides the address bar
    // without giving the user an app window.
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    theme_color: identity.brandColor,
    background_color: identity.backgroundColor,
    lang: identity.locale,
    dir: identity.dir,
    // Never true: this is a web app, and claiming a related native application
    // would tell the browser to send people to a store that has nothing in it.
    prefer_related_applications: false,
    icons: [
      { src: iconUrl(192, false), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: iconUrl(512, false), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: iconUrl(192, true), sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: iconUrl(512, true), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: identity.shortcuts.map((s) => ({
      name: s.name,
      short_name: s.shortName,
      url: `${base}${s.path}`,
      icons: [{ src: iconUrl(192, false), sizes: "192x192", type: "image/png" }],
    })),
  };

  return NextResponse.json(manifest, {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      // See the header comment: the org-scoped URL is the real isolation, this
      // is the belt to its braces.
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
