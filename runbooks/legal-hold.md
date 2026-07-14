# Legal Hold Runbook (doc 10 #41)

**What this covers:** placing and lifting a **legal hold** on an org (or a file), and verifying that a
hold suspends **every** deletion pipeline — including storage-object deletion and subscription purge.
A legal hold is a compliance obligation: while it is set, no data for the held subject may be deleted,
even by an otherwise-authorised purge.

## Where the hold lives

- **File-level:** `public.file.legal_hold` (boolean), set via the DEFINER `app.set_legal_hold(p_file
  uuid, p_hold boolean)` (migration 0009). The org is NOT a parameter — it is derived from the tenant
  GUC (`app.current_org_id()`), so this **must run inside a tenant session** (org context set), not a
  context-free platform/DIRECT_URL call, or it raises "legal hold requires an org context". A held
  file's storage object cannot be voided/purged.
- **Org-level (subscription purge):** `public.org_plan_state.legal_hold` (boolean). Migration
  `0059_s9_legal_hold_purge_guard.sql` redefined `app.advance_subscription` so it **refuses** to
  advance an org to `purged` while `legal_hold` is set — the purge worker cannot purge a held org even
  by mistake.

The org-level (subscription-purge) flag is platform-controlled. The file-level `app.set_legal_hold` is
granted to `app_user` and org-scoped, so the DB *permits* a tenant session to toggle its own file's
hold — the gate is the app-layer `assertCan` on the calling path, not the DB. Placing a compliance hold
is therefore an authorized-operator action, recorded in the hold log below.

## Who authorizes

A legal hold is placed on **written instruction from the owner/legal** (litigation hold, regulator
request, dispute). Record the authorization (who, when, matter reference) in the hold log below before
setting the flag. This is not a self-service action.

## Place a hold

**Org-level (blocks subscription purge + retention of the org's data):**

```sql
-- via the platform (DIRECT_URL / owner) — org_plan_state is platform-managed
update public.org_plan_state set legal_hold = true, updated_at = now() where org_id = '<org-uuid>';
```

**File-level (blocks a specific document's deletion)** — run **inside a tenant session** (the org GUC
must be set; a plain DIRECT_URL session has no org context and will be rejected):

```sql
-- with app.org_id set for the file's org:
select app.set_legal_hold('<file-uuid>'::uuid, true);   -- true = hold, false = lift
```

The change should be accompanied by an `audit_log` entry (via the platform audit writer) and recorded
in the hold log.

## Verify the hold is effective

1. **Subscription purge is blocked:** confirm the flag is set and that the sole-writer refuses purge.
   Do NOT run a live `advance_subscription(..., 'purged')` against a real org to "test" it — `purged`
   is terminal and would delete data if the org were somehow not held. Verify by reading the flag:
   ```sql
   select legal_hold, billing_state, purge_at from public.org_plan_state where org_id = '<org-uuid>';
   ```
   The refusal path (`advance_subscription: <org> is under legal hold, purge suspended`) is exercised
   safely by the S9/S10 integration tests + only ever against a throwaway synthetic org — never a
   pilot/production org.
2. **File deletion is blocked:** a held file's void/purge path raises rather than deleting the object.
3. **Storage objects survive:** the account-closure purge (recycle-bin/closure walkthrough) enumerates
   objects and must skip held ones — verify the object still exists in the bucket after a closure run.

## Lift a hold

Only on **written instruction that the matter is closed**. Record the release in the hold log, then:

```sql
update public.org_plan_state set legal_hold = false, updated_at = now() where org_id = '<org-uuid>';
-- or, file-level (inside a tenant session with the org GUC set):
select app.set_legal_hold('<file-uuid>'::uuid, false);
```

After lifting, the normal retention / purge / cancellation pipelines resume for that subject.

## Hold log (fill in per hold)

| Date set | Subject (org/file id) | Matter ref | Authorized by | Date lifted | Lifted by |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Owner actions

- **[OWNER ACTION]** Maintain the legal-hold register with counsel; the code enforces the technical
  suspension, but the decision to place/lift is a legal one.
- **[OWNER ACTION]** Before any KSA pilot holding visa/ID documents, ensure the DPA/PDPL posture
  (`runbooks`/legal docs) covers hold obligations (doc 10 #43).
