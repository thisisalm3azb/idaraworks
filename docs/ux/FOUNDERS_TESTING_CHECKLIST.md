# Founder testing checklist — first-use journey (U6)

Owner-facing script for tomorrow's founder testing. Work top to bottom; tick
each box **Pass / Fail** and note anything odd in the margin. Every failure
should name the screen + what you clicked.

- **URL:** https://idaraworks.vercel.app
- **Test accounts:** create FRESH accounts with disposable emails
  (`you+test1@…`). **Never** test inside the Alpha Marine or TESTING
  workspaces.
- **Rate limit:** signup allows **5 new accounts per hour per network** — plan
  the session accordingly (3 founder profiles fits comfortably).
- **Before the session (owner action):** the Supabase **Site URL / redirect
  allow-list** must point at the production domain (Auth → URL Configuration —
  see `docs/ux/AUTH_CALLBACK_FIX.md`). If not done, email confirmation links
  will not land back on the app.

---

## 1 — Signup & first login

| # | Step | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 1.1 | Open the URL logged out | Redirects to the Sign in screen; clean layout | ☐ | ☐ |
| 1.2 | "Create an account" → sign up (name, email, 10+ char password) | Clear errors on short password; account created | ☐ | ☐ |
| 1.3 | Confirm the email (hosted project sends a link) | Link returns to the app and lands on the onboarding welcome | ☐ | ☐ |
| 1.4 | Welcome screen | 4 promise bullets; "nothing is created until you confirm"; Get started works | ☐ | ☐ |

## 2 — The wizard, screen by screen

Progress bar + "Step X of 10" should update on every screen; the Back button
must return to the previous screen **with your answers still filled in**.

| # | Screen | What to try | Pass | Fail |
|---|--------|-------------|------|------|
| 2.1 | About your business | Leave name blank → blocked; pick an industry; write 1–2 real sentences | ☐ | ☐ |
| 2.2 | Where you operate | Change country → timezone/currency suggestions follow; pick **العربية** → the wizard flips to Arabic RTL immediately on the next screen (switch back if you want English) | ☐ | ☐ |
| 2.3 | Your team | Pick **1-5** employees → the sign-ins and departments questions disappear; pick a bigger band → they come back | ☐ | ☐ |
| 2.4 | How your work runs | Pick only "Selling ready products" → the start-to-finish question hides; pick a project/order pattern → it appears | ☐ | ☐ |
| 2.5 | What you need | Pick Quotes or Invoices → the customer-sharing question appears; without them it stays hidden | ☐ | ☐ |
| 2.6 | Mid-wizard resume | Close the tab (or log out) mid-wizard, come back, log in → you resume at the same screen with answers saved | ☐ | ☐ |

## 3 — Recommendation, proposal

| # | Step | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 3.1 | Recommended setup | The suggestion matches the business you described; a "why" sentence + match score; stages preview; honest "What it is not" list | ☐ | ☐ |
| 3.2 | Alternatives | "Other good fits" listed with previews; "See every available setup" expands the rest | ☐ | ☐ |
| 3.3 | Manual override | Choose a different template → proposal reflects it; go back → your pick is marked Selected; re-choose the recommended one | ☐ | ☐ |
| 3.4 | Proposal | Stages listed; "the words the app will use" — rename the unit of work (e.g. "Boat") and check it survives to review | ☐ | ☐ |

## 4 — Plan selection (the four tiers)

Nothing is pre-selected; **Continue must not appear until you choose**. There
must be **no card/payment fields anywhere** and the honest "no payment is
collected now" statement must be visible.

| # | Tier | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 4.1 | **Free** | Its own explicit button ("Start with Free"), never a default; seat/job/storage limits listed; "data never deleted" note | ☐ | ☐ |
| 4.2 | **Medium** | Price + "if bought individually" strikethrough + saving badge; expandable full add-on list; Choose Medium records the choice | ☐ | ☐ |
| 4.3 | **High** | Same honesty as Medium; "Most complete" badge | ☐ | ☐ |
| 4.4 | **Custom** | Build-your-own list: checkboxes for modules, +/− steppers for seat/storage packs, LIVE monthly total; unavailable items say why; empty selection is rejected with a clear message | ☐ | ☐ |
| 4.5 | After any choice | You land on branding; going Back shows "Your choice" recorded + Continue now available | ☐ | ☐ |

