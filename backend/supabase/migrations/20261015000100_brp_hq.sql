-- BRP HQ, migration 5: the owner's portal (backend/hq/). Tasks, decisions, chat history and work requests for "the
-- Claude team", plus the agent ladder, systems and document links that the Command Center artifact used to hold.
--
-- Tables
--   hq_members      who has an HQ role beyond their BRP One role: 'owner' (Andrew) or 'partner' (Rynoc).
--   hq_tasks        work items. owner is one of Andrew, Claude, Rynoc, Attorney, CPA.
--   hq_decisions    questions with one-tap answers. kind 'agent_proposal' rows mirror public.agent_proposals
--                   (one per proposal, kept in step by triggers); answering one approves or rejects the proposal.
--   hq_messages     Ask Claude chat history (thread, role user|assistant|system, content, author, created_at).
--   hq_requests     work Andrew sends to the Claude team: text, status queued|working|done, result, links.
--   hq_agent_levels the readiness ladder (level 0 to 6) shown on the Agents page.
--   hq_systems      what is live, building or blocked.
--   hq_documents    links to documents.
--
-- Who sees what (row-level security)
--   owner     an active Admin, or anyone listed in hq_members as 'owner'. Full read and write.
--   partner   listed in hq_members as 'partner' with a party (for example 'Rynoc'). Reads tasks, decisions and documents
--             owned by that party or marked shared; updates the status, next step and note of its own tasks; adds tasks
--             for its own party; answers decisions addressed to its party. Reads the agent ladder and systems.
--   site lead an active site_lead profile. Reads tasks, decisions and documents tagged with its installation only and
--             updates the status, next step and note of those tasks. Reads the agent ladder and systems.
--   everyone else: nothing.
--   Chat and requests: each person sees their own threads and requests; the owner sees all.
--   Demo accounts (profiles.demo, password published) see and change rows marked sample only, and anything they write
--   is marked sample. Andrew's real rows (imported with sample = false) are visible to real accounts only.

-- ---------------------------------------------------------------------------
-- Members and role helpers
-- ---------------------------------------------------------------------------
create table public.hq_members (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  hq_role     text not null check (hq_role in ('owner','partner')),
  party       text not null default 'BRP' check (party ~ '^[A-Za-z][A-Za-z0-9 .&-]{0,39}$'),
  created_at  timestamptz not null default now()
);

create or replace function brp.hq_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when p.role = 'admin' or m.hq_role = 'owner' then 'owner'
              when m.hq_role = 'partner' then 'partner'
              when p.role = 'site_lead' then 'site_lead' end
  from public.profiles p left join public.hq_members m on m.profile_id = p.id
  where p.id = auth.uid() and p.active
$$;
create or replace function brp.hq_party() returns text
language sql stable security definer set search_path = '' as $$
  select case when p.role = 'admin' or m.hq_role = 'owner' then 'Andrew' else m.party end
  from public.profiles p left join public.hq_members m on m.profile_id = p.id
  where p.id = auth.uid() and p.active
$$;
create or replace function brp.hq_demo() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.demo from public.profiles p where p.id = auth.uid() and p.active), false)
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create sequence public.hq_task_seq start 1;      -- HT-0001 (imported rows keep their own ids, e.g. t01)
create sequence public.hq_decision_seq start 1;  -- HD-0001
create sequence public.hq_request_seq start 1;   -- RQ-0001
create sequence public.hq_doc_seq start 1;       -- DOC-0001

