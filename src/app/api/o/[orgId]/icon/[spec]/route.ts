/**
 * H31 — per-tenant application icons.
 *
 * Like the manifest, these are fetched before authentication: a home screen
 * draws its icon whether or not anyone is signed in. And like the manifest they
 * are addressed per organisation, so no cache key is ever shared between two
 * companies however the CDN is configured.
 *
 * ── Why these are generated rather than served from storage ─────────────────
 * The uploaded brand asset is the customer's; the icons are derived from it.
 * Generating on request means a colour change takes effect immediately, a
 * customer with no icon still gets a professional mark, and there is no second
 * copy of a brand asset to keep in step with the original. The cost is one
 * sharp pipeline per request, which the cache header below makes rare.
 *
 * Nothing customer-supplied is ever served as SVG. The generator rasterises to
 * PNG, and the only SVG involved is one this code composes from a hex colour
 * and XML-escaped initials, handed straight to sharp and never to a browser.
 */
import { NextResponse } from "next/server";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import { publicAppIdentity } from "@/modules/companyapp/service";
import { ICON_SIZES, generateIconSet, type IconSize } from "@/platform/tenanthost/icon";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";
/** sharp on a cold serverless container needs room to start. */
export const maxDuration = 30;

const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `512.png` or `512-maskable.png`, and nothing else. */
const SPEC_RE = /^(\d{2,4})(-maskable)?\.png$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; spec: string }> },
): Promise<NextResponse> {
  if (!brandedCompanyAppsEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { orgId, spec } = await params;
  if (!ORG_ID_RE.test(orgId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const m = SPEC_RE.exec(spec);
  if (!m) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const size = Number(m[1]) as IconSize;
  const maskable = m[2] === "-maskable";
  // A closed list, so a caller cannot ask for a 4096px render as a cheap way to
  // spend the server's memory.
  if (!(ICON_SIZES as readonly number[]).includes(size)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (maskable && size < 192) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const identity = await publicAppIdentity(orgId);
  if (!identity) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    /*
     * H31 ships the generated mark only.
     *
     * Reading the customer's uploaded icon here would mean fetching a private
     * storage object on an unauthenticated request, and getting that wrong is
     * how a private asset becomes public. The uploaded-icon path is deliberately
     * deferred rather than half-built: see the truth map's "not implemented".
     */
    const { icons } = await generateIconSet({
      source: null,
      orgName: identity.name,
      brandColor: identity.brandColor,
    });
    const icon = icons.find((i) => i.size === size && i.maskable === maskable);
    if (!icon) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return new NextResponse(new Uint8Array(icon.buffer), {
      headers: {
        "content-type": "image/png",
        /*
         * `private` keeps a shared cache out of it; the org-scoped URL is what
         * actually prevents crossover. An hour is long enough to make repeat
         * launches cheap and short enough that a colour change is visible the
         * same morning it is made.
         */
        "cache-control": "private, max-age=3600",
        "x-robots-tag": "noindex, nofollow",
        "content-disposition": "inline",
      },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), orgId, spec },
      "company app icon generation failed",
    );
    // A failed icon must not look like a missing organisation.
    return NextResponse.json({ error: "icon_unavailable" }, { status: 500 });
  }
}
