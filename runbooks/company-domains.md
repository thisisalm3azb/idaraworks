# Company addresses — activation, incidents and rollback

The operational half of H31. Everything here changes what a hostname points at,
so read the whole of §1 before running anything in §2.

---

## 1. The rules that do not bend

1. **A pending claim routes nothing.** A customer can reserve an address; only a
   platform operator can make it live. That gap is deliberate and is where the
   DNS step happens.
2. **Activation is not a UI button.** There is no operator control that activates
   a hostname, on purpose — a mis-click beside a list of companies is how a
   domain gets reassigned.
3. **A hostname belongs to one organisation, ever.** A platform-wide unique index
   enforces it. If a claim fails with a constraint violation, somebody else holds
   that name; find out who before doing anything else.
4. **A released hostname is quarantined for 90 days.** Bookmarks and installed
   apps keep pointing at an address long after a company stops using it, and
   handing it to a different tenant inside that window is the worst outcome this
   system can produce.
5. **Never activate a host whose DNS does not already resolve to us.** Activating
   first means the app claims an address the internet does not agree about.

---

## 2. Activating a company subdomain

### Before you touch anything

```bash
# Read-only. Confirms the claim exists, is pending, and belongs to who you think.
npx tsx tooling/scripts/h31-host-status.ts --host=theirname.idaraworks.com
```

Check three things in the output: the organisation is the right one, the status
is `pending`, and no other row holds that host.

### Step 1 — DNS (Cloudflare)

Add a **CNAME**: `theirname` → the CNAME target shown in Vercel for the
`idaraworks` project (Settings → Domains → any subdomain shows it).

Leave the apex `idaraworks.com` and `www.idaraworks.com` records **exactly as
they are**. If you find yourself editing either, stop.

### Step 2 — Vercel

Add `theirname.idaraworks.com` to the `idaraworks` project. Wait until it shows
as valid and the certificate has issued. This is usually under a minute and
occasionally several.

### Step 3 — prove it before you promise it

```bash
curl -sI https://theirname.idaraworks.com/api/health | head -1
```

A `200` means TLS and routing are both real. Anything else means stop — the
customer is better off on the standard address than on a broken one.

### Step 4 — activate

```bash
npx tsx tooling/scripts/h31-host-status.ts \
  --host=theirname.idaraworks.com --set=active \
  --confirm=activate-host-in-anhgeeutrwftsvuzfinf
```

The script identifies production positively, checks the explicit `.ok` verdict,
and refuses without the exact phrase.

### Step 5 — tell the customer the one thing they will not guess

Anyone who already installed the app from the standard address must **install it
again** from the new one. The operating system identifies an installed app by its
origin, so the old install keeps working but stays on the old address.

---

## 3. Incidents

### "Our company address stopped working"

1. `curl -sI https://theirname.idaraworks.com/api/health` — is it DNS/TLS or the
   app?
2. If DNS: check the Cloudflare CNAME still exists and Vercel still lists the
   domain.
3. If the app answers but the workspace is wrong or missing, check the host row:
   a status other than `active` means it resolves to nothing by design.
4. **The customer is never stranded.** The standard address
   `https://www.idaraworks.com/o/<orgId>` always works. Give them that first,
   then fix the subdomain.

### "The wrong company appears at an address"

Treat as a security incident. Do not experiment.

1. Set the host to `failed` immediately — it stops resolving:
   ```bash
   npx tsx tooling/scripts/h31-host-status.ts --host=<host> --set=failed \
     --reason="under investigation" --confirm=activate-host-in-<ref>
   ```
2. Read the audit trail for that host id.
3. Only then work out how two organisations came to be associated with one name.

The resolver reads `active` rows only and a unique index prevents two live
claims, so this should be impossible. If it happens, the invariant broke and that
matters more than the symptom.

---

## 4. Rollback

**Rolling back H31 as a whole:** set `FEATURE_BRANDED_COMPANY_APPS` to anything
other than `1` and redeploy. Manifests and icons return 404, install affordances
vanish, host rows stop resolving, and `/o/<orgId>` behaves exactly as it did
before H31. No data is deleted and no customer loses access.

**Rolling back one company's subdomain:** set the host to `released`. It stops
resolving, and the 90-day quarantine starts. Tell the customer to use the
standard address, and that a re-install will be needed if they later return to a
subdomain.

**What rollback does NOT do:** it does not remove the Vercel domain or the
Cloudflare record. Leave both in place unless the customer has genuinely left —
removing them makes the address fail at the network rather than in the app, which
is harder to diagnose and looks worse.

---

## 5. Things that will bite

- **A CNAME added at the apex.** Cloudflare will accept `@` and it will break the
  marketing site. The record is `theirname`, never `@` and never `www`.
- **Cloudflare proxying (the orange cloud).** Vercel issues its own certificate;
  proxying through Cloudflare puts a second one in front and produces confusing
  TLS errors. Leave the record DNS-only unless you have a reason and know what
  you are doing.
- **Activating before the certificate exists.** The domain resolves, the app
  answers, and the browser refuses. Step 3 exists to catch exactly this.
- **Assuming a rename frees an address.** It does not. Renaming a company changes
  its display name; the hostname and the installed app identity are separate on
  purpose.
