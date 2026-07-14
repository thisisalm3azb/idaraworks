# IdaraWorks — Founder End-to-End Test Guide (verified)

**You** do every step in the real production app. I created no org, seeded no data, sent no invite,
installed no template. I verified the journey against the **deployed** app (`commit 97985e1`) — live
for the public screens, and by exhaustive read-only source verification + an adversarial blocker-hunt
(17 agents) for the authenticated journey, because logging in requires an account, which is yours to
create. After you finish, I inspect the resulting org and prepare a **guarded** cleanup.

- **Do NOT touch** `Alpha Marine` or `TESTING` (protected orgs). You create a **new, third** org.
- **Enter the org name yourself.** Suggestion: something obviously temporary like **`Alpha Test`**
  (`Alpha Test` ≠ the protected `Alpha Marine`). It must be clearly disposable.
- The journey takes **no real money** and touches **no legally-binding path** (payment collection +
  e-invoice submission are disabled in prod). Verified: nothing on the path demands a card or D1.

---

## 0. Verified reality — READ THIS FIRST

The **core operational journey works end-to-end and no step hard-crashes.** Every mutation (sign up,
create org, onboard, create job, file report, approve, MR→PO→GRN, invoice, record payment) is
**synchronous** and succeeds without any of the disabled providers.

But verification found **one infrastructure gap with real consequences** plus a few smaller defects.
None *stops* the test, but you should know them so you don't mistake expected behaviour for a bug — or
so you (owner) fix the quick ones first.

### 🔴 Finding 1 — Background/async processing is OFF in prod (Inngest unprovisioned)
`INNGEST_*` is unset, `vercel.json` has no cron, and the outbox relay is Inngest-only — so **no
background worker ever runs.** Confirmed root cause; downstream effects **you will see**:

| What breaks | What you'll observe |
| --- | --- |
| **Document PDFs** (LPO purchase orders, invoice PDFs) | Stay **"PDF pending"** forever — no download |
| **Cost roll-up refresh** | A job's Costing computes **once, on first view**, then does **not** update when you add more reports/receipts/expenses — figures can be **stale** |
| **Owner digest + Today "exception" cards** | Stay **empty** (nightly engine never runs) |
| **Push notifications, subscription dunning** | Never fire (dunning is irrelevant to a no-payment pilot) |

**None of these crash anything** — mutations still succeed; only the derived/async outputs are missing.
**Owner fix (recommended before testing):** provision Inngest (`runbooks/inngest-provisioning.md`) and
set the keys in Vercel. **Workarounds if you test without it:** (a) open a job's **Costing last**, after
you've entered that job's data, so the first (and only) computation is complete; (b) treat "PDF pending"
and empty digest/exception cards as *expected*, not defects.

### 🟠 Findings 2–4 — Owner-fixable config (one line each; fix before inviting anyone)
2. **Invite links show `http://localhost:3000/invite/…`** — `APP_URL` is unset in prod. Verified in
   `settings/members/page.tsx:40` + `identity.ts:195`. Any invitee link is unusable as-is. **Fix:** set
   `APP_URL=https://idaraworks.vercel.app` in Vercel. (Workaround: swap the host by hand before sending.)
3. **Customer-update share links are host-less** (`/s/<token>` with no domain) — a *different* var,
   `NEXT_PUBLIC_APP_URL`, governs these (`customer-updates/actions.ts:87`) and it's also unset. **Fix:**
   set `NEXT_PUBLIC_APP_URL=https://idaraworks.vercel.app` too. **Set BOTH** — one var covers invites,
   the other covers customer shares.
4. **Signup email confirmation** depends on the **Supabase dashboard**, not app code. If "Confirm email"
   is ON (Supabase default) with no custom SMTP, the confirmation email comes from Supabase's built-in
   mailer (rate-limited, may land in spam). **Fix (owner, Supabase dashboard):** either turn OFF
   "Confirm email" for the pilot, or set a custom SMTP + verified sender + **Site URL =
   `https://idaraworks.vercel.app`** (also needed so the confirm link returns you to the app). If you
   ever see "invalid credentials" right after signup, it's really "email not confirmed."

