-- 0047_s7_customer_updates (S7 — "Improve", part 3): customer progress updates + the
-- tokenized share surface (audit F-22; doc 04; doc 10 item 14).
--
-- A customer_update is composed (AI draft OR manually written — send is ALWAYS human) and,
-- when sent, FREEZES a safe-by-construction snapshot in `content`: stage completions,
-- progress %, curated watermarked photos (customer_share file class), next milestones —
-- and NOTHING else (no costs, no labour, no internal issues, no other customer's data,
-- doc 01 customer_update). Sending mints a share_token: >=128-bit random, per-update-scoped,
-- expiring, org-revocable (PB-5: a "revocable web link"; the freeze decision governs the
-- doc's "single-use" as per-update-scoped-revisitable, not one-HTTP-GET). Only the token
-- HASH is stored; the raw token is shown once at creation.
--
-- The PUBLIC share page has no authenticated user, so it cannot use the normal org-GUC RLS
-- path. app.resolve_share_token is the ONE legitimate no-auth read path: a SECURITY DEFINER
-- resolver that, given a token hash, returns ONLY the safe snapshot of an active token's
-- update (it can never reach a cost/labour/other-tenant column — it selects only the safe
-- columns). Forward-only.

create table public.customer_update (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid,
  job_name text, -- D-1.6 snapshot
  customer_id uuid,
  customer_name text, -- D-1.6 snapshot
  title text not null check (length(title) between 1 and 200),
  language text not null default 'ar' check (language in ('en', 'ar')),
  -- The client-facing prose message (AI-drafted or manually written; editable while draft).
  body text not null check (length(body) between 1 and 4000),
  -- Frozen-at-send safe-by-construction structured snapshot (stages/progress/photos/
  -- milestones). Null while draft; set on send. The public page renders ONLY from here +
  -- body + title, never from a live tenant query — so nothing composed later can leak.
  content jsonb,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  ai_drafted boolean not null default false,
  sent_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_update_id_org_uq unique (id, org_id),
  -- A sent update must carry its frozen snapshot + timestamp.
  constraint customer_update_sent_ck check (status <> 'sent' or (content is not null and sent_at is not null))
);
create index customer_update_org_job_idx on public.customer_update (org_id, job_id);
create index customer_update_org_status_idx on public.customer_update (org_id, status, created_at desc);
alter table public.customer_update
  add constraint customer_update_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.customer_update
  add constraint customer_update_customer_org_fk foreign key (customer_id, org_id)
  references public.customer (id, org_id) on delete restrict;
alter table public.customer_update enable row level security;
create policy customer_update_select on public.customer_update
  for select to app_user using (org_id = (select app.current_org_id()));
create policy customer_update_insert on public.customer_update
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
-- Draft-only edits: once sent, the update + its snapshot are immutable (a correction is a
-- new update, the money/record rule §4.7 by analogy). The USING clause reads the ROW's OWN
-- status column directly — a subquery back onto customer_update would recurse (42P17).
create policy customer_update_update on public.customer_update
  for update to app_user
  using (org_id = (select app.current_org_id()) and status = 'draft')
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.customer_update to app_user;
-- No DELETE grant (D-1.7). The send transition + the draft edits update these columns.
grant update (title, language, body, content, status, ai_drafted, sent_at, updated_at)
  on public.customer_update to app_user;

create table public.share_token (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  customer_update_id uuid not null,
  -- SHA-256 of the raw >=128-bit token; the raw value is returned once at creation and
  -- never stored (leak-resistant, doc 10 item 14).
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint share_token_hash_uq unique (token_hash)
);
create index share_token_org_update_idx on public.share_token (org_id, customer_update_id);
alter table public.share_token
  add constraint share_token_update_org_fk foreign key (customer_update_id, org_id)
  references public.customer_update (id, org_id) on delete restrict;
alter table public.share_token enable row level security;
create policy share_token_select on public.share_token
  for select to app_user using (org_id = (select app.current_org_id()));
create policy share_token_insert on public.share_token
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
-- Revocation is the only post-create mutation (org-revocable, doc 04 F-22). No DELETE grant.
create policy share_token_update on public.share_token
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.share_token to app_user;
grant update (revoked_at, revoked_by) on public.share_token to app_user;

-- The ONE legitimate no-auth read path. DEFINER so the public route (no org GUC) can call
-- it; it returns ONLY the safe snapshot of an ACTIVE token's SENT update. It cannot reach
-- any cost/labour/other-tenant column because it selects only safe columns.
create or replace function app.resolve_share_token(p_token_hash text)
returns table (
  org_id uuid,
  customer_update_id uuid,
  title text,
  language text,
  body text,
  content jsonb,
  sent_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select cu.org_id, cu.id, cu.title, cu.language, cu.body, cu.content, cu.sent_at
  from public.share_token st
  join public.customer_update cu
    on cu.id = st.customer_update_id and cu.org_id = st.org_id
  where st.token_hash = p_token_hash
    and st.revoked_at is null
    and st.expires_at > now()
    and cu.status = 'sent'
$$;
revoke all on function app.resolve_share_token(text) from public;
grant execute on function app.resolve_share_token(text) to app_user;
