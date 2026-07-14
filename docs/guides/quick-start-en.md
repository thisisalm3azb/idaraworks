# IdaraWorks — Pilot Quick Start (English)

Welcome to the IdaraWorks pilot. This guide gets you productive in about ten
steps. It is written for phones — most field work happens one-handed on the
workshop floor — but everything works the same on a laptop.

- **Where to go:** <https://idaraworks.vercel.app>
- **What you'll see** depends on your role. IdaraWorks shows each person only
  the screens and actions their role allows, so some steps below may not appear
  for you. That is expected.
- **Your terms may differ.** IdaraWorks is configured per organization. Where
  this guide says **Job**, your org may show **Project** or **Boat**; where it
  says **Daily report**, you may see your own house wording. The workflow is
  identical.
- **Numbers, dates, money** are shown in your configured currency and format.
  This guide never asks you to enter a password, card, or bank detail into any
  screen other than the sign-in box.

---

## 1. Sign in

1. Open <https://idaraworks.vercel.app> on your phone's browser. Add it to your
   home screen for one-tap access.
2. Enter the **email** and **password** you were given, then tap **Sign in**.
   - You receive access by an **email invitation** from your organization's
     administrator. *[OWNER ACTION]* If you have no invitation yet, ask your
     admin to invite you — you cannot self-register into an existing org.
   - If your org uses Google or Microsoft sign-in, use **Continue with Google**
     / **Continue with Microsoft** instead.
3. If your account has **two-step verification** turned on, enter the 6-digit
   code when prompted.
4. Opened an **invite link**? Sign in first, then tap **Accept invitation** to
   join the organization.

After signing in you land on your organization's home — your **Today** screen.

> Trouble signing in? "Too many attempts" means wait a few minutes and retry.
> "Check your inbox to confirm your email" means open the confirmation email
> first, then sign in.

---

## 2. Your Today screen

**Today** is your home. It is composed live for your role and always shows the
freshest picture — each card is stamped with when it was computed.

