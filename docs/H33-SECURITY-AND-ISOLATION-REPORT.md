# H33 — Security and isolation report

**Scope.** What keeps the Pilot Lab inside the isolated test project, what keeps
each of its five companies from seeing the others, and what proves production
was never touched.

Read alongside [H33-DATA-MANIFEST.md](H33-DATA-MANIFEST.md) (what exists) and
[H33-PILOT-LAB.md](H33-PILOT-LAB.md) (how to open it).

---

## 1. The lab cannot reach production

The seeder has exactly one door to a database, `tooling/pilot-lab/guard.ts`, and
it refuses to open unless every connection variable resolves to the test
project. There is no override flag, no `--force`, and no environment variable
that relaxes it.

| Refusal | What it catches |
| --- | --- |
| Any variable resolving to a project ref other than the test one | A stray `DIRECT_URL`, a half-edited `.env` |
| Any variable mentioning the production ref, in any position | A pooler DSN, an API URL, a direct host, a comment |
| Any variable naming a production application host | A `NEXT_PUBLIC_APP_URL` left pointing at the live site |
| `APP_ENV=prod` | The right database with the wrong intent |
| A missing service-role key | The launcher would otherwise guess, and guessing is how the wrong key gets used |

`.env.test.local` is loaded **explicitly**; `.env.local` is never read
implicitly, so the developer's everyday environment cannot leak in.

Twenty-seven unit tests in `tests/unit/pilot-lab-law.test.ts` exercise these
refusals directly, including the case that matters most: a complete and correct
test environment with a single production URL hidden in it.

## 2. Everything the lab writes is findable

Three independent markers, any one of which finds all of it:

1. **The marker row.** Every lab organisation carries
   `app_settings.key = 'h33.pilot_lab'` with the seed version. Nothing is
   written to an organisation that does not have it, and the cleanup deletes
   nothing that does not.
2. **The login domain.** Every persona signs in as
   `h33.<company>.<persona>@pilot-lab.invalid`. `.invalid` is reserved by
   RFC 2606 and cannot receive mail, so no message can ever reach a real
   person from these accounts.
3. **The identifiers.** Deterministic UUID v5 over
   (seed version, company, family, ordinal), in a namespace used nowhere else.
   The same coordinates always produce the same id, which is what makes the
   seed idempotent — and what makes every row traceable to the generator that
   wrote it.

## 3. Nothing in the lab can be mistaken for a real identity

| Field | Shape | Why it is impossible |
| --- | --- | --- |
| UAE tax number | `1999` + 11 digits | The UAE TRN space does not begin `1999` |
| Saudi VAT number | `399999` + 9 digits | Not a valid ZATCA prefix |
| IBAN | `AE00 0000 …` / `SA00 0000 …` | Check digits `00` fail the mod-97 test by construction |
| Phone | `+971 50 000 xxxx` / `+966 50 000 xxxx` | The `000 0` block is unallocated |
| Email | `…@example.invalid`, `…@pilot-lab.invalid` | Reserved, unroutable |
| Address | "Test Industrial Street, Fictional District" | Not a real address |
| Company and person names | Invented, bilingual | Checked against the real customer list in the law tests |

No national identity number, passport number or real bank account appears
anywhere in the lab, in any family.

## 4. Nothing leaves the building

The lab is a closed system. Every capability that could reach outside is either
absent or held in an off state, and the generators assert the absence rather
than assuming it.

| Channel | State | How it is held |
| --- | --- | --- |
| Email / SMS | Never sent | No consumer is provisioned; document delivery is recorded as in-app or link |
| Tax authority submission | Never attempted | The `country` family writes e-invoice documents only in local states (`prepared`, `validated`, `blocked_no_credential`, `cancelled`), and `verify()` counts `einvoice_submission` expecting zero |
| E-invoicing channel | `not_configured`, no credential, explicitly stopped | Three separate columns saying the same true thing |
| AI provider | None configured | The entitlement history ends `disabled` with the credit balance at zero; `verify()` counts `ai_run` and `ai_interaction` expecting zero |
| Payment request | Never raised | Payments are recorded against invoices in the ledger only |
| Webhook | None | No integration rows are written |
| Signature invitation | Recorded, never delivered | External signer addresses are `.invalid`; `token_hash` is a hash of the row id, not a usable token |
| Public form link | Recorded, never shared | Same construction |

## 5. Tenant isolation between the five companies

Every lab organisation is a normal tenant, subject to the same row-level
security as a paying customer. The lab adds no policy, no exemption and no
service-role path for reading; the only privileged connection is the seeder's
own, and it is used to write rows that always carry an explicit `org_id`.

The isolation sweep (`npm run test:lab`) signs in as each persona and asserts
that a request for another company's record is refused, not merely absent from a
list. The finding that matters is the difference between the two: a filtered
list can hide a leak; a refused fetch cannot.

Every generator carries the same law in its own tests: every row it builds
carries `org_id`, and the in-memory insert used by the unit tests refuses a row
without one — 1,195 unit tests across the fifteen families enforce it.

## 6. Production was not touched

The Pilot Lab is **retained** in the test project on purpose: five companies the
owner is meant to walk through by hand. That is the deliverable, not residue.

Residue would mean H33 data in **production**, and
`npm run lab:residue-check` proves its absence with one read-only SELECT,
refused unless pointed at production:

- `app_settings` rows with the marker key — expected 0
- `app_settings` rows with any `h33.` key, including the seeder's checkpoints — expected 0
- `auth.users` under `@pilot-lab.invalid` — expected 0
- organisations named after any of the five companies — expected 0

It also prints production's own business counts, so the report shows what was
left alone as well as what was absent.

## 7. What the lab deliberately does not prove

- **Penetration testing.** No attempt was made to attack the platform; this
  report covers isolation as designed and as tested, not adversarial security.
- **Load at customer scale.** The performance report measures the surfaces at
  lab volumes. One company crosses the pagination boundary on each major
  surface; none carries a year of a large customer's transaction volume.
- **Production data handling.** No production record was read, written or
  copied at any point in H33.
