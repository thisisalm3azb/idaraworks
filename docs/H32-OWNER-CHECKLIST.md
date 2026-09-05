# H32 — what the owner has to decide

Short, because the phase is short. Nothing here is urgent and nothing here
blocks the pilot; the feature ships behind a flag and does nothing until it is
turned on.

---

## 1. The one number to look at first

The welcome tour greets **only people whose membership began on or after
2026-09-05**. Everybody already working in IdaraWorks is excluded, permanently
and by design — they can start the tour themselves from the account menu, but
they will never be interrupted by it.

The production smoke prints the real split:

```bash
npx tsx tooling/scripts/h32-prod-smoke.ts --confirm=<phrase> --expect-flag=on
```

Look for the line reading `memberships: N predate the cutoff (never
auto-greeted)`. If `N` is the whole customer base, the rule is working.

---

## 2. Read the tour and tell me if it is wrong

Four tours, one per kind of job. Each is five to seven short steps. The copy is
in `src/platform/i18n/messages/en.json` under `tour.*`, and the shape is:

| Tour | Who gets it | What it walks through |
| --- | --- | --- |
| Owner | owner, admin, manager | home → create → customers → jobs → invoices → team → where to find this again |
| Finance | accounts | home → quotes → invoices → payments → expenses → where to find this again |
| Supply | procurement | home → material requests → purchase orders → items → suppliers → where to find this again |
| Field | foreman, viewer | home → your work → daily report → attendance → problems → where to find this again |

**This is the part where your judgement beats mine.** I chose what a person in
each role probably needs on their first day. You know what they actually ask
about in week one. If a step is wrong or missing, say which and I will change
the words — the copy is data, not code, so it is a small change.

---

## 3. Decide when to turn it on

The flag is `FEATURE_GUIDED_ONBOARDING=1` in Vercel, production scope. Turning it
on affects only people who join from now on, plus anyone who deliberately opens
it from the account menu.

There is no rush and no dependency: H32 does not change the launch
recommendation, and **H30's five owner conditions remain open**.

---

## 4. Two things you may want changed later

- **The checklist is three items** — first customer, first job, first invoice.
  It sits on the home page, ticks itself from records that already exist, and
  disappears once done or dismissed. It creates nothing. If you would rather it
  asked for something else, that is a small change too.
- **"Invite your team" is deliberately not in it**, because the existing
  owner-home setup card already asks for that while a workspace is empty. Two
  cards asking the same question is how both get ignored.

---

## 5. Nothing here needs money, DNS or a purchase

No plan change, no domain, no third-party service, no new dependency.
