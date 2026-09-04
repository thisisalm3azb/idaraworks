/**
 * H31 — turning a hostname into a candidate organisation, safely.
 *
 * ── The one rule this file exists to enforce ────────────────────────────────
 * A hostname SELECTS a tenant. It never AUTHORISES one.
 *
 * Everything here is a lookup that narrows "which organisation might this
 * request be about". Nothing here proves the caller may see that organisation;
 * `resolveCtx` still does that, from the session, exactly as it does today. A
 * user who edits their hosts file, spoofs a header or types another company's
 * subdomain reaches this code and then fails the membership check unchanged.
 *
 * ── Why the parsing is pure ─────────────────────────────────────────────────
 * Host parsing is the part attackers probe, so it takes a string and returns a
 * verdict with no database, no clock and no environment. The registry lookup is
 * a separate function that consumes that verdict. It means every strange host
 * anyone can think of is a unit test rather than an integration fixture.
 */

/** Hosts that mean "the platform itself", never a tenant. */
const PLATFORM_HOSTS = new Set(["idaraworks.com", "www.idaraworks.com"]);

/** The parent under which a label identifies a tenant. */
export const TENANT_PARENT = "idaraworks.com";

/**
 * A DNS label: lowercase alphanumeric with internal hyphens, 1–63 characters.
 *
 * Deliberately NARROWER than DNS allows. Underscores are legal in DNS and are a
 * classic parser-disagreement trick; a leading or trailing hyphen is not a
 * legal hostname label; and `xn--` is excluded outright below.
 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostKind =
  /** The marketing site or the canonical app origin — not a tenant. */
  | "platform"
  /** A `{label}.idaraworks.com` subdomain. */
  | "tenant_subdomain"
  /** Any other host, which can only be a verified customer-owned domain. */
  | "custom_domain"
  /** Local development, previews, and anything we refuse to interpret. */
  | "development"
  | "invalid";

export type HostVerdict = {
  kind: HostKind;
  /** The normalised host, lowercase and without a port. */
  host: string;
  /** Present only for `tenant_subdomain`. */
  label?: string;
  /** Why an `invalid` verdict was reached — for logs, never for users. */
  reason?: string;
};

/**
 * Normalise a Host header value.
 *
 * Strips a port, lowercases, removes one trailing dot (the DNS root, which
 * browsers accept and which would otherwise make `acme.idaraworks.com.` a
 * different string from `acme.idaraworks.com`), and refuses anything with
 * control characters, whitespace, credentials or a path — all of which mean the
 * value did not come from a well-formed Host header.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 253 + 6) return null;
  // A Host header carries no scheme, credentials, path, query or fragment.
  if (/[\s/\\?#@]/.test(trimmed)) return null;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return null;
  }
  // IPv6 literals are bracketed and are never a tenant host.
  if (trimmed.startsWith("[")) return null;

  let host = trimmed.toLowerCase();
  // Strip exactly one port suffix, and only a numeric one.
  const portMatch = /^(.*):(\d{1,5})$/.exec(host);
  if (portMatch) host = portMatch[1]!;
  /*
   * Any colon still here is not a port.
   *
   * Found by the unit test: `acme.idaraworks.com:abc` failed the numeric-port
   * match and was then accepted whole, so a hostname containing a colon reached
   * classification. A colon is not legal in a hostname, and a value that
   * contains one after the port strip is malformed rather than interesting.
   */
  if (host.includes(":")) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  return host;
}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/**
 * Classify a host. Pure.
 *
 * Ambiguity is always resolved toward `invalid`: a host we cannot confidently
 * name is one we must not route.
 */
export function classifyHost(raw: string | null | undefined): HostVerdict {
  const host = normalizeHost(raw);
  if (!host) return { kind: "invalid", host: "", reason: "unparseable host" };

  if (DEV_HOSTS.has(host) || host.endsWith(".localhost")) {
    return { kind: "development", host };
  }
  // Vercel preview deployments are not tenant hosts and must never resolve one.
  if (host.endsWith(".vercel.app")) return { kind: "development", host };

  if (PLATFORM_HOSTS.has(host)) return { kind: "platform", host };

  if (host === TENANT_PARENT || host.endsWith(`.${TENANT_PARENT}`)) {
    const label = host.slice(0, -(TENANT_PARENT.length + 1));
    // A bare parent is the platform, handled above; an empty label cannot occur.
    if (label.length === 0) return { kind: "invalid", host, reason: "empty label" };
    // Only a SINGLE label. `a.b.idaraworks.com` is refused rather than guessed
    // at: nothing issues those, so one appearing means something is wrong.
    if (label.includes(".")) return { kind: "invalid", host, reason: "multi-label subdomain" };
    /*
     * Punycode is refused outright under our own parent domain.
     *
     * We issue the labels here, and we only ever issue ASCII ones, so an `xn--`
     * label under idaraworks.com cannot be legitimate — and accepting it would
     * mean rendering a name whose displayed form differs from its stored form.
     * Customer-owned domains are a separate story (see below) because we do not
     * choose those names.
     */
    if (label.startsWith("xn--")) return { kind: "invalid", host, reason: "punycode label" };
    if (!LABEL_RE.test(label)) return { kind: "invalid", host, reason: "malformed label" };
    return { kind: "tenant_subdomain", host, label };
  }

  // Anything else can only be a customer-owned domain, and only if the registry
  // says so. Shape-check it so obvious rubbish never reaches a query.
  const parts = host.split(".");
  if (parts.length < 2) return { kind: "invalid", host, reason: "no public suffix" };
  for (const part of parts) {
    // Customer domains MAY legitimately be internationalised, so `xn--` is
    // allowed here — but only in the a-label form the registry stored.
    if (!LABEL_RE.test(part)) return { kind: "invalid", host, reason: "malformed domain label" };
  }
  return { kind: "custom_domain", host };
}

/**
 * Normalise a slug the way the UI, the service and the database must all agree.
 *
 * Case folding happens once, here. Anything that is not already a valid label
 * is rejected rather than silently repaired — a slug the user did not type is
 * worse than an error message, because it becomes their permanent address.
 */
export function normalizeSlug(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length < 3 || slug.length > 63) return null;
  if (slug.startsWith("xn--")) return null;
  if (!LABEL_RE.test(slug)) return null;
  return slug;
}
