/**
 * H31 — subdomain labels no organisation may claim.
 *
 * Three sources, kept separate so a reader can see WHY each name is here rather
 * than trusting one long list:
 *
 *   1. ROUTE_SEGMENTS — every top-level path this application actually serves,
 *      enumerated from `src/app` rather than remembered. A tenant called `api`
 *      would make `api.idaraworks.com` and `www.idaraworks.com/api` two
 *      different things with one name, which is how people get confused into
 *      trusting the wrong one.
 *   2. INFRASTRUCTURE — names an operator or a mail system may need later. Cheap
 *      to reserve now, impossible to reclaim once a customer is installed on one.
 *   3. MISLEADING — names a tenant could use to impersonate the platform or a
 *      security function. `secure.idaraworks.com` in a phishing mail is more
 *      convincing than any lookalike domain, and we would have issued it.
 *
 * The mandate's minimum list is a subset of this; every addition beyond it is
 * justified above rather than added defensively.
 */

/** Top-level paths this app serves today (audited from src/app, 2026-09-04). */
const ROUTE_SEGMENTS = [
  "api",
  "auth",
  "platform",
  "privacy",
  "terms",
  "account",
  "forgot",
  "invite",
  "login",
  "mfa",
  "onboarding",
  "signup",
  "o",
  "d",
  "f",
  "s",
  "sign",
] as const;

/** Operational and mail names. Reserving them costs nothing today. */
const INFRASTRUCTURE = [
  "www",
  "app",
  "admin",
  "support",
  "help",
  "mail",
  "smtp",
  "imap",
  "pop",
  "ns",
  "ns1",
  "ns2",
  "mx",
  "status",
  "static",
  "assets",
  "cdn",
  "img",
  "images",
  "media",
  "files",
  "storage",
  "docs",
  "blog",
  "test",
  "staging",
  "preview",
  "dev",
  "demo",
  "sandbox",
  "production",
  "prod",
  "internal",
  "metrics",
  "monitor",
  "grafana",
  "vercel",
  "supabase",
] as const;

/** Names that would let a tenant impersonate the platform or a safety function. */
const MISLEADING = [
  "idaraworks",
  "idara",
  "official",
  "secure",
  "security",
  "verify",
  "verification",
  "billing",
  "payment",
  "payments",
  "invoice",
  "invoices",
  "register",
  "signin",
  "sign-in",
  "log-in",
  "logout",
  "password",
  "reset",
  "confirm",
  "activate",
  "root",
  "system",
  "operator",
  "platform-admin",
  "superadmin",
] as const;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>([
  ...ROUTE_SEGMENTS,
  ...INFRASTRUCTURE,
  ...MISLEADING,
]);

/** Exposed so a test can prove the route audit is still current. */
export const RESERVED_ROUTE_SEGMENTS: readonly string[] = ROUTE_SEGMENTS;

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
