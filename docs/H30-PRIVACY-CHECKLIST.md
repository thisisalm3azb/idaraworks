# H30 — data-processing and privacy checklist

What IdaraWorks does with personal data, where it lives, who can reach it, and
what is honestly not yet in place. Written for a controlled pilot, so it states
the position rather than asserting compliance with any regime.

**This is not a legal opinion and not a certification.** IdaraWorks holds no
privacy certification and this document does not claim one. Whether the position
below satisfies a particular law is a question for a qualified adviser in the
relevant jurisdiction, and it is an open owner action.

---

## 1. What personal data the product holds

| Category | Examples | Where |
| --- | --- | --- |
| Account identity | email, full name, chosen language | `auth.users`, `public.user_profile` |
| Workforce records | employee name, job title, pay, leave, attendance | `public.employee` and the HR tables |
| Customer contacts | name, phone, email, address | `public.customer`, `public.customer_contact` |
| Content people typed | daily reports, notes, document bodies | the record tables and document revisions |
| Files people uploaded | photos, signed copies, attachments | Supabase Storage, private buckets |
| Behavioural records | audit log, activity, impersonation sessions | `public.audit_log`, `public.activity`, `public.impersonation_session` |

**Not held:** payment card data (no billing provider is connected), government
identity numbers as a product feature, biometric data, location tracking.

---

## 2. Where it is processed and stored

| | |
| --- | --- |
| Database | Supabase (managed Postgres), single project, single region |
| File storage | Supabase Storage, two private buckets, no public bucket exists |
| Application | Vercel |
| Error reporting | Sentry — see §5, provisioning is an open owner action |
| Email | Resend, for transactional mail only |

**No personal data is moved or duplicated across regions by the product.** H29
introduced country packs but deliberately did not introduce data residency: a
country pack changes rules, not where rows live. Anything a pilot customer is
told about residency must come from Supabase's own region, not from the pack.

---

## 3. Who can reach it

| Actor | Reach | Control |
| --- | --- | --- |
| A tenant's own users | only their organisation's rows | row-level security on every tenant table, enforced in the database, not the application |
| A tenant's users, within their organisation | only what their role allows | the permission matrix, checked in the module, never only by hiding a button |
| An operator | platform metadata; a tenant's records **only** through impersonation | `impersonation_session` records who, which tenant, when, and why |
| The application itself | its own scoped database role | `app_user`, with no DELETE grant on business tables and column-scoped UPDATE |
| A developer with the service-role key | everything | the key exists only in `.env.local` and CI, never in application runtime |

The application role holds **no DELETE grant** on business tables. Deletion is
either a status change the product performs, or a platform task behind
`app.assert_platform_task()`. That is why "delete my invoice" is not a button.

---

## 4. What a person can get, and what they can remove

| Right | Status | Where |
| --- | --- | --- |
| Access / portability | **works** — a tenant can export their data | `runbooks/exports.md`, `/api/o/<org>/export` |
| Rectification | **works** — records are editable in the product | the product |
| Erasure of a tenant | **procedure exists, not rehearsed on a real tenant** | `runbooks/data-cleanup.md`, `runbooks/cancellation.md` |
| Erasure of one person within a tenant | **partial** — a user can be deactivated and their profile cleared; their authored history (audit rows, documents they wrote) is retained | see §6 |
| Retention limits | **enforced for ephemeral data** | `runbooks/retention.md` |
| Legal hold | **procedure exists** | `runbooks/legal-hold.md` |

---

## 5. Honest gaps, each an owner action

| Gap | Consequence | Owner action |
| --- | --- | --- |
| **No data-processing agreement has been signed with a pilot customer.** | The commercial basis for processing their data is undefined. | Have a DPA reviewed and signed before a pilot tenant enters real data. |
| **No sub-processor list has been published.** | Customers cannot see that Supabase, Vercel, Resend and Sentry process their data. | Publish the list; it is §2 of this document. |
| **Sentry is unprovisioned.** | No error reports are collected; also means no personal data leaks into a third party today. | Decide whether to provision it. If yes, confirm scrubbing before enabling — `runbooks/sentry-provisioning.md`. |
| **Backups are not verified.** | An erasure request cannot be honoured in backups if nobody knows what the backups contain or how long they persist. | Run the restore drill and record the backup retention window — `runbooks/restore-drill.md`. |
| **Per-person erasure is partial.** | A person who asks to be deleted from a tenant leaves authored history behind. | Decide the policy: audit integrity versus erasure. This is a legal choice, not a technical one. |
| **No breach-notification timeline is agreed.** | Under several regimes the clock starts at awareness. | Agree the timeline and name who declares a breach. |

---

## 6. The erasure tension, stated plainly

A finance system's value depends on its audit trail being immutable, and a
privacy right depends on personal data being removable. These genuinely conflict,
and IdaraWorks currently resolves it toward the audit trail: `audit_log` has no
DELETE grant, and an entry names the user who acted.

That is a defensible default and it is **not** a decision the product should make
silently. Before a pilot customer holds real employee data, the owner should
decide and write down: when a person asks to be erased, is their name removed
from historical audit entries, replaced with an opaque identifier, or retained
under a legitimate-interest or legal-obligation basis?

The technical work differs enormously by answer, which is why H30 does not guess.

---

## 7. What a pilot customer should be told before they enter real data

1. Where their data is stored, and that it does not leave that region.
2. Who at IdaraWorks can see it, and that visits are recorded.
3. That they can export everything, at any time, themselves.
4. That backups exist but the restore has not yet been rehearsed.
5. That no DPA is in place yet, and when one will be.
6. That there is no billing provider connected, so no payment data exists.

Points 4 and 5 are uncomfortable and belong in the conversation anyway. A pilot
customer who learns them later learns them at the worst moment.
