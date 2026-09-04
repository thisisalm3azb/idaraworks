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
import { solidPng } from "@/platform/tenanthost/png";
import { parseHex } from "@/platform/tenanthost/contrast";

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
    return png(icon.buffer);
  } catch (err) {
    /*
     * H31, found in production: this returned 500 because sharp's Linux
     * libraries were not traced into the function.
     *
     * A 500 here is not cosmetic. Chromium requires a 192px and a 512px icon to
     * consider an app installable, so a failing icon endpoint can take the
     * whole feature down — which is a far worse outcome than a plainer icon.
     *
     * So the fallback draws a solid square in the company's own colour using
     * `node:zlib` and nothing else. It is less handsome than the initials mark
     * and it is still the customer's brand, still valid, still installable. The
     * failure is logged loudly because it means the trace regressed, and
     * check-traced-payloads.ts is what should have caught it first.
     */
    logger.error(
      { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), orgId, spec },
      "company app icon generation failed — serving the dependency-free fallback",
    );
    const rgb = parseHex(identity.brandColor) ?? { r: 31, g: 111, b: 92 };
    return png(solidPng(size, rgb.r, rgb.g, rgb.b));
  }
}

/** One place decides the icon headers, so the fallback cannot differ. */
function png(body: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(body), {
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
}
