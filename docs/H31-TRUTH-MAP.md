# H31 — Branded Company App Platform: truth map

Written before any code changed. Every claim is a file in this repository, a row
read from production, a response from the Vercel API, or a quotation from a
primary vendor document with its date.

Baseline: production serves `5a63020` (the H30 commit), healthy, `queue.alert:
true` for the known Inngest stall. Branch `verify/h31` cut from `main` at
`b366495`, working tree clean.

---

## A.1 What already exists

| Thing | State |
| --- | --- |
| `public.org` | `id`, `name`, `country`, `timezone`, `base_currency`, `languages`, … — **no slug, no host, no domain column** |
| `public.org_branding` (migration 0071) | `logo_file_id`, `accent_color`, `display_name`, `legal_name`, `footer_details`. One row per org, RLS-isolated, no DELETE grant |
| Branding module | `src/modules/branding/service.ts` — `getBranding`, `saveBranding`, `uploadLogo` (server re-encodes), `removeLogo`, `getAppBranding`, document identity/profile |
| Logo pipeline | Uploads go through the tenant file pipeline and are **re-encoded server-side**; org-scoped; never hard-deleted |
| Entitlement | `feat.branding_app` gates in-app logo placement; `addon.branding_app` / `addon.branding_docs` are purchasable |
| Permission | `config.manage` — held by **owner and admin only**. The correct existing gate for branding and domains |
| Middleware | `src/middleware.ts` — mints a request id, forwards two auth-link shapes, refreshes the session. **No host inspection of any kind** |
| Routing | `/o/{orgId}/…` for every workspace surface. `resolveCtx(orgId)` checks membership user-side before any org GUC is set |
| Auth cookies | No explicit `domain:` is ever set, so every auth cookie is **host-only**. Nothing is shared across subdomains today |
| Security headers | CSP with `frame-ancestors 'none'`, `form-action 'self'`; **HSTS already carries `includeSubDomains; preload`** |
| PWA | **Nothing.** No manifest, no service worker, no icons, no `appleWebApp` metadata, no install code. `src/platform/config/schemas/manifest.ts` is an unrelated config-artifact schema |

### A.1.1 The one place that assumes a single host

`src/platform/auth/callback.ts` — `requestOrigin()`:

```ts
if (process.env.APP_ENV === "prod") {
  return process.env.APP_URL ?? CANONICAL_PROD_ORIGIN; // https://www.idaraworks.com
}
```

In production the request host is **deliberately ignored**, because a poisoned
`x-forwarded-host` would otherwise rewrite signup-confirmation and
password-recovery links. That reasoning is correct and must not be discarded.

It is also the single biggest obstacle to per-tenant origins: a user confirming
an email from `najolatech.idaraworks.com` would receive a link back to
`www.idaraworks.com` and lose their tenant. H31's resolver therefore validates a
host **against the registry** rather than trusting it — an allow-list, not a
header.

Other canonical-host constants (`page.tsx`, `robots.ts`, `sitemap.ts`) are
marketing-site metadata and are correct as they are: the public site stays
generic IdaraWorks.

---

## A.2 Hosting reality, read from Vercel

| Fact | Value |
| --- | --- |
| Project | `idaraworks` (`prj_gGmwkR5ZXN9XwQ2aGJTtER9RnTTl`), team `najolatech-s-projects` |
| Plan | **hobby** |
| Domains | `idaraworks.com` (redirects to www), `www.idaraworks.com` (the app), `idaraworks.vercel.app` |
| DNS | **`serviceType: external`** — nameservers `tom.ns.cloudflare.com`, `josephine.ns.cloudflare.com` |

### A.2.1 The wildcard blocker, from the primary source

Vercel, *Adding & Configuring a Custom Domain*, `last_updated: 2026-08-28`:

> "If using your custom domain as a wildcard domain, you **must use the
> nameservers method for verification**."

> "If you choose to use a wildcard domain Vercel's nameservers will be
> automatically enabled for you on saving the domain settings. You will then be
> provided with the Vercel nameservers to copy and use with your registrar."

And, on that migration:

> "If you are verifying your domain by changing nameservers, you will need to add
> any DNS records to Vercel that you wish to keep from your previous DNS
> provider."

**Therefore `*.idaraworks.com` cannot be added without moving the domain off
Cloudflare onto Vercel's nameservers**, which would require re-creating every
existing DNS record (mail included) and is explicitly outside this mandate
(rule 17; "changing registrar nameservers" is not permitted).

The blocker is **nameserver authority, not money.** The same page says "Hobby
teams have a limit of 50 custom domains per project", and states that ordinary
subdomains are configured with a **CNAME** record — no nameserver change. So:

