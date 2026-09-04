# H30 — the owner launch checklist

Only actions **you** must perform personally. Everything technical that could be
done without your credentials, your money or your legal judgement is done.

Ordered by what blocks a pilot. Items in §1 must be closed before a pilot
customer enters real data. Items in §2 can run alongside a pilot. Items in §3 are
decisions the product should not make for you.

---

## 1. Before a pilot customer enters real data

| # | Action | Why it is yours | Consequence if skipped |
| --- | --- | --- | --- |
| **O-1** | **Run the restore drill** and record the measured RPO and RTO. Procedure: `runbooks/restore-drill.md`. Needs the Supabase dashboard and a throwaway target. | Requires credentials not supplied to this session, and a witness. | Backups are unverified. You would discover whether they work at the worst possible moment. |
| **O-2** | **Confirm Supabase point-in-time recovery is enabled** and write down the retention window. | Supabase dashboard. | A mistake older than the window is unrecoverable, and you cannot answer an erasure request about backups. |
| **O-3** | **Have a data-processing agreement reviewed and signed** with the pilot customer. | A legal commitment. | You would be processing an identified company's employee and customer data with no agreed basis. |
| **O-4** | **Decide the per-person erasure policy** — see `docs/H30-PRIVACY-CHECKLIST.md` §6. When someone asks to be erased, is their name removed from historical audit entries, replaced with an opaque id, or retained? | A legal interpretation, and the three answers need very different engineering. | The first request arrives with no answer and the audit trail is not designed for whichever you pick. |
| **O-5** | **Tell the pilot customer the four uncomfortable things** in `docs/H30-PRIVACY-CHECKLIST.md` §7 — including that the restore is not yet rehearsed and no DPA is in place. | Yours to say. | They learn it later, at the worst moment. |

---

## 2. Alongside the pilot

| # | Action | Why it is yours | Consequence if skipped |
| --- | --- | --- | --- |
| **O-6** | **Provision Inngest** — `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`. Procedure: `runbooks/inngest-provisioning.md`. | An external account and its credentials. | Every queued job stays unprocessed. The eleven currently waiting are 3.2 days old. Purchase-order PDFs never render, and "LPO PDF pending render" stays on screen for ever. |
| **O-7** | **Decide whether to provision Sentry** — `runbooks/sentry-provisioning.md`. If yes, confirm data scrubbing before enabling. | An external account, and a privacy decision about what leaves your infrastructure. | No error reports reach you. You learn about failures from customers. |
| **O-8** | **Publish the sub-processor list** (it is §2 of the privacy checklist). | A public statement about your business. | Customers cannot see who processes their data. |
| **O-9** | **Agree a breach-notification timeline** and name who declares a breach. | An organisational decision. | Under several regimes the clock starts at awareness, and nobody knows who starts it. |
| **O-10** | **Set the pilot's expectations about billing**: no provider is connected, nothing can be charged, and the free base applies. | Commercial. | They assume they are being billed, or assume they never will be. |

---

## 3. Decisions the product deliberately did not make for you

| # | Decision | What H30 did instead |
| --- | --- | --- |
| **O-11** | **Whether to repair Najolatech's PO-002 stock.** 34 units were received across two goods receipts and the stock ledger holds zero. | Built the remedy and left the button to you. Open the purchase order, set up a warehouse if there is none, then press **Add this delivery to stock** on each receipt. It is idempotent — pressing it twice cannot double-count, and this is proved by test, not asserted. H30 did not run it, because that is a genuine change to a live customer's records. |
| **O-12** | **Whether to release the H29 country packs and Spanish.** | Both flags remain off. Releasing them needs a professional tax and labour review per country, and a native Spanish review — recordable at `/platform/countries` and `/platform/languages`. |
| **O-13** | **Whether to enable AI.** | `FEATURE_IDARA_INTELLIGENCE` remains off and no provider is configured, as instructed. |
| **O-14** | **The H24 opening-balance transition ambiguities.** | Untouched, as instructed. Still open. |
| **O-15** | **Whether historical accounting is converted.** | Not converted, as instructed. |

---

## 4. What you do not need to do

These were live risks and are now closed. Listed so you do not spend attention on
them.

- **The cleanup script no longer deletes customers.** `s7-cleanup.ts` selected
  everything not in a two-entry allow-list, and that allow-list had gone stale:
  it matched **zero** of the 40 organisations in production, so one `--apply`
  would have deleted every tenant including all four with real logins. It now
  deletes only organisations that prove they are fixtures.
- **Goods receipts no longer strand stock silently.** Warehouse setup exists,
  the failure explains itself, and the remedy replays the same receipt instead of
  advising an action that duplicates it.
- **A stalled queue no longer reports itself healthy.**
- **PDFs no longer arrive in the wrong language.**
- **A 501-line goods receipt no longer posts 500 and claims success.**
