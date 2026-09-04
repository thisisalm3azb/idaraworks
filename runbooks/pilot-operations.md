# Pilot operations — creating a pilot company, supporting it, and talking to it

Written for H30. Everything here is a procedure a person follows; nothing in it
runs automatically, and nothing in it touches a tenant's business data without
that tenant asking.

---

## 1. Creating a pilot company

A pilot company is created **the same way a real customer creates one** — through
signup and guided setup, in a browser, by the pilot customer themselves. There is
deliberately no operator "create tenant" button, and no script that seeds one.

That is a decision, not an omission. A tenant created by a script skips the very
path the pilot exists to test, and produces a workspace nobody can reproduce.

### The procedure

1. **Confirm capacity first.** Check `/api/health`: `ok: true`, `db.ok`,
   `storage.ok`, and `queue.alert: false`. If `queue.alert` is true, resolve it
   before onboarding anybody — see §4.
2. **Send the customer to `https://www.idaraworks.com`** and have them sign up
   with a real work email they control. Do not create the account for them: the
   first login is the thing being tested, and a password you chose is a
   credential you now hold.
3. **They complete guided setup themselves.** Watch, take notes, do not drive.
   Every place they hesitate is a finding.
4. **Record the organisation id** (visible in the URL as `/o/<orgId>/`) in the
   pilot register alongside the company name and the date. This is the only
   identifier support should ever need.
5. **Confirm the free base is what they are on.** Nothing is charged during the
   pilot: `BILLING_PROVIDER` is unset, so the disabled provider stands and no
   payment can be taken. Say so explicitly rather than letting them assume.

### What to check within the first hour

| Check | Where | Why |
| --- | --- | --- |
| They can log in again after signing out | their browser | the session path, not just signup |
| Their workspace language is the one they chose | any screen | the locale must persist to the profile |
| A second user can be invited and can accept | Settings → People | invitation is the most common early failure |
| If they will use stock: a warehouse exists with a receiving bay | Stock → Warehouses | without it, goods receipts record but never become stock (H30 LB-2) |

That last row is a launch lesson, not a formality. An organisation with no
receiving location can receive goods all day and hold nothing.

---

## 2. Supporting a pilot company

### The rule about their data

An operator may look at **metadata** — is the tenant healthy, how many records,
when did something happen, what does the audit trail say — without asking.

Reading **content** — a customer's name, an invoice's lines, a document's body —
requires the tenant's request, and is done through impersonation, which is
recorded. `runbooks/impersonation-history.md` is the procedure and
`runbooks/break-glass.md` covers the exception.

Do not open a tenant's records "to have a look" before a support conversation.
The audit trail does not distinguish curiosity from diligence, and neither will
the customer.

### Triage order

1. **Is it the platform or the tenant?** `/api/health` answers this in one
   request. A red `db` or `storage` is an incident (§4); everything else is a
   tenant question.
2. **Is it a permission?** The most common report — "the button isn't there" —
   is usually a role. Check their role in Settings → People before assuming a
   defect.
3. **Is it a release flag?** A surface that does not exist for anyone is a flag,
   not a fault. The flags and their exact values are in `docs/H30-TRUTH-MAP.md`
   §A.2. The only enabling value is the string `"1"`.
4. **Is it a known limitation?** `docs/H30-TRUTH-MAP.md` §A.5 lists them with
   their status. Say which one it is rather than promising a fix.

### What support must never do

- Never run `tooling/scripts/s7-cleanup.ts` against production to "tidy up". It
  deletes organisations. It now refuses anything that is not a proven fixture,
  and that guard is the last one, not the first.
- Never re-record a goods receipt to fix missing stock. That creates a second
  delivery. Use **Add this delivery to stock** on the purchase order, which
  replays the same receipt and cannot double-count.
- Never edit a tenant's rows directly in the database. If the product cannot do
  it, that is the finding.

---

## 3. Customer communication templates

Plain, short, and true. No apology theatre, no invented timelines.

### Planned maintenance

> **Subject: IdaraWorks maintenance, {date} {start}–{end} {timezone}**
>
> We are making a change to IdaraWorks on {date} between {start} and {end}
> {timezone}.
>
> What you will notice: {nothing / the app will be briefly unavailable / X will
> be read-only}.
>
> What you need to do: nothing.
>
> We will send one message when it is finished.

### Something is broken, and we know

> **Subject: IdaraWorks — {feature} is not working**
>
> Since about {time} {timezone}, {plain description of what does not work}.
> {What still works.}
>
> Your data is not affected. {Or, if it is: exactly what is affected.}
>
> We are working on it now. The next update from us will be at {time}, whether or
> not it is fixed by then.

The second sentence of that last paragraph is the important one. A promised
update time that is kept builds more confidence than a fast fix that is silent.

### It is fixed

> **Subject: IdaraWorks — {feature} is working again**
>
> {Feature} has been working normally since {time} {timezone}.
>
> What happened: {one or two sentences, no jargon, no blame}.
>
> What we changed so it does not happen again: {specific, or "we are still
> deciding — we will tell you what we choose"}.

### We are not going to build that

> Thank you — that is a fair request and we are not going to do it for the pilot.
>
> {The reason, in one sentence.}
>
> {What they can do instead, if anything.}

---

## 4. Incidents

`runbooks/incident-response.md` holds the full procedure. Two H30 additions:

**The queue can fail silently, and now says so.** Before H30 the health check
raised `alert` only on a dead letter — which requires a worker that tried and
gave up. With no worker at all, jobs simply waited, and production sat 3.2 days
with eleven of them while reporting itself content. `queue.stale` is now true
when work has waited more than an hour, and `queue.alert` includes it.

**A stale queue is not an outage.** Nothing a person does in the app depends on
it: the queue carries document renders and notifications. Treat it as a P2 —
customer-visible degradation, fix within the working day — unless it is
accompanied by a red `db` or `storage`, which is a P1.

---

## 5. What an operator can see, and where

| Question | Where | Needs impersonation |
| --- | --- | --- |
| Is the platform up? | `/api/health` | no |
| Which organisations exist and how healthy | `tooling/scripts/test-residue.ts` (read-only) | no |
| What a tenant's users did | platform audit tables | no |
| What a tenant's records say | the tenant's own screens | **yes** |
| Which pack or locale versions are released | `/platform/countries`, `/platform/languages` (H29, flag-gated) | no |

There is no operator screen that renders a tenant's business records. That is
deliberate: the way to read a customer's invoice is to be invited into their
workspace, with the visit recorded.