### 🟡 Findings 5–7 — Product UX defects (code fixes; they don't block the test)
5. **Onboarding job-terminology is echoed but not applied.** On the intake screen you set what to call a
   "job" (English + Arabic). The proposal summary repeats your words — **but Apply does not save them**;
   the template default (**"Boat" / "قارب"**) wins. (Your *thresholds* DO apply — only terminology is
   dropped, which is inconsistent.) **You can still get your term:** after onboarding, set it in
   **Settings → Configuration** (that editor works and persists). Expect to do this manually.
6. **Mobile header overflows at 375px.** The top action bar doesn't collapse, so signed-in pages scroll
   sideways a bit on a phone; the intended bottom-nav is built but not mounted, so section nav is a wall
   of wrapping pills. Everything is reachable/tappable — it's polish, not a dead-end.
7. **e-invoice "Submit" button** shows a permanent **"Pending"** with no "not provisioned" hint. The
   label is truthful (never "Cleared"); nothing is transmitted. Cosmetic.

### ✅ Everything else verified clean
Auth/registration; no-org→org-creation routing (no DB step, no service-role key); onboarding fully
UI-completable; **deterministic proposal with no fake LLM**; **explicit Apply — template never silently
installed**; **template catalogue honest** (one real template, named verbatim, no fake options,
forged keys rejected); review/approve; Arabic/English/**RTL** (reachable via **/account** after login);
**no real payment or D1 required**; and **every disabled provider degrades gracefully — none hard-fails**
(billing, e-invoice, AI, OAuth, Resend, Upstash, Sentry, malware-scan all no-op safely).

> **Recommended before you start:** owner does Findings 2–4 (set `APP_URL` + `NEXT_PUBLIC_APP_URL`,
> sort Supabase email) and ideally Finding 1 (Inngest). Say the word and I'll prep the Vercel env + a
> `vercel.json` cron option for your approval — I won't change anything without it.

---

## 1. Exact URL
**https://idaraworks.vercel.app/signup**

## 2. Exact first screen
**"Create your account"** — Full name · Email · Password (helper: "At least 10 characters.") · **Create
account** button · "Already have an account? **Sign in**". *(Live-verified, desktop + 375px.)*

---

## 3–4. Step-by-step journey + what to choose

### Step 1 — Sign up (`/signup`)
- Full name · Email **abdullaalojan@gmail.com** · Password **≥ 10 chars** → **Create account**.
- Then either: **session issued** → straight to org creation (Step 3); or **"Check your inbox to
  confirm"** → open the Supabase confirmation email, click it, then log in (Finding 4).

### Step 2 — Log in (`/login`)
- Email + password → **Sign in**. *(Optional to test: TOTP MFA / phone-OTP from `/account` — never
  required; a new org has MFA off.)*

### Step 3 — Create your organization (`/onboarding`)
- **Organization name** — *you type it* → e.g. **`Alpha Test`** (min 2).
- **Country** — default **AE** (options AE, SA, QA, KW, BH, OM, US, GB).
- **Base currency** — default **AED** (try KWD/BHD/OMR to test 3-decimal).
- **Six-day work week** — tick if Sat–Thu.
- Submit → org + your owner membership created **through the app, no DB step** (verified).

### Step 4 — Business onboarding intake (`/o/<orgId>/onboarding`)
Fill: **Business name** · Country · Base currency · **Job term (English + Arabic)** · **Auto-PO
threshold** · **Auto-MR threshold** · Six-day week · VAT registered. Submit → a **proposal** is
generated (deterministic). **Note Finding 5:** your job-term words won't stick on Apply — you'll set
them in Settings after. Thresholds *will* stick as approval rules.

### Step 5 — Review the proposal → Apply (`/o/<orgId>/onboarding/<sessionId>`)
- You see the proposed **template** (`boatbuilding_marine_v1`, shown verbatim) + a **"will apply"** list
  incl. a **template-install** line. **Nothing installs until you press Apply** (verified — there's also
  an **Undo**). Review, then **Apply**.

### Step 6 — Configure (Settings + Roles + Approvals)
- **Settings → Configuration** — confirm stages/VAT/thresholds; **set your job terminology here** (EN +
  AR) since intake didn't apply it (Finding 5).
