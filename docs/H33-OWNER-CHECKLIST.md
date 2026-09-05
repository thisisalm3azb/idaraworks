# H33 — what the owner has to do

Everything H33 could do without you is done. What remains is the short list
below: each item needs either your dashboard access, your signature, or a
decision that is yours to make. Nothing here needs money unless it says so.

States used: **DRAFTED** (a document exists for your review) · **PREPARED**
(the technical work is complete; an external step remains) · **BLOCKED**
(needs access or credentials only you hold) · **DECISION** (a choice only you
can make). None of these is "done" until you say so.

---

## 1. Try the Pilot Lab (30 minutes to start)

```
npm run lab:open                          # see the five companies and nine roles
npm run lab:open -- tradeline finance     # opens one
```

Then follow `docs/H33-MANUAL-ACCEPTANCE.md` — the 30-minute critical check
first. Report problems as one line each in `docs/H33-ACCEPTANCE-LOG.md`.

The lab lives only in the test project. It cannot touch a customer.

## 2. Backups and restore — **BLOCKED** (O-1, O-2)

From this machine nobody can read your Supabase plan, whether point-in-time
recovery is on, or what backups exist: the CLI has no access token and the
dashboard needs your login. `docs/H33-RECOVERY-READINESS.md` has the exact
numbered procedure and the official documentation it relies on.

- [ ] Supabase dashboard → project `anhgeeutrwftsvuzfinf` → Settings → Billing: note the plan.
- [ ] Database → Backups: note whether PITR is enabled and the retention window; note the newest backup time.
- [ ] Decide whether to enable PITR (it is a paid add-on on the plan that supports it — the recovery document states the cost model from the official page).
- [ ] Run the restore rehearsal into a **new, disposable** project following the procedure; record RPO/RTO; delete the disposable project.

Until the rehearsal has been run once, the honest statement to a pilot customer
remains: "backups exist; the restore has not yet been rehearsed."

## 3. Data Processing Agreement — **DRAFTED** (O-3)

`docs/H33-DPA-DRAFT.md` is a full draft with every clause that needs a lawyer
tagged **[LEGAL REVIEW]**. It is not for signature.

- [ ] Send it for UAE (and, if a Saudi customer is in scope, KSA) legal review.
- [ ] Decide the breach-notification timeline it references (O-9) — the draft proposes one and marks it as your decision.
- [ ] Publish the subprocessor list (O-8): `docs/H33-SUBPROCESSOR-REGISTER.md` is the verified register; only Supabase and Vercel are active today.

## 4. Personal-data erasure — **DECISION** (O-4)

`docs/H33-ERASURE-POLICY-DRAFT.md` recommends a default and ends with a small
decision table. Only those rows need you:

- [ ] Audit trail: pseudonymise the actor on request, or retain under a legitimate-interest basis?
- [ ] Employee records after leaving: retain for the commonly cited period (verify with counsel), then anonymise?
- [ ] Customer contacts: erase on request, or retain where tied to an invoice?
- [ ] Account deletion for a person in several organisations: per-organisation or global?

Nothing in production is erased by any of this until you decide and the work is
built.

## 5. Background jobs — **PREPARED** (O-6)

Eleven events are waiting in production because the worker that would run them
(Inngest) is not connected. No email would be sent by any of them.
`docs/H33-INNGEST-READINESS.md` classifies each one and previews what replay
would do.

- [ ] Create the Inngest account and connect the `idaraworks` Vercel project (steps in `runbooks/inngest-provisioning.md`, checked against Inngest's current documentation in the readiness document).
- [ ] Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel (Production), redeploy, confirm `/api/inngest` and `/api/health`.
- [ ] Do **not** replay by hand — the relay cron drains the eleven on its own once connected. The health alert stays on until it does.
- [ ] Know what connecting does **not** fix: the purchase-order and quote PDF workers build the document in memory and stop at a render-and-store step that was never built, so "LPO PDF pending" will persist after Inngest is on. That is an engineering item (recorded in the readiness document §5 E), not a provisioning one.

## 6. PO-002 — **DECISION** (O-11)

Najolatech received 34 screws across two receipts and its stock ledger holds
zero, because the organisation has no warehouse or unit set up.
`docs/H33-PO-002-REPAIR-PREVIEW.md` shows exactly what a repair would create
(+20 and +14, cost layers, balance 34), proves it cannot double-post, and states
the sentence of approval required. Nothing has been applied.

- [ ] Decide: repair it (say the sentence in the preview), or leave it.

## 7. Still deliberately off — no action unless you choose

H28 AI · H29 country packs and Spanish · e-invoicing submission · billing
provider · Sentry (O-7 — `runbooks/sentry-provisioning.md`).

## 8. What you do not need to do

- Delete the Pilot Lab. It is marked, listed in `docs/H33-DATA-MANIFEST.md`,
  and removable in one command (`npm run lab:cleanup-preview` shows the phrase).
  Production holds none of it — proved separately in the implementation report.
- Buy anything for H33 itself. The lab fits the free tier.
