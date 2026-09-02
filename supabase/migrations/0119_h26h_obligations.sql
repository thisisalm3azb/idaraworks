-- H26H — obligations, renewals, payments and risks that a document carries
-- after it is issued. Additive. Evidence-gated completion: once done, the
-- evidence cannot be edited; reopening clears it explicitly through the app.

create table public.doc_obligation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  kind text not null check (kind in ('obligation', 'payment', 'renewal', 'notice', 'review', 'risk')),
  title text not null check (length(trim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 4000),
  -- The clause (block id) this item comes from, when known.
  clause_ref text check (clause_ref is null or length(clause_ref) <= 80),
  side text not null default 'ours' check (side in ('ours', 'theirs')),
  owner_user_id uuid references public.user_profile (id),
  due_on date not null,
  recurrence_months integer check (recurrence_months is null or recurrence_months between 1 and 120),
  amount_cents bigint check (amount_cents is null or amount_cents >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  risk_level text check (risk_level is null or risk_level in ('low', 'medium', 'high')),
  requires_evidence boolean not null default true,
  status text not null default 'open' check (status in ('open', 'done', 'waived', 'cancelled')),
  completed_at timestamptz,
  completed_by uuid references public.user_profile (id),
  evidence_note text check (evidence_note is null or length(evidence_note) <= 4000),
  evidence_file_id uuid references public.file (id),
  closed_reason text check (closed_reason is null or length(closed_reason) <= 1000),
  escalated_to uuid references public.user_profile (id),
  escalated_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'issue', 'template', 'ai')),
  linked_record_type text check (
    linked_record_type is null
    or linked_record_type in ('invoice', 'payment', 'quote', 'job', 'document')
  ),
  linked_record_id uuid,
  -- Reminder offsets (days before due) already sent, plus 'overdue' once.
  reminders_sent jsonb not null default '[]'::jsonb,
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_obligation_id_org_uq unique (id, org_id),
  constraint doc_obligation_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_obligation_done_ck check ((status = 'done') = (completed_at is not null)),
  constraint doc_obligation_closed_ck
    check (status not in ('waived', 'cancelled') or closed_reason is not null),
  constraint doc_obligation_money_ck check ((amount_cents is null) = (currency is null))
);
create index doc_obligation_due_idx on public.doc_obligation (org_id, due_on) where status = 'open';
create index doc_obligation_document_idx on public.doc_obligation (org_id, document_id, due_on);
create index doc_obligation_owner_idx on public.doc_obligation (org_id, owner_user_id) where status = 'open';

alter table public.doc_obligation enable row level security;
create policy doc_obligation_select on public.doc_obligation
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_obligation_insert on public.doc_obligation
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_obligation_update on public.doc_obligation
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_obligation to app_user;
grant update (title, description, clause_ref, side, owner_user_id, due_on, recurrence_months,
              amount_cents, currency, risk_level, requires_evidence, status, completed_at,
              completed_by, evidence_note, evidence_file_id, closed_reason, escalated_to,
              escalated_at, linked_record_type, linked_record_id, reminders_sent, row_version,
              updated_at)
  on public.doc_obligation to app_user;
create trigger doc_obligation_touch before update on public.doc_obligation
  for each row execute function app.set_updated_at();

-- Evidence is immutable while the item stays done; org and document never move.
create or replace function app.doc_obligation_guard() returns trigger
language plpgsql as $$
begin
  if new.org_id <> old.org_id or new.document_id <> old.document_id then
    raise exception 'doc_obligation: org and document are immutable' using errcode = '23514';
  end if;
  if old.status = 'done' and new.status = 'done' and (
       new.evidence_note is distinct from old.evidence_note
    or new.evidence_file_id is distinct from old.evidence_file_id
    or new.completed_at is distinct from old.completed_at
    or new.completed_by is distinct from old.completed_by
  ) then
    raise exception 'doc_obligation: evidence of a completed item is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger doc_obligation_guard before update on public.doc_obligation
  for each row execute function app.doc_obligation_guard();

-- Platform sweep discovery for the reminder worker: which organisations have
-- something due within `days` (an open obligation or an active document that
-- expires), and an owner to attribute the sweep to. Dedicated-client only.
create or replace function app.orgs_with_due_documents(p_days integer)
returns table (org_id uuid, actor_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    with due as (
      select o.org_id
      from public.doc_obligation o
      where o.status = 'open' and o.due_on <= current_date + make_interval(days => p_days)
      union
      select d.org_id
      from public.doc_document d
      where d.status = 'active' and d.expires_at is not null
        and d.expires_at <= current_date + make_interval(days => p_days)
    )
    select due.org_id,
           (
             select m.user_id
             from public.membership m
             join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
             where m.org_id = due.org_id and r.archetype = 'owner' and m.deactivated_at is null
             order by m.created_at asc
             limit 1
           ) as actor_user_id
    from due
    group by due.org_id
    having exists (
      select 1 from public.membership m2
      join public.role_definition r2 on r2.org_id = m2.org_id and r2.key = m2.role_key
      where m2.org_id = due.org_id and r2.archetype = 'owner' and m2.deactivated_at is null
    );
end;
$$;
revoke all on function app.orgs_with_due_documents(integer) from public;
grant execute on function app.orgs_with_due_documents(integer) to app_user;