## 5 — Branding step

| # | Case | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 5.1 | Valid logo (PNG/JPG/WebP ≤ 2 MB, ≥ 32×32) | Preview on the checkerboard; Replace and Remove work | ☐ | ☐ |
| 5.2 | Wrong file (PDF/txt) | Clear inline error, nothing uploaded | ☐ | ☐ |
| 5.3 | Oversized file (> 2 MB) | Clear "larger than 2 MB" error | ☐ | ☐ |
| 5.4 | Accent colour | Swatch or hex; bad hex rejected | ☐ | ☐ |
| 5.5 | Skip | "Skip for now" goes to review; review says branding skipped | ☐ | ☐ |

## 6 — Review & confirm

| # | Step | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 6.1 | Summary | Business, template, renamed work-unit, plan choice + monthly total, branding — all match what you picked | ☐ | ☐ |
| 6.2 | Edit links | Each card's Edit returns to that screen; changes come back to review | ☐ | ☐ |
| 6.3 | Confirm | The button states exactly what will happen; ONE click creates the workspace and lands on the dashboard with a welcome banner | ☐ | ☐ |
| 6.4 | No seeded data | Jobs/customers/suppliers are EMPTY — the template configures structure only | ☐ | ☐ |
| 6.5 | Resume into the org | Log out and back in → you land in the workspace, never the wizard again | ☐ | ☐ |

## 7 — Dashboard expectations per role

The founder is the **owner**. Invite one member per role later to verify the
others (Settings → Members).

| Role | Expect | Pass | Fail |
|------|--------|------|------|
| Owner | KPI row (active/done/approvals/overdue), stage distribution, report trend, money cards (or honest locked cards when the module is off), at-risk, approvals, subscription strip at the bottom | ☐ | ☐ |
| Manager | Reports to review, missing today, blockers, stage + trend — **no money numbers unless price-privileged** | ☐ | ☐ |
| Foreman | One big "Submit today's report" action; my jobs; returned reports; **zero money anywhere** | ☐ | ☐ |
| Accounts | AR aging donut, payments trend, invoices to issue, expenses queue | ☐ | ☐ |
| Procurement | MR/PO pipeline counts, PO status donut, suppliers/items links | ☐ | ☐ |
| All | Template's own words everywhere (e.g. "Work Orders" / "Service Jobs"); sidebar groups match the role; locked items show a lock + honest hint, never a broken page | ☐ | ☐ |

## 8 — Language, RTL and phone passes

| # | Pass | What to verify | Pass | Fail |
|---|------|----------------|------|------|
| 8.1 | English desktop | Full journey above | ☐ | ☐ |
| 8.2 | Arabic | Switch in the wizard (region step) AND from the top bar on the dashboard: full RTL flip, Arabic copy everywhere, **no English fragments**, numbers stay Latin | ☐ | ☐ |
| 8.3 | RTL layout | Sidebar/drawer open from the right; back arrows point the right way; nothing overlaps | ☐ | ☐ |
| 8.4 | Phone (375 px) | Whole wizard + dashboard on a real phone: no horizontal scrolling, all buttons comfortably tappable, bottom navigation present | ☐ | ☐ |

## 9 — Known-expected limitations (do NOT file as bugs)

- **PDF exports stay "pending"** until the Inngest worker credentials are
  configured (owner action) — the record is correct, the file arrives later.
- **No emails are sent** (invites/notifications) — invite links must be copied
  and shared manually.
- **No payments can be taken**: the provider is disabled pre-D1. Tier/add-on
  choices are recorded honestly and the UI says so; nothing is charged.
- **Supabase Site URL**: if the owner action above wasn't completed, email
  confirmation links land on the wrong host — that is configuration, not app
  behaviour.
- **Signup rate limit**: 5 accounts/hour per network — a "too many attempts"
  message during rapid testing is by design.
- **WhatsApp/e-invoice/AI add-ons** show as gated/coming-later on purpose.

## 10 — Evidence

Automated evidence screenshots (login, wizard, tiers, owner dashboard desktop,
375 px dashboard, Arabic RTL dashboard) are produced by the founder-journey
e2e suite (`tests/e2e/founder-onboarding.spec.ts`) when run against a local
stack with `E2E_FOUNDER=1 E2E_SCREENSHOTS=1` — they land in
`docs/ux/evidence/`. The suite never runs against the hosted database.
