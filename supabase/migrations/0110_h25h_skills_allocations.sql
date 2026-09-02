-- 0110 — H25H: skills and task allocations (resources and capacity).
--
-- Canonical, not studio-private: a skill belongs to the organisation's people
-- data and an allocation belongs to the TASK (the jobs module owns it), so the
-- studio's capacity views read the same rows every other surface would. No
-- pay, cost-rate or contract data lives here; capacity is expressed in
-- working days over the org calendar. Additive only.

-- ── skill: a named capability people can hold ─────────────────────────────────
create table public.skill (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9_.-]{1,40}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skill_id_org_uq unique (id, org_id),
  constraint skill_key_uq unique (org_id, key)
);
alter table public.skill enable row level security;
create policy skill_select on public.skill
  for select to app_user using (org_id = (select app.current_org_id()));
create policy skill_insert on public.skill
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy skill_update on public.skill
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.skill to app_user;
grant update (name, name_ar, active, updated_at) on public.skill to app_user;

-- ── employee_skill: who holds which skill, at what level ─────────────────────
create table public.employee_skill (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  skill_id uuid not null,
  level smallint not null default 3 check (level between 1 and 5),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint employee_skill_id_org_uq unique (id, org_id),
  constraint employee_skill_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint employee_skill_skill_fk foreign key (skill_id, org_id)
    references public.skill (id, org_id) on delete restrict
);
create unique index employee_skill_live_uq
  on public.employee_skill (org_id, employee_id, skill_id) where removed_at is null;
alter table public.employee_skill enable row level security;
create policy employee_skill_select on public.employee_skill
  for select to app_user using (org_id = (select app.current_org_id()));
create policy employee_skill_insert on public.employee_skill
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy employee_skill_update on public.employee_skill
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_skill to app_user;
grant update (level, removed_at, updated_at) on public.employee_skill to app_user;

-- ── task_allocation: a share of a person's working day on a task ─────────────
-- share_pct is the fraction of each working day the person gives the task
-- while it runs (100 = full time). A task may have several people; a person
-- may be on several tasks; the capacity engine sums shares per working day.
create table public.task_allocation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  task_id uuid not null,
  employee_id uuid not null,
  share_pct smallint not null default 100 check (share_pct between 1 and 100),
  note text check (note is null or length(note) <= 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint task_allocation_id_org_uq unique (id, org_id),
  constraint task_allocation_task_fk foreign key (task_id, org_id)
    references public.task (id, org_id) on delete restrict,
  constraint task_allocation_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create unique index task_allocation_live_uq
  on public.task_allocation (org_id, task_id, employee_id) where removed_at is null;
create index task_allocation_employee_idx
  on public.task_allocation (org_id, employee_id) where removed_at is null;
alter table public.task_allocation enable row level security;
create policy task_allocation_select on public.task_allocation
  for select to app_user using (org_id = (select app.current_org_id()));
create policy task_allocation_insert on public.task_allocation
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy task_allocation_update on public.task_allocation
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.task_allocation to app_user;
grant update (share_pct, note, removed_at, updated_at) on public.task_allocation to app_user;