create table public.hq_tasks (
  id          text primary key default ('HT-' || lpad(nextval('public.hq_task_seq')::text, 4, '0')) check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  owner       text not null check (owner in ('Andrew','Claude','Rynoc','Attorney','CPA')),
  desk        text not null default '',
  area        text not null default '',
  item        text not null check (length(item) between 1 and 300),
  status      text not null default 'not_started' check (status in ('not_started','in_progress','waiting','at_risk','done')),
  due         text not null default '',                 -- the label people read: "Oct 17", "This week", "After decision"
  sort_date   date,                                     -- the date the board sorts by and "due soon" is computed from
  next        text not null default '',
  note        text not null default '' check (length(note) <= 4000),
  inst        text references public.installations(id) deferrable initially deferred,
  shared      boolean not null default false,           -- partner can see it even when its party does not own it
  source      text not null default 'hq' check (source in ('hq','command_center','chat','agent')),
  sample      boolean not null default false,
  created_by  uuid default auth.uid(),
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index hq_tasks_owner_status on public.hq_tasks (owner, status, sort_date);
create index hq_tasks_inst on public.hq_tasks (inst) where inst is not null;

create table public.hq_decisions (
  id                 text primary key default ('HD-' || lpad(nextval('public.hq_decision_seq')::text, 4, '0')) check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  kind               text not null default 'question' check (kind in ('question','agent_proposal')),
  proposal_id        text unique references public.agent_proposals(id) on delete cascade,
  question           text not null check (length(question) between 1 and 500),
  context            text not null default '' check (length(context) <= 4000),
  options            jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
  recommended        int check (recommended is null or recommended >= 0),
  owner              text not null default 'Andrew' check (owner in ('Andrew','Claude','Rynoc','Attorney','CPA')),
  answer             text,
  answer_index       int,
  answer_note        text check (answer_note is null or length(answer_note) <= 2000),
  answered_at        timestamptz,
  answered_by        uuid,
  answered_by_email  text,
  sort_date          date,
  inst               text references public.installations(id) deferrable initially deferred,
  shared             boolean not null default false,
  source             text not null default 'hq' check (source in ('hq','command_center','chat','agent')),
  sample             boolean not null default false,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (kind = 'question' or proposal_id is not null),
  check (recommended is null or recommended < jsonb_array_length(options))
);
create index hq_decisions_open on public.hq_decisions (sort_date) where answered_at is null;

create table public.hq_messages (
  id            bigint generated by default as identity primary key,
  thread        text not null default 'main' check (thread ~ '^[A-Za-z0-9_-]{1,60}$'),
  thread_owner  uuid not null default auth.uid(),       -- whose conversation this is
  role          text not null check (role in ('user','assistant','system')),
  content       text not null check (length(content) between 1 and 20000),
  author        text,                                   -- display name: the person, or 'Claude'
  author_id     uuid default auth.uid(),
  checked       jsonb,                                  -- reply checker result for assistant rows: { removed: [...], changed }
  drafts        jsonb not null default '[]'::jsonb,     -- task or decision drafts the reply offered (saved only on a tap)
  model         text,
  sample        boolean not null default false,
  created_at    timestamptz not null default now()
);
create index hq_messages_thread on public.hq_messages (thread_owner, thread, created_at);

create table public.hq_requests (
  id                 text primary key default ('RQ-' || lpad(nextval('public.hq_request_seq')::text, 4, '0')),
  text               text not null check (length(text) between 3 and 8000),
  status             text not null default 'queued' check (status in ('queued','working','done')),
  result             text check (result is null or length(result) <= 20000),
  links              jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  thread             text,
  message_id         bigint references public.hq_messages(id) on delete set null,
  requested_by       uuid default auth.uid(),
  requested_by_name  text,
  routine_session_url text check (routine_session_url is null or routine_session_url ~ '^https://'),
  fire_note          text,                              -- what happened when HQ tried to start the routine
  sample             boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  done_at            timestamptz
);
create index hq_requests_by on public.hq_requests (requested_by, created_at desc);

create table public.hq_agent_levels (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  name        text not null,
  agent       public.brp_agent_name,                    -- the operations agent this row tracks, when there is one
  level       int not null check (level between 0 and 6),
  mode        text not null default 'Off',
  evidence    text not null default '',
  next        text not null default '',
  sort        int not null default 0,
  sample      boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table public.hq_systems (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  name        text not null,
  status      text not null default '',
  state       text not null default 'building' check (state in ('live','building','blocked')),
  url         text not null default '' check (url = '' or url ~ '^https://'),
  note        text not null default '',
  sort        int not null default 0,
  sample      boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table public.hq_documents (
  id          text primary key default ('DOC-' || lpad(nextval('public.hq_doc_seq')::text, 4, '0')) check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  title       text not null check (length(title) between 1 and 200),
  url         text not null check (url ~ '^https://'),
  area        text not null default '',
  note        text not null default '',
  owner       text not null default 'Andrew' check (owner in ('Andrew','Claude','Rynoc','Attorney','CPA')),
  inst        text references public.installations(id) deferrable initially deferred,
  shared      boolean not null default false,
  sort        int not null default 0,
  sample      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers: demo rows, who changed what, done dates, and the limits on non-owner edits
-- ---------------------------------------------------------------------------
create or replace function brp.hq_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text := brp.hq_role(); person boolean := auth.uid() is not null and coalesce(current_setting('brp.hq_fn', true), '') <> 'on';
begin
  if person and brp.hq_demo() then new.sample := true; end if;   -- a demo account never writes a real row
  if tg_op = 'UPDATE' and person and old.sample is distinct from new.sample and not (r = 'owner' and not brp.hq_demo()) then
    raise exception 'Only the owner can change whether a row is sample data' using errcode = '42501';
  end if;
  if tg_table_name = 'hq_tasks' then
    if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
    new.updated_by := auth.uid();
    if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then new.done_at := now();
    elsif new.status <> 'done' then new.done_at := null; end if;
    if tg_op = 'UPDATE' and person and r is distinct from 'owner'
       and (to_jsonb(new) - array['status','next','note','updated_at','updated_by','done_at'])
           is distinct from (to_jsonb(old) - array['status','next','note','updated_at','updated_by','done_at']) then
      raise exception 'Only the owner can change a task''s owner, wording, due date or sharing. You can change status, next step and note.' using errcode = '42501';
    end if;
  elsif tg_table_name = 'hq_decisions' then
    if tg_op = 'UPDATE' and old.kind = 'agent_proposal' and coalesce(current_setting('brp.hq_sync', true), '') <> 'on' then
      raise exception 'Agent proposal decisions change only through hq_decide or the admin console' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and new.kind = 'agent_proposal' and coalesce(current_setting('brp.hq_sync', true), '') <> 'on' then
      raise exception 'Agent proposal decisions are created from agent_proposals only' using errcode = '42501';
    end if;
  elsif tg_table_name = 'hq_requests' then
    if tg_op = 'INSERT' and person then
      new.requested_by := auth.uid(); new.status := 'queued'; new.result := null; new.done_at := null; new.routine_session_url := null;
      new.requested_by_name := (select p.full_name from public.profiles p where p.id = auth.uid());
    end if;
    if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then new.done_at := now();
    elsif new.status <> 'done' then new.done_at := null; end if;
  elsif tg_table_name = 'hq_messages' then
    if person then
      if new.role <> 'user' then raise exception 'People write user messages only. Claude''s replies are written by the server.' using errcode = '42501'; end if;
      new.author_id := auth.uid(); new.thread_owner := auth.uid();
      new.author := (select p.full_name from public.profiles p where p.id = auth.uid());
      new.checked := null; new.drafts := '[]'::jsonb; new.model := null;
    end if;
  end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'hq_messages' then new.updated_at := now(); end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['hq_tasks','hq_decisions','hq_messages','hq_requests','hq_agent_levels','hq_systems','hq_documents'] loop
    execute format('create trigger brp_hq_before_write before insert or update on public.%I for each row execute function brp.hq_before_write()', t);
  end loop;
  foreach t in array array['hq_tasks','hq_decisions','hq_requests','hq_agent_levels','hq_systems','hq_documents','hq_members'] loop
    execute format('create trigger brp_audit after insert or update or delete on public.%I for each row execute function brp.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Agent proposals appear as HQ decisions, and their answers stay in step both ways
-- ---------------------------------------------------------------------------
create or replace function brp.hq_proposal_question(p public.agent_proposals) returns text
language sql immutable as $$
  select (case p.agent when 'buyer_dispatch' then 'Buyer and Dispatch' when 'sensor_watch' then 'Sensor Watch'
            when 'inspection_scheduler' then 'Inspection Scheduler' when 'room_readiness' then 'Room Readiness Planner'
            when 'soldier_liaison' then 'Soldier Liaison' else p.agent end)
         || ' proposes ' || replace(p.kind, '_', ' ') || ' at ' || p.inst || ' (' || p.id || '). Do you agree?'
$$;

create or replace function brp.hq_proposal_mirror() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('brp.hq_sync', 'on', true);
  if tg_op = 'INSERT' then
    insert into public.hq_decisions (id, kind, proposal_id, question, context, options, recommended, owner, inst, sort_date, source, sample, created_by,
                                     answer, answer_index, answer_note, answered_at, answered_by, answered_by_email)
    values ('HD-' || new.id, 'agent_proposal', new.id, brp.hq_proposal_question(new), new.rationale, '["Approve","Reject"]'::jsonb, null,
            'Andrew', new.inst, (new.created_at at time zone 'America/Chicago')::date, 'agent', new.sample, null,
            case new.status when 'approved' then 'Approve' when 'rejected' then 'Reject' end,
            case new.status when 'approved' then 0 when 'rejected' then 1 end,
            new.decision_note, new.decided_at, new.decided_by, new.decided_by_email)
    on conflict (proposal_id) do nothing;
  elsif new.status is distinct from old.status then
    update public.hq_decisions set
      answer = case new.status when 'approved' then 'Approve' when 'rejected' then 'Reject' end,
      answer_index = case new.status when 'approved' then 0 when 'rejected' then 1 end,
      answer_note = new.decision_note, answered_at = new.decided_at, answered_by = new.decided_by, answered_by_email = new.decided_by_email
    where proposal_id = new.id;
  end if;
  perform set_config('brp.hq_sync', 'off', true);
  return null;
end $$;
create trigger brp_hq_mirror after insert or update on public.agent_proposals for each row execute function brp.hq_proposal_mirror();

-- Proposals that already exist.
do $$ begin
perform set_config('brp.hq_sync', 'on', true);
insert into public.hq_decisions (id, kind, proposal_id, question, context, options, owner, inst, sort_date, source, sample,
                                 answer, answer_index, answer_note, answered_at, answered_by, answered_by_email)
select 'HD-' || p.id, 'agent_proposal', p.id, brp.hq_proposal_question(p), p.rationale, '["Approve","Reject"]'::jsonb, 'Andrew', p.inst,
       (p.created_at at time zone 'America/Chicago')::date, 'agent', p.sample,
       case p.status when 'approved' then 'Approve' when 'rejected' then 'Reject' end,
       case p.status when 'approved' then 0 when 'rejected' then 1 end, p.decision_note, p.decided_at, p.decided_by, p.decided_by_email
from public.agent_proposals p
on conflict (proposal_id) do nothing;
perform set_config('brp.hq_sync', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- Functions people call
-- ---------------------------------------------------------------------------
create or replace function public.hq_whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'email', p.email, 'name', p.full_name, 'role', p.role::text, 'inst', p.inst, 'active', p.active,
    'demo', p.demo, 'hq_role', brp.hq_role(), 'party', brp.hq_party())
  from public.profiles p where p.id = auth.uid()
$$;

-- One tap on a decision. p_choice is the option index. An agent proposal is approved (0) or rejected (1) through
-- public.agent_proposal_decide, which keeps its own rules (Admin only, a reason to reject, demo admins decide sample
-- proposals only); the mirror trigger then records the answer here.
create or replace function public.hq_decide(p_id text, p_choice int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.hq_decisions; r text := brp.hq_role();
begin
  if r is null then raise exception 'HQ is for the owner, the partner and site leads' using errcode = '42501'; end if;
  select * into d from public.hq_decisions where id = p_id for update;
  if not found then raise exception 'No decision %', p_id using errcode = '22023'; end if;
  if brp.hq_demo() and not d.sample then raise exception 'Demo accounts answer sample decisions only' using errcode = '42501'; end if;
  if not (r = 'owner' or (r = 'partner' and d.owner = brp.hq_party())) then
    raise exception 'Only the owner answers this decision' using errcode = '42501';
  end if;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(d.options) then
    raise exception 'Choose one of the % options', jsonb_array_length(d.options) using errcode = '22023';
  end if;
  if d.kind = 'agent_proposal' then
    perform public.agent_proposal_decide(d.proposal_id, case p_choice when 0 then 'approve' else 'reject' end, p_note);
  else
    perform set_config('brp.hq_fn', 'on', true);
    update public.hq_decisions set answer = d.options->>p_choice, answer_index = p_choice, answer_note = nullif(trim(coalesce(p_note, '')), ''),
           answered_at = now(), answered_by = auth.uid(), answered_by_email = (select email from public.profiles where id = auth.uid())
    where id = p_id;
    perform set_config('brp.hq_fn', 'off', true);
  end if;
  select * into d from public.hq_decisions where id = p_id;
  return to_jsonb(d);
end $$;

-- Owner only (not a demo account): give someone an HQ role. p_role null removes it.
create or replace function public.hq_set_member(p_email text, p_role text, p_party text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if brp.hq_role() is distinct from 'owner' or brp.hq_demo() then raise exception 'Only a real owner account changes HQ roles' using errcode = '42501'; end if;
  select id into v from public.profiles where lower(email) = lower(trim(p_email));
  if v is null then raise exception 'No account %', p_email using errcode = '22023'; end if;
  if p_role is null then delete from public.hq_members where profile_id = v; return jsonb_build_object('email', p_email, 'hq_role', null); end if;
  insert into public.hq_members (profile_id, hq_role, party) values (v, p_role, coalesce(nullif(trim(p_party), ''), case when p_role = 'owner' then 'Andrew' else 'Rynoc' end))
  on conflict (profile_id) do update set hq_role = excluded.hq_role, party = excluded.party;
  return jsonb_build_object('email', p_email, 'hq_role', p_role, 'party', coalesce(nullif(trim(p_party), ''), case when p_role = 'owner' then 'Andrew' else 'Rynoc' end));
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.hq_members      enable row level security;
alter table public.hq_tasks        enable row level security;
alter table public.hq_decisions    enable row level security;
alter table public.hq_messages     enable row level security;
alter table public.hq_requests     enable row level security;
alter table public.hq_agent_levels enable row level security;
alter table public.hq_systems      enable row level security;
alter table public.hq_documents    enable row level security;

-- "sample or not demo": demo accounts reach sample rows only.
create policy hq_members_select on public.hq_members for select to authenticated using (
  profile_id = (select brp.uid()) or (select brp.hq_role()) = 'owner');

-- tasks
create policy hq_tasks_select on public.hq_tasks for select to authenticated using (
  (sample or not (select brp.hq_demo())) and (
    (select brp.hq_role()) = 'owner'
    or ((select brp.hq_role()) = 'partner' and (owner = (select brp.hq_party()) or shared))
    or ((select brp.hq_role()) = 'site_lead' and inst = (select brp.my_inst()))));
create policy hq_tasks_insert on public.hq_tasks for insert to authenticated with check (
  (select brp.hq_role()) = 'owner' or ((select brp.hq_role()) = 'partner' and owner = (select brp.hq_party())));
create policy hq_tasks_update on public.hq_tasks for update to authenticated
  using ((sample or not (select brp.hq_demo())) and (
    (select brp.hq_role()) = 'owner'
    or ((select brp.hq_role()) = 'partner' and owner = (select brp.hq_party()))
    or ((select brp.hq_role()) = 'site_lead' and inst = (select brp.my_inst()))))
  with check (
    (select brp.hq_role()) = 'owner'
    or ((select brp.hq_role()) = 'partner' and owner = (select brp.hq_party()))
    or ((select brp.hq_role()) = 'site_lead' and inst = (select brp.my_inst())));
create policy hq_tasks_delete on public.hq_tasks for delete to authenticated using (
  (select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo())));

-- decisions (answers go through hq_decide)
create policy hq_decisions_select on public.hq_decisions for select to authenticated using (
  (sample or not (select brp.hq_demo())) and (
    (select brp.hq_role()) = 'owner'
    or ((select brp.hq_role()) = 'partner' and (owner = (select brp.hq_party()) or shared))
    or ((select brp.hq_role()) = 'site_lead' and inst = (select brp.my_inst()))));
create policy hq_decisions_insert on public.hq_decisions for insert to authenticated with check ((select brp.hq_role()) = 'owner');
create policy hq_decisions_update on public.hq_decisions for update to authenticated
  using ((select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo()))) with check ((select brp.hq_role()) = 'owner');
create policy hq_decisions_delete on public.hq_decisions for delete to authenticated
  using ((select brp.hq_role()) = 'owner' and kind = 'question' and (sample or not (select brp.hq_demo())));

-- chat history
create policy hq_messages_select on public.hq_messages for select to authenticated using (
  (sample or not (select brp.hq_demo())) and (thread_owner = (select brp.uid()) or (select brp.hq_role()) = 'owner'));
create policy hq_messages_insert on public.hq_messages for insert to authenticated with check (
  (select brp.hq_role()) is not null and thread_owner = (select brp.uid()) and role = 'user');
create policy hq_messages_delete on public.hq_messages for delete to authenticated using (
  (thread_owner = (select brp.uid()) or (select brp.hq_role()) = 'owner') and (sample or not (select brp.hq_demo())));

-- requests to the Claude team
create policy hq_requests_select on public.hq_requests for select to authenticated using (
  (sample or not (select brp.hq_demo())) and (requested_by = (select brp.uid()) or (select brp.hq_role()) = 'owner'));
create policy hq_requests_insert on public.hq_requests for insert to authenticated with check (
  (select brp.hq_role()) is not null and requested_by = (select brp.uid()));
create policy hq_requests_update on public.hq_requests for update to authenticated
  using ((select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo()))) with check ((select brp.hq_role()) = 'owner');

-- agent ladder and systems: every HQ role reads; the owner writes
create policy hq_levels_select on public.hq_agent_levels for select to authenticated using (
  (select brp.hq_role()) is not null and (sample or not (select brp.hq_demo())));
create policy hq_levels_write on public.hq_agent_levels for all to authenticated
  using ((select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo()))) with check ((select brp.hq_role()) = 'owner');
create policy hq_systems_select on public.hq_systems for select to authenticated using (
  (select brp.hq_role()) is not null and (sample or not (select brp.hq_demo())));
create policy hq_systems_write on public.hq_systems for all to authenticated
  using ((select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo()))) with check ((select brp.hq_role()) = 'owner');

-- documents: like tasks
create policy hq_docs_select on public.hq_documents for select to authenticated using (
  (sample or not (select brp.hq_demo())) and (
    (select brp.hq_role()) = 'owner'
    or ((select brp.hq_role()) = 'partner' and (owner = (select brp.hq_party()) or shared))
    or ((select brp.hq_role()) = 'site_lead' and inst = (select brp.my_inst()))));
create policy hq_docs_write on public.hq_documents for all to authenticated
  using ((select brp.hq_role()) = 'owner' and (sample or not (select brp.hq_demo()))) with check ((select brp.hq_role()) = 'owner');

-- ---------------------------------------------------------------------------
-- Grants. Supabase's default privileges grant new public tables to anon and authenticated, so take that back first.
-- ---------------------------------------------------------------------------
revoke all on public.hq_members, public.hq_tasks, public.hq_decisions, public.hq_messages, public.hq_requests,
  public.hq_agent_levels, public.hq_systems, public.hq_documents from anon, authenticated;
revoke all on sequence public.hq_task_seq, public.hq_decision_seq, public.hq_request_seq, public.hq_doc_seq from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'brp_agent') then
    execute 'revoke all on public.hq_members, public.hq_tasks, public.hq_decisions, public.hq_messages, public.hq_requests, public.hq_agent_levels, public.hq_systems, public.hq_documents from brp_agent';
  end if;
end $$;

grant select on public.hq_members to authenticated;
grant select, insert, update, delete on public.hq_tasks, public.hq_decisions, public.hq_agent_levels, public.hq_systems, public.hq_documents to authenticated;
grant select, insert, delete on public.hq_messages to authenticated;
grant select, insert, update on public.hq_requests to authenticated;
grant usage on sequence public.hq_task_seq, public.hq_decision_seq, public.hq_request_seq, public.hq_doc_seq to authenticated;
grant usage on sequence public.hq_messages_id_seq to authenticated;
grant all on public.hq_members, public.hq_tasks, public.hq_decisions, public.hq_messages, public.hq_requests,
  public.hq_agent_levels, public.hq_systems, public.hq_documents to service_role;
grant usage on sequence public.hq_task_seq, public.hq_decision_seq, public.hq_request_seq, public.hq_doc_seq, public.hq_messages_id_seq to service_role;

revoke execute on function brp.hq_role(), brp.hq_party(), brp.hq_demo(), public.hq_whoami(), public.hq_decide(text, int, text),
  public.hq_set_member(text, text, text) from public, anon;
grant execute on function brp.hq_role(), brp.hq_party(), brp.hq_demo(), public.hq_whoami(), public.hq_decide(text, int, text),
  public.hq_set_member(text, text, text) to authenticated, service_role;
revoke execute on function brp.hq_proposal_mirror(), brp.hq_before_write() from public, anon, authenticated;
