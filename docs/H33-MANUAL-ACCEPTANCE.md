# H33 — Manual acceptance programme

Three programmes, each built from the same instructions. Every test names the
company to open, the persona to choose, where to click, what you should see,
what result is correct, and roughly how long it takes.

**Open anything:** `npm run lab:open -- <company> <persona>`.
**Report a problem:** note the company, persona, page URL, what you did, what you
expected, what you saw, and the time; a screenshot helps. Put it in one line in
`docs/H33-ACCEPTANCE-LOG.md` (create it) — I will turn each line into a
reproduction and a fix. Nothing you do in the lab can affect a real customer.

Legend: 🖥 desktop · 📱 phone or 375 px window · 🇬🇧 English · 🇦🇪 Arabic (switch
with the globe menu) · 📄 PDF · 📲 installed app (Chrome: install icon in the
address bar; Safari: Share → Add to Home Screen)

---

## A. The 30-minute critical check

Do these in order. If any one fails, stop and report — the rest can wait.

| # | Company · persona | Do | You should see | Correct when | Time |
| --- | --- | --- | --- | --- | --- |
| A1 | `tradeline` · owner 🖥🇬🇧 | Sign in; land on the dashboard | KPIs, attention items, activity; no error; loads in a few seconds | Dashboard is populated, not empty, and numbers are non-zero | 2 min |
| A2 | `tradeline` · owner | Customers → scroll/page to the end; search "Horizon"; filter inactive | Pages beyond 1,000; search narrows the whole list, not just the page | Last page reachable; count matches the header total | 3 min |
| A3 | `tradeline` · finance | Invoices → filter Overdue → open one → Download PDF 📄 | Overdue invoices; PDF shows company branding, lines, VAT, total; totals equal the screen | PDF total = screen total; VAT 5 % of subtotal | 4 min |
| A4 | `tradeline` · finance | Receivables (AR) → pick the customer of A3 | Outstanding equals invoice total minus payments | Balance reconciles with the invoice you opened | 2 min |
| A5 | `tradeline` · warehouse | Stock → pick the item from A3's invoice → movements | Balance equals the sum of movements; lots/serials listed | On-hand = Σ movements; no negative balances | 3 min |
| A6 | `gulfbuild` · field 📱🇦🇪 | Sign in on a phone-sized window; Arabic | RTL layout; bottom navigation; today's work; daily report form opens | Text right-to-left, numbers Latin, buttons reachable one-handed | 3 min |
| A7 | `gulfbuild` · field 📱 | New daily report → fill hours and one material → submit | Report saved as submitted; appears in the manager's review queue | No error; report visible to `manager` | 3 min |
| A8 | `consult` · manager 🖥 | Studio → open the largest plan | Dense board renders; drag a node; open a scenario | Interactive within a few seconds; no missing edges | 3 min |
| A9 | `saudimfg` · finance 🖥🇦🇪 | Finance → Reports → Trial balance | Arabic labels; debits = credits | Trial balance balances to zero | 2 min |
| A10 | any · owner | Account menu → Show me around → walk all seven steps | Each card on screen; Done records completion | All seven cards visible, Done closes it | 2 min |
| A11 | `tradeline` · owner 📲 | Install the company app; open it from the icon | Branded icon and name; opens signed in; works standalone | Icon shows company initials/colour; app opens to the workspace | 3 min |

## B. The two-hour launch acceptance

A, then:

### B1 — Sales to cash, end to end (`tradeline`, 20 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| manager | Leads → open a qualified lead → convert to opportunity → move it to "Proposal" | Stage changes; activity logged; pipeline total on Revenue → Pipeline moves by the deal value |
| manager | Quotes → New from that opportunity → 3 lines (one Arabic item) → Send | Totals: line sums, VAT, total correct; PDF 📄 renders in the customer's language |
| manager | Accept the quote → convert to job | Job created with the quote's customer; quote shows Accepted |
| finance | Invoices → New from the job → Issue → Download PDF | Invoice number sequential; PDF matches; AR increases by the total |
| finance | Payments → Record a partial payment → then the balance | Invoice shows partially paid then paid; AR back to zero for it |
| finance | Finance → Journals → find the sales and receipt entries | Both posted, balanced, in the open period; VAT entry present |
| finance | Credit note against the invoice for one line | Credit note issued; AR and VAT reduce accordingly |