- **Field roles (foremen)** see a *doing* screen, not a monitoring one:
  - **My jobs today** — the jobs assigned to you, with when each was last
    reported ("no report since Tue" tells you where you're behind).
  - **Submit daily report** — the jobs still missing today's report.
  - **Waiting on me** — reports that were **returned** to you for a fix.
  - There are **no money figures** on the field screen.
- **Managers / owners** see an operational screen: reports to review, blockers,
  missing reports, overdue work, and decisions awaiting you. Owners and
  accounts roles also see the **Daily digest** (step 8).

Tap any card to act on it. On a phone, the **bottom bar** is your main
navigation (Today, Work, Approvals, and so on); on a laptop the same items are
in the top bar.

---

## 3. Create a job

*(For managers, admins, and owners — field roles skip this.)*

1. Go to **Work / Jobs** from the navigation.
2. Tap **New job** (it may read *New Project* or *New Boat*).
3. Choose a **Preset** — the job template your org configured (this seeds the
   stages and defaults, so you don't start from a blank slate).
4. Give it a **name**, pick the **customer**, and tap **Create job**.
5. The new job opens on its own page with its **stages** laid out. Assign a
   foreman so it shows up on their **Today** screen.

> If you see "Active job limit reached for your plan," your pilot plan has hit
> its cap on active jobs — archive a finished one or ask your owner about the
> plan.

---

## 4. Submit a daily report (on mobile)

This is the core field habit — one short report per job, per day.

1. From **Today**, tap **Submit daily report** (or open **Reports → New**).
2. Pick **which job** and confirm the **date** (defaults to today).
3. Fill only what applies — the form is built to be quick with one thumb:
   - **What did you do today?** — a short summary.
   - **Progress** — add a stage note: which stage moved and roughly how far
     (the "how far" is optional).
   - **Who worked** — add each worker with their **hours** and any
     **overtime**.
   - **Materials used** — search your item list, or just type a material name,
     then enter **quantity** and **unit**.
   - **Anything blocking?** — note blockers so they surface to your manager.
4. Tap **Submit report**.

**Weak signal on the floor?** If the submit can't reach the server it is
**saved on this device** ("we'll submit when you retry"). When you're back on
signal, reopen it and tap **Retry submit**. You can also **Save draft** and
finish later — a saved draft is restored the next time you open the form.

One report per job per day: if one already exists for that date, edit it
instead of creating a duplicate. If a report of yours was **returned**, open it,
fix what the reviewer noted, and **resubmit**.

---

## 5. Raise an issue

Anyone on the floor can flag a problem — a shortage, a defect, a delay.

1. Open **Issues** and tap **Raise an issue**.
2. Describe **what's the problem** and, optionally, add **details**.
3. Set the **severity** — Low, Medium, High, or Critical.
4. Tick **This is blocking work** if it's stopping progress. Blockers are
   surfaced prominently on the manager's **Today** screen, so use it honestly.
5. Optionally link the **related job**, then tap **Raise**.

Managers can later mark an issue **Resolved** (or reopen it). Blocking issues
feed the operational picture until they're cleared.

---

## 6. The approval inbox

Requests that need a decision — a material request, a quote to send, and so on —
are **routed to the right person** and wait in their inbox.

1. Open **Approvals**. Each item shows its **title**, **who requested it**, and
   that it was **routed to you**.
2. To agree, tap **Approve**.
3. To decline, type a short **reason for rejection**, then tap **Reject** — the
   reason is required so the requester knows why.
4. "Decision recorded" confirms it; the item leaves your inbox.

You **cannot approve your own request** — IdaraWorks routes it to someone else.
"Nothing awaiting your decision" means your inbox is clear.

---

## 7. Record a payment

*(For accounts and owner roles.)* When a customer pays an invoice, record it so
receivables stay accurate.

1. Open **Payments** and tap **Record payment** (or **Payments → New**).
2. Choose the **invoice** — only **issued** or **partially paid** invoices
   appear.
3. Pick the **method**: Cash, Bank transfer, Cheque, Card, or Other.
4. Set the **payment date** and the **amount**, and add an optional
   **reference** (e.g. a transfer or cheque number — **never** a full card or
   bank account number).
5. Tap **Record payment**. It is saved as **Recorded**, and the customer's
   receivables (AR) update accordingly.

> Recorded the wrong one? Use **Void** with a reason rather than deleting it —
> the trail stays intact.

---

## 8. Read the owner digest

*(For owners, managers, and accounts.)* Each working morning IdaraWorks composes
a **Daily digest** from your real data and pins it to your **Today** screen — so
you start the day knowing what needs you, without digging.

Typical sections:

- **Needs your decision** — approvals and items waiting on you.
- **At risk** — jobs slipping or without recent reports.
- **Collections** — overdue receivables to chase.
- **Supply delays** — purchase/receipt hold-ups.
- **Reported yesterday** / **Crew active yesterday** — what actually happened.
- **Customers awaiting an update**, and a **This week** roll-up.

Every line traces back to a real record — tap through to the source. "All clear
— nothing needs your attention" is a valid, good morning.

*[OWNER ACTION]* The digest is produced by a scheduled overnight run. It appears
automatically once your organization's background scheduler is provisioned; if a
morning's digest is missing during the pilot, flag it to your admin. An optional
plain-language narration can be turned on per plan — it only rephrases the same
figures, it never invents numbers, and it is **off by default**.

---

## 9. Switch language (English / العربية)

IdaraWorks is fully bilingual and the whole layout mirrors to **right-to-left**
for Arabic.

1. Tap your **Account** (top bar, or the account link in the menu).
2. Under **Language**, tap **English** or **العربية**.
3. The choice is remembered for your account and applies everywhere the next
   time each screen loads. "Language updated" confirms it.

For the Arabic edition of this guide, see **quick-start-ar.md**.

---

## 10. Good habits for the pilot

- **One report per job, every working day** — the digest and every manager
  screen are only as good as the reports feeding them.
- **Raise blockers early** — a flagged blocker reaches your manager the same
  day; a silent one costs a day.
- **Decide from your inbox** — approvals routed to you hold up someone else's
  work until you act.
- **Keep it on your home screen** — it behaves like an app and remembers your
  language and session.

### If something looks wrong

- **Wrong or missing figure?** Note the screen and the time — every screen
  stamps when it was computed, and support can trace it. Report it; don't work
  around it.
- **Can't see a screen you expect?** It is almost always your **role**. Ask your
  admin to confirm your permissions rather than sharing another person's login.
- **A page erred?** The error page shows a short **reference code**. Send that
  code to your admin — it lets support find exactly your request in the logs.

Thank you for piloting IdaraWorks. Your daily reports, issues, and decisions are
what make it useful — keep them flowing.