- **Members** — invite User 2/3… you get a **copyable link** (Finding 2: fix `APP_URL` first, or swap
  the host by hand). **No invite is sent until you choose to.**
- **Roles** — assign `manager` / `foreman` / `procurement` / `accounts` / `viewer`.
- **Approvals** — rules per subject (payment / MR / PO): `none` / `every` / `above <amount>`.

### Step 7 — Run one real job through the loop
1. **Jobs → New** — first job (name + model/preset + selling price if any).
2. **Reports → New** — file a **daily report** (do this from your **phone**).
3. **Reports → Review** — approve it as manager.
4. **Material Requests → New** → convert to **Purchase Order** → **Goods Receipt**. *(PO PDF will show
   "pending" — Finding 1.)*
5. **Approvals** — approve per your rule.
6. **Costing → [job]** — open this **after** steps 2–5 for that job (Finding 1: it computes once).
7. **Quotes → New** → **Invoice → New** → **record a payment manually** (cash/bank/cheque — no gateway).
   *(Invoice PDF + e-invoice "Submit" will show pending — Findings 1 & 7.)*
8. **Customer Updates** — send/share (Finding 3: fix `NEXT_PUBLIC_APP_URL` for a usable link).
9. **Settings → Subscription** — expect **"activation unavailable"**, no checkout — verified, no charge
   possible.

---

## 5. What the AI onboarding should / should NOT do
**Does:** turn your intake into a **deterministic, grounded** configuration proposal built from the one
real template (Boatbuilding/Marine: 11 stages, boat presets), adapted with your currency/VAT/thresholds,
shown for **your explicit Apply**.
**Does NOT:** invent stages/master-data, silently install a template, or call an external LLM.
**Honest note:** despite the "AI onboarding" name, the AI branch is currently an **unwired stub** —
`getOnboardingProvider()` always returns the deterministic builder. It will **not** call an LLM even if
AI creds were added; enabling real AI would require a code change. So in practice this is **deterministic
onboarding**, and that's the shipped path — reliable, not degraded.

## 6. Manual fallback
The deterministic build **is** the shipped path (not a fallback mode). Anything you don't like, edit by
hand afterwards in **Settings → Configuration** (stages, terminology, VAT, approvals) and **Masters**
(models/presets, items, suppliers). Nothing is a black box.

## 7. Disabled in production (credentials absent — expected)

| Capability | Prod state | You'll see / do instead |
| --- | --- | --- |
| App email (Resend) | OFF | Invites = **copyable link** (Finding 2) |
| Supabase auth confirmation email | dashboard-controlled | Confirm email; else Finding 4 |
| **Background workers (Inngest)** | **OFF** | **No PDFs, stale costing, empty digest/exceptions — Finding 1** |
| AI onboarding / AI narration | OFF (stub) | Deterministic proposal + deterministic digest |
| Billing / payment gateway | OFF | "Activation unavailable"; record payments manually |
| E-invoice submission | OFF | Invoices generate; "Submit" parks at Pending (Finding 7) |
| OAuth / SSO | OFF | Email + password |
| Sentry / Upstash / malware-scan | OFF | Safe no-ops; in-memory rate-limit fallback |

## 8. Test in **English and Arabic** (switch at **/account** → EN / العربية; app flips to RTL)
Signup/Login (English-only pre-login — switch is post-login) · Create org + onboarding + **proposal
preview** · Settings → Configuration · Jobs list + detail · **Daily report** (new + review) · MR→PO→GRN ·
Approvals · Costing/Quote/Invoice · Customer update. Confirm Arabic renders **right-to-left**.

## 9. Test at **375px mobile**
Signup (✅ live-verified) · Login · **Daily report — new** (primary field flow, one-handed) · Reports
review · Jobs list + detail · Approvals. Note the header scrolls sideways a little (Finding 6) — content
and taps still work.

---

## 10. Pass / fail checklist