### B2 — Procure to stock (`gulfbuild`, 20 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| field 📱 | Material request from a job, 2 lines, urgent | Appears in warehouse's queue |
| warehouse | Approve → convert to purchase order → Send | PO numbered; totals correct; approval recorded if rule applies |
| manager | Approvals → approve the PO | State approved; audit entry |
| warehouse | Goods receipt: receive part of it (short delivery), one damaged | Receipt recorded; stock increases by accepted qty only; damaged shown |
| warehouse | Stock → the item → cost layer visible; a second receipt for the balance | Two layers; average cost; PO shows fully received |
| warehouse | Stock count on one bin with a variance → post | Adjustment movement created; balance corrected; variance reason kept |

### B3 — People and pay (`facilico`, 20 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| hr | People → open a technician → contract, compensation history, documents | History visible; no cost figures visible to `restricted` |
| field 📱🇦🇪 | Attendance → mark today | Marked; visible to HR |
| hr | Leave → approve one pending request; reject one | Ledger balance changes for the approved only |
| hr | Claims → approve a claim with a receipt → settle via payroll | Claim settled; appears on the next pay run |
| hr | Payroll → the open pay run → calculate → review → submit → (owner) approve → finalize | Totals: net = gross − deductions; payslips generated; finalized run is immutable |
| finance | Finance → Journals → the payroll entry | Posted and balanced |
| owner | My Pay (as an employee persona) 📱 | Payslip 📄 downloads, in the persona's language |

### B4 — Documents and Studio (`consult`, 20 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| manager | Documents → Templates → open an Arabic contract template → New document from it for a customer | Arabic document; variables filled; long multipage body |
| manager | Send for review → approve → issue | Issued snapshot; PDF 📄 identical to the issued content; editing is refused |
| manager | Obligations → one overdue | Overdue shows on the manager's attention list |
| manager | Studio → a plan → add a milestone dependent on two tasks → compare with the baseline | Critical path updates; scenario comparison shows the delay |
| owner | Revenue → Forecast → change the period; compare two scenarios | Totals equal the pipeline's open value by stage |

### B5 — Isolation and roles (any two companies, 15 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| `gulfbuild` auditor | Try to open a `tradeline` URL (copy an id from the other browser) | "Not found" — never another company's record |
| `gulfbuild` restricted | Jobs, People, Finance, Settings | Only assigned work; no costs; no settings; menus absent, not just refusing |
| `tradeline` admin | Settings → Members → invite (a `.invalid` address) | Invite created; link shown in the UI (no email is sent in the lab) |
| `tradeline` admin | Settings → App → branding, icon | Manifest and icon reflect the company; install 📲 shows them |

### B6 — Search, filters and scale (`tradeline`, `facilico`, 15 min)

| Persona | Do | Correct when |
| --- | --- | --- |
| `tradeline` owner | Items: search an Arabic name; filter low stock; sort by price; page to the end | Whole-dataset results; low-stock filter shows items under minimum |
| `facilico` manager | Jobs: filter by status, by customer, this week; open page 20+ | Consistent counts; no page beyond the end; fast enough |
| `consult` manager | Opportunities: 1,200+; filter won/lost/at-risk; activities per deal | Totals per stage match the pipeline page |

## C. The multi-day programme

Day 1 — A + B, desktop, English.
Day 2 — B again, entirely in **Arabic**, on a **phone** for the field/HR/warehouse rows; installed-app mode for `tradeline` and `facilico`.
Day 3 — Finance depth (`saudimfg` finance, `tradeline` finance): period close, VAT working paper for a past quarter (preview only — nothing is ever submitted), corporate-tax working paper, bank statement import and reconciliation with the deliberately unmatched line, budget vs actual, asset depreciation run.
Day 4 — Operations depth (`gulfbuild` manager, `facilico` manager): week planning, resource conflicts in Studio, issues and blockers, approvals with a rejected one, customer updates, exports (Settings → Export).
Day 5 — Adversarial: try to break isolation (URLs, ids, PDFs, files, manifests), try every restricted persona on every page, try 200 % zoom, try Escape/back/refresh mid-flow, try the guided tour on every persona.

Log every problem in one line. Anything that blocks a workflow end-to-end is
launch-blocking; everything else is prioritised after.
