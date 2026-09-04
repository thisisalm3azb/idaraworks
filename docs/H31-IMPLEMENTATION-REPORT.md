# H31 — Branded Company App Platform: implementation report

**Status: code-complete and deployed flag-off. One redeploy from live, blocked
until the Vercel daily deployment allowance resets.**

Production runs `6fa05fe` — the exact CI-green source — with migrations 0134–0136
applied and the release flag registered. The flag-off production smoke passed 16
of 16, residue is zero, and business counts are unchanged.

H30's five owner conditions remain open. **H31 does not change the overall launch
recommendation, which stays CONDITIONAL GO.**

---

## 1. What was built

A real multi-tenant branded PWA platform: one codebase, one database, one Vercel
project, and a different installable application per company.

| Piece | Where |
| --- | --- |
| Hostname resolver (pure, exhaustively tested) | `src/platform/tenanthost/resolve.ts` |
| Reserved labels, derived from the route tree | `src/platform/tenanthost/reserved.ts` |
| Colour safety and contrast decisions | `src/platform/tenanthost/contrast.ts` |
| Icon generation (PNG, maskable-safe) | `src/platform/tenanthost/icon.ts` |
| Company app module | `src/modules/companyapp/` |
| Per-tenant manifest | `/api/o/{orgId}/manifest` |
| Per-tenant icons | `/api/o/{orgId}/icon/{size}[-maskable].png` |
| App & Branding centre | `/o/{orgId}/settings/app` |
| Operator readiness | `/platform/apps` |
| Offline shell + service worker | `/offline`, `/sw.js` |

Migrations 0134–0136 are additive. No existing row changes and an organisation
with none of the new rows behaves exactly as it does today.

---

## 2. The four decisions that shaped it

### The manifest `id` is the organisation UUID, never the name or slug

Per the spec, a manifest whose `id` matches an installed app replaces that app's
manifest; a new `id` creates a new app. Keying on the immutable organisation id
means a company can rename itself, or change its app name, without acquiring a
second installed application or losing the one it has.

### There is no response cache, deliberately

The service worker precaches one public offline page and is otherwise
network-only. Every company is served from the same paths, so a response cache
here would hold one company's data and hand it to whoever signed in next — no bug
required. MDN confirms a service worker is not required for installability, so
the only thing this one buys is a decent offline screen, and that is all it does.

Consequences, stated rather than discovered: no offline reading of business
records, no background sync, no offline write queue — so the app can never claim
a saved transaction that never reached the server.

### The fallback is the product, not a consolation

`*.idaraworks.com` needs a nameserver migration (§4). Rather than shipping a
disabled feature, H31 makes the **existing origin** the working address: distinct
per-tenant `id`, `start_url` and `scope` install as genuinely separate
applications from one origin, which the spec explicitly permits. Every customer
gets a branded installable app today, with no DNS change and no purchase.

### A hostname selects a tenant; it never authorises one

Everything in the resolver narrows *which* organisation a request might be about.
`resolveCtx` still proves membership afterwards, unchanged. A user who types
another company's address reaches the resolver and then fails the membership
check exactly as they do today.

---

## 3. What was tested, and the three defects the tests found

| Gate | Result |
| --- | --- |
| Format, lint (boundary + tenancy rules), typecheck | clean |
| Unit tests | **1,674 passed**, 110 files |
| Dependency audit | 545 packages, 0 advisories at or above `high` |
| Production build | compiled; all six new routes present |
| **CI on the exact commit `6fa05fe`** | **green, both jobs** — including the full integration suite and the two-organisation bleed harness against a fresh stack with 0134–0136 applied in order |
| H31 integration suite | **23 passed** on the isolated test project |
| Flag-off production smoke | **16 of 16 passed** |
| Residue | **0** |

### The defects

**A hostname containing a colon was accepted.** `acme.idaraworks.com:abc` failed
the numeric-port strip and was then classified whole. Any colon surviving the
strip now refuses the host.

**Slug availability was blind to other tenants.** The check read `tenant_host`
through the tenant's own connection, and RLS scopes that to the caller — so a
hostname another company already held read as *absent*. Two tenants were both
told one name was free, and only the unique index stopped the second, as a raw
constraint violation. Migration 0136 adds a cross-tenant boolean; the same fix
was applied to the in-transaction clash checks in both claim paths.