**Access & org creation**
- [ ] Signup accepts a valid account (email + ≥10-char password).
- [ ] You reach a logged-in state (session or confirm-email link).
- [ ] No-org user is routed to **Create organization**.
- [ ] You entered the org name yourself; org created with **no DB step**.
- [ ] Org is **new**; `Alpha Marine` + `TESTING` untouched.

**Onboarding & template honesty**
- [ ] Intake asks the §4 questions; terminology (EN + AR) is editable.
- [ ] A **proposal** is generated and shown for review.
- [ ] Template is **NOT** applied until you press **Apply** (Undo present).
- [ ] Template is the real `boatbuilding_marine_v1`; no fake/hallucinated config.
- [ ] Locale/currency/VAT reflect your choices.

**Roles, approvals, users**
- [ ] You can set approval rules and assign roles.
- [ ] Inviting yields a link (no invite sent until you choose). *(Expect localhost unless `APP_URL` set.)*

**Operational → money loop**
- [ ] Create a job.
- [ ] File a daily report (mobile) → review/approve.
- [ ] MR → PO → GRN completes; approvals fire.
- [ ] Costing rolls up for the job *(opened last; expect it not to re-refresh — Finding 1)*.
- [ ] Quote → Invoice → manual payment records.
- [ ] Customer update sends/shares.

**Disabled-feature safety (expected, not failures)**
- [ ] Subscription shows "activation unavailable"; no charge possible.
- [ ] No screen demands a real card, e-invoice, or OAuth.
- [ ] PO/invoice PDFs show "pending"; digest/exception cards empty *(Finding 1 — expected)*.

**Bilingual & mobile**
- [ ] §8 screens work in English + Arabic (RTL) after switching at /account.
- [ ] §9 screens usable at 375px (minor header side-scroll expected — Finding 6).

---

### After you finish
Reply **"onboarding complete"** with the org name you chose. I'll then, **read-only first**: inspect the
org config, verify tenant isolation, confirm `Alpha Marine`/`TESTING` untouched, check your
template/terminology/roles/approvals, confirm the disabled seams behaved, list onboarding defects, and
prepare a **guarded cleanup dry-run** for the temp org. **No deletion without your explicit approval.**

---

## Appendix — verification evidence (directive checks C1–C14)

All **CONFIRMED** on `commit 97985e1` (live where marked ⚑, else read-only source + adversarial review):

- **C1** register/authenticate ⚑ — `/signup`, `/login` render; `signInWithPassword`/`signUp` wired; MFA optional.
- **C2** no-org → org-creation ⚑ — `resolveLanding` sends memberless user to `/onboarding`; unauth bounces to Sign-in.
- **C3** org creation, no DB step — `createOrgForUser` → `app.create_org_with_owner` (DEFINER, granted to `app_user`); no service-role key.
- **C4** onboarding UI-completable — intake→proposal→apply all in-UI; no disabled seam on the path.
- **C5** AI proposal when available — **CONCERN**: AI branch is an unwired stub (deterministic-only); prod-safe.
- **C6** deterministic/manual fallback — `buildGroundedProposal` pure, template-grounded, no AI dep, no fake LLM.
- **C7** review + approve — Apply button only when `status='proposed'` + `config.manage`; start installs nothing.
- **C8** catalogue honest — exactly one template, named verbatim, no fake list.
- **C9** only-existing selectable — `template_key` not user-injectable; unknown keys rejected at install.
- **C10** no silent Boatbuilding — install only inside Apply, disclosed in "will apply" before you approve.
- **C11** terminology editable before apply — **defect (Finding 5)**: intake terms echoed but not applied; Settings editor works.
- **C12** Arabic/English/RTL ⚑ — reachable via `/account`; `dir=rtl`; ar catalog at parity; pre-login is English-only.
- **C13** mobile ⚑ — 44px targets, single-column forms; **header overflow (Finding 6)**.
- **C14** no real payment/D1 — trial plan seeded; subscription hides checkout; manual payment; no processor called.

**Blocker-hunt verdict:** every "blocker" raised by the happy-path lenses was **refuted** by adversarial
review (all minor/cosmetic, degrade gracefully). The genuine issues are the async-fleet gap (Finding 1)
and the config/UX items (Findings 2–7) above — **none hard-stops the founder journey.**