| Capability | Blocked on | Owner action |
| --- | --- | --- |
| `*.idaraworks.com` self-service wildcard | nameserver migration to Vercel | large, risky, owner-only |
| **One named subdomain at a time**, e.g. `najolatech.idaraworks.com` | one Cloudflare CNAME + one Vercel domain add | small, reversible, owner-only |
| Customer-owned `app.customer.com` | customer's own DNS + Vercel domain add | per customer |

H31 builds for all three and activates none of them itself.

---

## A.3 Browser capability matrix

Primary source: MDN, *Making PWAs installable*, read 2026-09-04.

| Platform | Installation | Notes |
| --- | --- | --- |
| Chromium desktop (Chrome, Edge) | Install prompt via `beforeinstallprompt` | Requires `name` or `short_name`, `icons` with **both 192px and 512px**, `start_url`, `display`, and `prefer_related_applications` false or absent |
| Chromium Android | Install from browser menu / prompt | same criteria |
| **iOS / iPadOS 16.4+** | Share menu → Add to Home Screen, in **Safari, Chrome, Edge, Firefox, Orion** | no programmatic prompt exists; guidance only |
| iOS / iPadOS ≤ 16.3 | **Safari only** | |
| macOS Safari 17+ (Sonoma) | "Add to Dock" — "supports any web app with or without a manifest file" | |
| **Firefox desktop** | **"does not support installing PWAs using a manifest file"** | must be told honestly, not prompted |

> "While not a requirement for a PWA to be installable, many PWAs use service
> workers to provide an offline experience."

**A service worker is not required for installability.** That single fact decides
§B.3 below.

### A.3.1 Multiple apps from one origin

MDN, *Web App Manifest `id`*:

> "When a browser comes across an app manifest with an `id` that does not
> correspond to an already installed application, it treats that manifest as a
> description of a distinct application, **even if it is served from the same URL
> as another application**."

> "When a browser comes across an app manifest with an `id` that matches the
> identity of an already installed app, it treats the new manifest as a
> replacement for the existing app's manifest…"

This is what makes the fallback real rather than a consolation prize: distinct
per-tenant `id`, `start_url` and `scope` on the **existing** origin install as
genuinely separate applications, and a company rename never orphans an install
because the `id` is keyed on the immutable organisation id.

---

## B. Architecture chosen, and what was rejected

### B.1 Two address modes, one platform

| Mode | Address | Requires | State in H31 |
| --- | --- | --- | --- |
| **Path mode** (default, works today) | `https://www.idaraworks.com/o/{orgId}` | nothing | **live behind the flag** |
| **Host mode** | `https://{slug}.idaraworks.com` | one CNAME + one Vercel domain per tenant | **built, dormant** until a host row is verified |

One codebase, one database, one Vercel project — rule 16. Host mode is not a
different application; it is the same resolver reached through a different door.

### B.2 Manifest identity is the organisation id, forever

`id` = `/o/{orgId}` resolved against the serving origin. Not the slug, not the
display name. A rename or a slug change must never produce a second installed
app, and the spec quotation above is why this works.

**Accepted consequence, stated rather than hidden:** `id` must be same-origin
with `start_url`. A tenant that later moves from path mode to host mode changes
origin, so its installed app becomes a *different* app and must be re-installed.
The settings screen says so before anyone commits to a subdomain.

### B.3 No response caching — the service worker is network-only

Rejected: a conventional caching service worker. On this architecture the same
paths serve authenticated HTML for whichever tenant is signed in, so any
response cache is a cross-tenant leak waiting for a coincidence. Rules 11, 12
and 13 forbid exactly that, and MDN confirms a service worker is not needed to
be installable.

Chosen: a service worker that **precaches one public offline page and nothing
else**, and is otherwise network-only — it stores no response, ever. That keeps
the polished offline screen the mandate asks for without a cache that could hold
one company's data while another is signed in.

### B.4 Rejected alternatives

| Rejected | Why |
| --- | --- |
| One Vercel project per customer | rule 16; and 50-domain/plan limits make it collapse immediately |
| Trusting `x-forwarded-host` to pick the tenant | rule 10; the header is attacker-influenced, which is why `requestOrigin()` already refuses it |
| Slug as the manifest `id` | a rename would orphan every installed app |
| Broad `.idaraworks.com` cookie domain for one sign-in across tenants | Part H says prefer separate sign-in over weakened cookie boundaries. Cookies stay host-only |
| Caching service worker with an auth-aware allow-list | one mistake leaks a tenant's data; the benefit is an offline score |

---

## C. Security boundaries

1. A hostname **selects** a tenant; it never **authorises** one. After the host
   resolves to an organisation, `resolveCtx` still proves membership.
2. A client-supplied organisation id can never override the host, and a host can
   never override membership.
