# H31 — the owner checklist

Only actions **you** must perform personally. Everything that could be done
without your money, your registrar access or your legal judgement is done.

H30's five owner conditions are still open and still apply. H31 does not change
the launch recommendation to unconditional GO.

---

## 1. The one decision that unlocks company subdomains

**O31-1 — Decide whether `yourcompany.idaraworks.com` is worth a nameserver
migration.**

This is the whole story, and it is smaller than it looks in one direction and
larger in the other.

**What Vercel requires.** Their own documentation (*Adding & Configuring a Custom
Domain*, updated 2026-08-28) says:

> "If using your custom domain as a wildcard domain, you **must use the
> nameservers method for verification**."

`idaraworks.com` currently uses Cloudflare nameservers. A wildcard
`*.idaraworks.com` therefore needs the domain moved onto Vercel's nameservers —
and their same page warns:

> "If you are verifying your domain by changing nameservers, you will need to add
> any DNS records to Vercel that you wish to keep from your previous DNS
> provider."

That means re-creating **every** existing record, mail included. It is not
expensive; it is risky, and it is yours to decide.

**The blocker is nameserver authority, not money.** The same page states Hobby
teams may have 50 custom domains per project. Nothing here needs a paid upgrade.

### Your two options

| Option | What it costs you | What customers get |
| --- | --- | --- |
| **A. Do nothing** | nothing | Every customer already gets a branded, installable app on the standard address. This is not a degraded mode — it works today. |
| **B. Add subdomains one at a time** | ~2 minutes per customer: one CNAME in Cloudflare, one domain added in Vercel, then mark it active | That customer gets `theirname.idaraworks.com` |
| **C. Move nameservers to Vercel** | an afternoon, and a real outage risk if a record is missed | Self-service subdomains for everyone, no per-customer step |

**Recommendation: B.** It needs no migration, is reversible per customer, and
the per-customer cost is trivial at pilot scale. C only pays off at a scale you
do not have yet.

### If you choose B, per customer

1. The customer reserves their address in **Settings → Company app**. It is
   recorded as *pending* and routes nothing.
2. In **Cloudflare**, add a CNAME: `theirname` → the CNAME target Vercel shows
   for this project (Settings → Domains). Leave the apex and `www` untouched.
3. In **Vercel**, add `theirname.idaraworks.com` to the `idaraworks` project.
   Wait for it to verify and for the certificate to issue.
4. Mark it active — see `runbooks/company-domains.md`, which has the exact
   command and the checks to run first.
5. Tell the customer they must **re-install** the app from the new address if
   they had already installed it from the standard one.

---

## 2. Finishing the activation — one command, once the cap resets

**O31-2 — Redeploy to activate the flag.** This is the only step between today's
state and a live branded app.

The flag is already set to the exact string `1` in the Vercel production
environment, and the flag-off production smoke passed 16 of 16. What is missing
is a deployment: Vercel binds environment variables when a deployment is
created, and the **Hobby plan's 100-deployments-per-day cap was reached** while
verifying H31, so no further deployment could be made today.

Once the allowance resets:

```bash
npx vercel redeploy https://idaraworks-6phwnfreg-najolatech-s-projects.vercel.app \
  --target production --scope team_QclRvv3fkiOghwLNOZDL8K6i
```

That redeploys the **exact source production already runs** (`6fa05fe`, the
CI-green commit) with the Production environment, so the only thing that changes
is the flag.

**Then run the flag-on smoke**, which has not yet been able to run:

```bash
npx tsx tooling/scripts/h31-prod-smoke.ts \
  --confirm=apply-migrations-to-anhgeeutrwftsvuzfinf --surfaces=on --expect-flag=on
```

If anything fails, `vercel env rm FEATURE_BRANDED_COMPANY_APPS production` and
redeploy — H31 disappears completely and no data is lost.

**O31-3 — Stop four projects from building this repository.** Five Vercel
projects (`idaraworks`, `-bfs`, `-bfsc`, `-cd61`, `-wfft`) build on every push, so
one push costs five deployments. Only `idaraworks` serves the site. Disconnecting
the other four cuts deployment usage by 80% and removes this cap as a recurring
obstacle. It costs nothing and needs no plan change.

**O31-4 — Look at one company's app yourself** before telling any customer it
exists. Open Settings → Company app in a real workspace, press Install on a
Windows or Android device, and confirm it opens into that workspace.

---

## 3. Decisions H31 deliberately did not make for you

| # | Decision | What H31 did instead |
| --- | --- | --- |
| **O31-5** | **Whether customer-owned domains are a paid feature.** | Built the foundation, labelled it "Not yet available", and activated nothing. No billing behaviour was invented. |
| **O31-6** | **Whether to accept customer-uploaded app icons.** | Ships the generated mark only. Serving a customer's uploaded image on an unauthenticated icon endpoint is how a private asset becomes public, and it was left un-built rather than half-built. |
| **O31-7** | **Whether to submit anything to an app store.** | Nothing was submitted, and no marketing language implies otherwise. |

---

## 4. What you do not need to do

- **You do not need to buy a domain.** Every customer gets a branded installable
  app on the standard address with no purchase.
- **You do not need a Vercel upgrade.** The wildcard blocker is nameservers, and
  the per-customer route needs no plan change.
- **You do not need to reinstall anything for updates.** The app is the web app;
  it updates when we deploy.