**Two lint findings fixed rather than suppressed**: device facts read in lazy
`useState` initialisers instead of written from an effect, and `next/link` on the
offline page.

All three have permanent regression tests.

---

## 4. The hosting reality, from primary sources

Vercel, *Adding & Configuring a Custom Domain*, updated 2026-08-28:

> "If using your custom domain as a wildcard domain, you **must use the
> nameservers method for verification**."

`idaraworks.com` uses Cloudflare nameservers. So `*.idaraworks.com` requires
moving the domain onto Vercel's nameservers and re-creating every existing DNS
record, mail included — an owner-only decision explicitly outside this mandate.

**The blocker is registrar authority, not money.** The same page states Hobby
teams may have 50 custom domains per project, and ordinary subdomains are
configured with a CNAME. Per-customer subdomains therefore need no plan change
and no migration — one CNAME and one Vercel domain each.

### The deployment cap, and a correction to H30

H31 was merged with a **merge commit** specifically to avoid H30's same-SHA trap,
and Vercel still created nothing. No project of any kind saw the merge commit,
which ruled out dedup. The CLI then answered plainly:

```
Resource is limited - try again in 24 hours
(more than 100, code: "api-deployments-free-per-day"). (402)
```

The Hobby 100-per-day allowance was exhausted. **Five** Vercel projects build on
every push to this repository, so one push costs five deployments.

This corrects H30's truth map §A.10, which left the same silence "unexplained,
and not guessed at". It was this cap. The remedy needs no purchase: disconnect
the four projects that do not serve the site (owner action O31-3).

---

## 5. Where H31 stands against its definition of done

| Requirement | State |
| --- | --- |
| A company can configure valid application branding | **done** — settings centre, all fields optional, safe fallbacks |
| A safe company slug can be claimed | **done** — normalised, reserved-checked, unique platform-wide, audited |
| A direct IdaraWorks address | **path mode live; subdomain needs one owner step per customer** |
| Correct tenant-specific manifest and icon set | **done** |
| Installation genuinely available on supported browsers | **built; awaiting the activation redeploy** |
| Launching opens the correct company workspace | **done** — `start_url` and `scope` are org-scoped |
| Signed-out and unauthorised flows are safe | **done** — membership still proven after host resolution |
| Cross-tenant leakage disproved by tests | **done** — 23 integration tests, sequential-request isolation |
| Sensitive content not cached offline | **done** — nothing is cached but one public page |
| Existing domains and workflows intact | **done** — flag-off smoke, counts unchanged |
| English and Arabic verified | **partial** — copy complete in three languages and parity-tested; the browser walk of the new screens was not run (see §6) |
| Spanish parity intact but disabled | **done** — 60 + 14 keys added in all three; `FEATURE_LOCALE_ES` untouched |
| CI green on the deployed commit | **done** |
| Production serves the expected commit | **done** — `6fa05fe` |
| Flag-off smoke passes | **done** — 16 of 16 |
| Flag-on smoke passes | **not yet possible** — needs the activation redeploy |
| Zero residue proved | **done** |
| Customer counts unchanged | **done** — 40 / 61 / 51 / 78 |
| H30 blockers still visible | **done** |
| PO-002 untouched | **done** |
| H32 not started | **done** |

---

## 6. Stated honestly, not glossed

**The flag-on production smoke has not run.** It cannot until one more deployment
exists. Everything it will check has been proved on the isolated test project and
in CI, but that is not the same as proved in production, and the report does not
pretend otherwise.

**The new screens were not driven in a real browser.** The unit and integration
layers cover the logic, the build proves they compile and the copy is
parity-tested in three languages — but no screenshot of the settings centre or
the install flow exists, because the local preview would have needed a deployment
allowance that was gone. Owner action O31-4 is exactly this check.

**Customer-uploaded app icons are not implemented.** The icon endpoint is
unauthenticated by necessity, and serving a customer's private storage object
from it is how a private asset becomes public. The generated mark ships; the
upload path was left un-built rather than half-built.

**Custom-domain verification is a foundation, not a feature.** The claim, the
token, the uniqueness constraint and the audit exist. Nothing checks DNS
server-side yet, and the UI says "Not yet available" rather than implying a
workflow that would never complete.