3. Reserved slugs cannot be claimed (list in `src/platform/tenanthost/reserved.ts`,
   derived from the route tree, not guessed).
4. A pending or failed domain claim routes nothing and authorises nothing.
5. Branding is data. No customer value reaches a manifest, an icon or the DOM
   without validation, re-encoding or escaping. No SVG is ever served as an icon.
6. Manifests and icons are per-tenant URLs with deliberate cache headers, and are
   proved non-crossing by a test that requests two organisations in sequence.

---

## D. The release flag

`FEATURE_BRANDED_COMPANY_APPS` — enabled **only** by the exact string `"1"`,
matching the nine existing flags. `"true"`, `"TRUE"`, `"yes"`, `"on"` and `" 1"`
all read as off, and a unit test pins each.

| Flag off (production today) | Flag on |
| --- | --- |
| No manifest, no service worker, no install affordance | Per-tenant manifest, icons, install centre |
| `/o/{orgId}` behaves exactly as it does now | identical, plus installability |
| Host mode inert — a verified host row routes nothing | verified host rows resolve |
| No branding change of any kind | branding editable by `config.manage` |

An organisation whose branding is incomplete falls back to IdaraWorks defaults
and stays fully usable. Nothing becomes inaccessible for want of a logo.

---

## E. Honest product language

Approved: *Your company. Your branding. Your own installable business app —
powered and maintained by IdaraWorks.*

Forbidden and not used anywhere: separately developed, customer-owned source
code, native Windows/macOS/iOS/Android application, app-store distribution.

---

## F. Implementation record

### F.1 What was built

| Migration | What it adds |
| --- | --- |
| `0134_h31a` | `tenant_host` (platform-wide unique live claim, 90-day release quarantine, status absent from the tenant UPDATE grant) and `org_app_brand` |
| `0135_h31b` | `app.public_app_identity` and `app.resolve_tenant_host` — the two pre-authentication reads |
| `0136_h31c` | `app.tenant_host_is_taken` — see F.3 |

All three are additive. No existing row is changed, no grant is narrowed, and an
organisation with none of these rows behaves exactly as it does today.

| Surface | Path |
| --- | --- |
| Per-tenant manifest | `/api/o/{orgId}/manifest` |
| Per-tenant icons | `/api/o/{orgId}/icon/{size}[-maskable].png` |
| App & Branding centre | `/o/{orgId}/settings/app` |
| Operator readiness | `/platform/apps` |
| Offline shell | `/offline` |
| Service worker | `/sw.js` |

### F.2 Two defects the tests found before a customer could

**A hostname containing a colon was accepted.** `acme.idaraworks.com:abc` failed
the numeric-port strip and was then classified whole, so a malformed host reached
tenant resolution. Any colon surviving the port strip now refuses the host.
Found by `tenant-host-law.test.ts`.

**Slug availability was blind to other tenants.** `checkSlug` read
`public.tenant_host` through the tenant's own connection, and row-level security
scopes that to the caller's organisation — so a hostname already claimed by
another company read as absent. Two tenants were both told one name was free,
and only the unique index stopped the second, as a raw constraint violation.
Migration 0136 adds a cross-tenant boolean, and the same fix was applied to the
in-transaction clash checks in both claim paths. Found by
`h31-company-app.test.ts`.

Both now have permanent regression tests.

### F.3 The privacy shape of the availability read

`app.tenant_host_is_taken` returns **one boolean**. It reports nothing about who
holds a name, when they claimed it, or whether that company exists, so it answers
the question a customer needs without becoming a way to enumerate the customer
base. "Not available" is deliberately the same answer for taken, reserved and
quarantined.

### F.4 Not implemented, and why

| Deferred | Reason |
| --- | --- |
| **Customer-uploaded app icons** | The icon endpoint is unauthenticated by necessity — a home screen draws its icon before anyone signs in. Reading a customer's private storage object on that path is how a private asset becomes public. The generated mark ships; the upload path was left un-built rather than half-built. |
| **Automated DNS verification for custom domains** | The claim, the token, the uniqueness and the audit exist. Actually checking DNS server-side and driving a provider API is meaningful work that would be untestable until a real customer domain exists. |
| **Wildcard `*.idaraworks.com`** | Owner action — nameserver migration. See A.2.1. |
| **Cross-subdomain single sign-on** | Deliberately refused. Part H says prefer separate sign-in over weakened cookie boundaries; cookies stay host-only, and a user installing two companies signs into each. |

### F.5 Release state

`FEATURE_BRANDED_COMPANY_APPS` — off through the first production deployment,
turned on only after the flag-off smoke passes. With it off there is no manifest,
no icon, no service worker registration, no install affordance, no settings entry
and no host resolution; `/o/{orgId}` is byte-for-byte what it is today.
