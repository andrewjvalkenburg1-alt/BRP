-- BRP One backend, migration 3 of 3: triggers, audit, and the API functions (RPC).
--   public.whoami()                       who am I, with role and installation
--   public.raise_alert(alert jsonb)       fan-out to tagged people + one outbox row each (never sends mail itself)
--   public.mark_alert_read(id)            mark my copy of an alert read
--   public.register_push_token(...)       store this device's APNs or FCM token for me
--   public.unregister_push_token(token)   remove it (sign-out)
--   public.admin_set_role(...)            Admin only: role, installation, active
--   public.admin_reset_demo()             Admin only: reload the sample data from brp_seed
-- Bulk work (seed and reset) sets the transaction setting brp.bulk = 'on', which turns off the audit and default triggers.

-- ---------------------------------------------------------------------------
-- Role keys and labels
-- ---------------------------------------------------------------------------
create or replace function brp.role_key(p text) returns text
language sql immutable as $$
  select case lower(regexp_replace(trim(coalesce(p, '')), '[\s-]+', '_', 'g'))
    when 'soldier' then 'soldier'
    when 'technician' then 'technician' when 'tech' then 'technician'
    when 'barracks_manager' then 'barracks_manager' when 'manager' then 'barracks_manager'
    when 'site_lead' then 'site_lead'
    when 'program_manager' then 'program_manager' when 'pm' then 'program_manager'
    when 'buyer' then 'buyer'
    when 'cor' then 'cor' when 'government_cor' then 'cor'
    when 'commander' then 'commander' when 'garrison_commander' then 'commander'
    when 'admin' then 'admin'
    else null end
$$;

create or replace function brp.role_label(p text) returns text
language sql immutable as $$
  select case p
    when 'soldier' then 'Soldier' when 'technician' then 'Technician' when 'barracks_manager' then 'Barracks manager'
    when 'site_lead' then 'Site lead' when 'program_manager' then 'Program manager' when 'buyer' then 'Buyer'
    when 'cor' then 'Government COR' when 'commander' then 'Garrison commander' when 'admin' then 'Admin' else p end
$$;

create or replace function brp.bulk() returns boolean
language sql stable as $$ select coalesce(current_setting('brp.bulk', true), '') = 'on' $$;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function brp.touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['installations','buildings','rooms','vendors','catalog_items','parts','stock','purchase_orders','settings'] loop
    execute format('create trigger brp_touch before update on public.%I for each row execute function brp.touch()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- New sign-ups get an inactive Soldier profile until an Admin sets the role.
-- The seed and the Admin API may preset brp_role / brp_inst / brp_active / brp_demo in app_metadata
-- (only the service role can write app_metadata, so a person cannot pick their own role).
-- ---------------------------------------------------------------------------
create or replace function brp.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, role, inst, home_bldg, home_room, active, demo)
  values (new.id, lower(new.email),
          coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(coalesce(new.email, ''), '@', 1)),
          coalesce(brp.role_key(new.raw_app_meta_data->>'brp_role'), 'soldier'),
          nullif(new.raw_app_meta_data->>'brp_inst', ''),
          nullif(new.raw_app_meta_data->>'brp_home_bldg', ''),
          nullif(new.raw_app_meta_data->>'brp_home_room', ''),
          coalesce((new.raw_app_meta_data->>'brp_active')::boolean, false),
          coalesce((new.raw_app_meta_data->>'brp_demo')::boolean, false))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger brp_on_auth_user_created after insert on auth.users
  for each row execute function brp.handle_new_user();

-- Role, installation, active, email and demo flag change only through admin_set_role (or the service role / seed).
create or replace function brp.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.role is distinct from old.role or new.inst is distinct from old.inst or new.active is distinct from old.active
      or new.email is distinct from old.email or new.demo is distinct from old.demo or new.id is distinct from old.id)
     and auth.uid() is not null
     and coalesce(current_setting('brp.admin_fn', true), '') <> 'on'
     and not brp.bulk() then
    raise exception 'Role, installation and account status change only through admin_set_role' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger brp_profiles_guard before update on public.profiles for each row execute function brp.profiles_guard();

-- ---------------------------------------------------------------------------
-- Work order defaults and guards
-- ---------------------------------------------------------------------------
create or replace function brp.resolve_window(p_prio text) returns interval
language sql immutable as $$
  select case p_prio when 'Emergency' then interval '24 hours' when 'Urgent' then interval '7 days' else interval '30 days' end
$$;

create or replace function brp.wo_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if brp.bulk() then return new; end if;
  if new.id is null or new.id = '' then new.id := 'WO-' || nextval('public.wo_seq'); end if;
  new.created_at := coalesce(new.created_at, now());
  new.due_at := coalesce(new.due_at, new.created_at + brp.resolve_window(new.prio));
  new.updated_at := now();
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.sample := false;
    if brp.my_role() = 'soldier' then
      new.source := 'Soldier'; new.origin := 'app'; new.status := 'open'; new.step := 'request';
      new.soldier_id := auth.uid(); new.soldier_name := brp.my_name();
      new.tech_id := null; new.tech_name := null; new.po_ids := '{}';
    end if;
  end if;
  if new.room_id is null then
    select r.id into new.room_id from public.rooms r where r.inst = new.inst and r.bldg = new.bldg and r.room = new.room;
  end if;
  return new;
end $$;
create trigger brp_wo_before_insert before insert on public.work_orders for each row execute function brp.wo_before_insert();

create or replace function brp.wo_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if brp.bulk() then return new; end if;
  if brp.my_role() = 'technician' and (new.inst is distinct from old.inst or new.id is distinct from old.id
      or new.soldier_id is distinct from old.soldier_id or new.prio is distinct from old.prio) then
    raise exception 'A technician can update status, step, parts and notes on their own work orders only' using errcode = '42501';
  end if;
  if new.prio is distinct from old.prio then new.due_at := new.created_at + brp.resolve_window(new.prio); end if;
  if new.status = 'closed' and old.status <> 'closed' then new.closed_at := coalesce(new.closed_at, now()); end if;
  if new.status <> 'closed' then new.closed_at := null; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger brp_wo_before_update before update on public.work_orders for each row execute function brp.wo_before_update();

create or replace function brp.woev_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if brp.bulk() then return new; end if;
  new.at := now();
  new.actor_id := auth.uid();
  new.actor_name := coalesce(brp.my_name(), new.actor_name);
  return new;
end $$;
create trigger brp_woev_before_insert before insert on public.wo_events for each row execute function brp.woev_before_insert();

-- Satisfaction: an anonymous answer never carries who sent it.
create or replace function brp.csat_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if brp.bulk() then return new; end if;
  new.sample := false;
  if brp.my_role() = 'soldier' then new.channel := 'app'; new.at := now(); end if;
  if new.anon then new.by_id := null; new.by_name := null;
  elsif brp.my_role() = 'soldier' then new.by_id := auth.uid(); new.by_name := brp.my_name();
  end if;
  return new;
end $$;
create trigger brp_csat_before_insert before insert on public.satisfaction for each row execute function brp.csat_before_insert();

create or replace function brp.plist_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if brp.bulk() then return new; end if;
  if tg_op = 'INSERT' then
    new.requested_by := coalesce(auth.uid(), new.requested_by);
    new.requested_by_name := coalesce(brp.my_name(), new.requested_by_name);
    new.sample := false;
    if new.description = '' then new.description := coalesce(new.note, new.id, ''); end if;
  end if;
  new.updated_by := coalesce((select p.email from public.profiles p where p.id = auth.uid()), new.updated_by);
  new.updated_at := now();
  return new;
end $$;
create trigger brp_plist_before_write before insert or update on public.purchase_list for each row execute function brp.plist_before_write();

-- ---------------------------------------------------------------------------
-- Audit log (after insert, update, delete). Updates keep only the changed fields.
-- ---------------------------------------------------------------------------
create or replace function brp.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o jsonb; n jsonb; r jsonb; rid text; act text := lower(tg_op);
begin
  if brp.bulk() then return null; end if;
  if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, o->k), jsonb_object_agg(k, n->k) into o, n
    from jsonb_object_keys(to_jsonb(new)) k
    where k <> 'updated_at' and (to_jsonb(old)->k) is distinct from (to_jsonb(new)->k);
    if o is null then return null; end if;
  end if;
  r := coalesce(to_jsonb(new), to_jsonb(old));
  rid := coalesce(r->>'id', r->>'sku', r->>'key');
  if tg_table_name = 'stock' then rid := (r->>'cabinet_id') || ':' || (r->>'sku'); end if;
  if tg_table_name = 'profiles' and coalesce(current_setting('brp.admin_fn', true), '') = 'on' then act := 'role.change'; end if;
  if tg_table_name = 'push_tokens' then o := o - 'token'; n := n - 'token'; end if;
  insert into public.audit_log (actor_id, actor_email, actor_role, action, table_name, row_id, old_row, new_row)
  values (auth.uid(), (select p.email from public.profiles p where p.id = auth.uid()), brp.my_role(), act, tg_table_name, rid, o, n);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','installations','buildings','rooms','work_orders','purchase_orders','po_lines','stock',
                           'purchase_list','parts','vendors','cabinets','catalog_items','settings','push_tokens'] loop
    execute format('create trigger brp_audit after insert or update or delete on public.%I for each row execute function brp.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- whoami
-- ---------------------------------------------------------------------------
create or replace function public.whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'email', p.email, 'name', p.full_name, 'role', p.role::text,
    'role_label', brp.role_label(p.role), 'inst', p.inst, 'active', p.active, 'demo', p.demo,
    'home_bldg', p.home_bldg, 'home_room', p.home_room)
  from public.profiles p where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- raise_alert: store the alert, fan out to the tagged people plus the defaults, write one outbox row each.
-- Only people with a BRP profile can be tagged; unknown email addresses are ignored, so this can never mail a stranger.
-- Email and push delivery happen in the notify Edge Function, which reads the rows written here.
-- ---------------------------------------------------------------------------
create or replace function public.raise_alert(p_alert jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role  text := brp.my_role();
  v_me    public.profiles;
  v_inst  text := nullif(trim(coalesce(p_alert->>'inst', '')), '');
  v_ref   text := nullif(trim(coalesce(p_alert->>'ref', '')), '');
  v_sev   text := coalesce(nullif(p_alert->>'severity', ''), 'info');
  v_type  text := coalesce(nullif(p_alert->>'type', ''), 'custom');
  v_title text := left(coalesce(nullif(trim(p_alert->>'title'), ''), 'BRP alert'), 200);
  v_body  text := left(coalesce(p_alert->>'body', ''), 4000);
  v_wo    public.work_orders;
  v_id    text;
  v_kind  text;
  v_key   text;
  t       jsonb;
  v_out   jsonb;
begin
  if v_role is null then
    raise exception 'Sign in with an active account to raise an alert' using errcode = '42501';
  end if;
  select * into v_me from public.profiles where id = auth.uid();
  if v_sev not in ('critical','high','info') then v_sev := 'info'; end if;
  if v_type not in ('wo.emergency','clock.risk','clock.missed','part.delivered','part.backorder','verify.failed',
                    'sensor.threshold','target.missed','setup.failures','custom') then v_type := 'custom'; end if;

  -- Work out the installation from the ref when it was not given.
  if v_ref is not null then
    v_kind := split_part(v_ref, ':', 1);
    v_key := substr(v_ref, length(v_kind) + 2);
    if v_kind = 'wo' then
      select * into v_wo from public.work_orders where id = v_key;
      if found then v_inst := coalesce(v_inst, v_wo.inst); end if;
    elsif v_kind = 'po' then
      v_inst := coalesce(v_inst, (select inst from public.purchase_orders where id = v_key));
    elsif v_kind in ('room','bldg','inst') then
      v_inst := coalesce(v_inst, split_part(v_key, '-', 1));
    end if;
  end if;
  if v_inst is not null and not exists (select 1 from public.installations where id = v_inst) then v_inst := null; end if;
  if v_role = 'soldier' then v_inst := v_me.inst; end if;
  if v_inst is null and not brp.sees_all() then v_inst := v_me.inst; end if;
  if v_inst is not null and not (brp.sees_all() or v_inst = v_me.inst) then
    raise exception 'Your account cannot raise alerts for %', v_inst using errcode = '42501';
  end if;

  insert into public.alerts (type, severity, title, body, inst, ref, tags, created_by, created_by_name)
  values (v_type, v_sev, v_title, v_body, v_inst, v_ref,
          array_remove(array[v_ref, case when v_inst is not null then 'inst:' || v_inst end], null),
          auth.uid(), v_me.full_name)
  returning id into v_id;

  -- 1. Tagged people. A tag with an email must match a profile; a tag with only a role means everyone with that role in scope.
  for t in select * from jsonb_array_elements(case when jsonb_typeof(p_alert->'tags') = 'array' then p_alert->'tags' else '[]'::jsonb end) loop
    if nullif(t->>'email', '') is not null then
      insert into public.alert_recipients (alert_id, profile_id, email, name, role)
      select v_id, p.id, p.email, p.full_name, brp.role_label(p.role)
      from public.profiles p where lower(p.email) = lower(t->>'email') and p.active
      on conflict (alert_id, email) do nothing;
    elsif brp.role_key(t->>'role') is not null then
      insert into public.alert_recipients (alert_id, profile_id, email, name, role)
      select v_id, p.id, p.email, p.full_name, brp.role_label(p.role)
      from public.profiles p
      where p.active and p.role = brp.role_key(t->>'role') and (v_inst is null or p.inst is null or p.inst = v_inst)
      on conflict (alert_id, email) do nothing;
    end if;
  end loop;

  -- 2. Defaults: the site lead and barracks manager for the installation, the assigned technician, and on critical alerts the program manager.
  insert into public.alert_recipients (alert_id, profile_id, email, name, role)
  select v_id, p.id, p.email, p.full_name, brp.role_label(p.role)
  from public.profiles p
  where p.active and (
       (v_inst is not null and p.inst = v_inst and p.role in ('site_lead','barracks_manager'))
    or (v_wo.tech_id is not null and p.id = v_wo.tech_id)
    or (v_sev = 'critical' and p.role = 'program_manager' and (p.inst is null or p.inst = v_inst)))
  on conflict (alert_id, email) do nothing;

  -- 3. One outbox row per tagged person. 'logged' = written here, not sent. Demo addresses are suppressed for good.
  insert into public.email_outbox (alert_id, inst, to_email, to_name, to_role, subject, body, status, provider, error)
  select v_id, v_inst, r.email, r.name, r.role,
         '[BRP ' || upper(v_sev) || '] ' || v_title,
         v_title || E'\n\n' || coalesce(nullif(v_body, ''), '(no detail)') ||
           case when v_ref is not null then E'\n\nRecord: ' || v_ref else '' end ||
           case when v_inst is not null then E'\nInstallation: ' || v_inst else '' end ||
           E'\nRaised by: ' || coalesce(v_me.full_name, 'BRP') || ' (' || brp.role_label(v_role) || ')' ||
           E'\n\nSent by BRP One. Sample data.',
         case when p.email_alerts is false then 'suppressed' else 'logged' end,
         'none',
         case when p.email_alerts is false then 'Recipient turned off email alerts' end
  from public.alert_recipients r left join public.profiles p on p.id = r.profile_id
  where r.alert_id = v_id;

  select jsonb_build_object(
    'alert', to_jsonb(a) || jsonb_build_object('tagged',
        coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'name', r.name, 'email', r.email) order by r.id)
                  from public.alert_recipients r where r.alert_id = a.id), '[]'::jsonb), 'readBy', '[]'::jsonb),
    'outbox', coalesce((select jsonb_agg(o.id order by o.id) from public.email_outbox o where o.alert_id = a.id), '[]'::jsonb))
  into v_out from public.alerts a where a.id = v_id;
  return v_out;
end $$;

create or replace function public.mark_alert_read(p_alert_id text) returns void
language sql security definer set search_path = '' as $$
  update public.alert_recipients set read_at = coalesce(read_at, now())
  where alert_id = p_alert_id and profile_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Push tokens (native app). A token belongs to whoever registered it last on that device.
-- ---------------------------------------------------------------------------
create or replace function public.register_push_token(p_token text, p_platform text, p_environment text default 'production',
                                                      p_device_name text default null, p_app_version text default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if brp.my_role() is null then raise exception 'Sign in with an active account first' using errcode = '42501'; end if;
  if p_token is null or length(p_token) < 16 or length(p_token) > 4096 then raise exception 'That push token does not look valid'; end if;
  if p_platform not in ('ios','android','web') then raise exception 'Platform must be ios, android or web'; end if;
  insert into public.push_tokens (profile_id, platform, token, environment, device_name, app_version)
  values (auth.uid(), p_platform, p_token, coalesce(p_environment, 'production'), left(p_device_name, 120), left(p_app_version, 40))
  on conflict (token) do update set profile_id = excluded.profile_id, platform = excluded.platform,
    environment = excluded.environment, device_name = excluded.device_name, app_version = excluded.app_version,
    last_seen_at = now(), disabled_at = null, last_error = null
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.unregister_push_token(p_token text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = p_token and profile_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Admin: role, installation, active
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_role(p_user uuid, p_role text, p_inst text default null, p_active boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_t    public.profiles;
  v_new  public.profiles;
  v_role text := brp.role_key(p_role);
begin
  if not brp.is_admin() then raise exception 'Admin only' using errcode = '42501'; end if;
  select * into v_t from public.profiles where id = p_user for update;
  if not found then raise exception 'No user with that id'; end if;
  if v_role is null then raise exception 'Unknown role: %', p_role; end if;
  if brp.is_demo_admin() and not v_t.demo then
    raise exception 'The demo admin account can change demo accounts only' using errcode = '42501';
  end if;
  if p_inst is not null and not exists (select 1 from public.installations where id = p_inst) then
    raise exception 'Unknown installation: %', p_inst;
  end if;
  if v_role = 'soldier' and p_inst is null then raise exception 'A Soldier account needs an installation'; end if;
  if p_user = auth.uid() and (v_role <> 'admin' or not coalesce(p_active, true)) then
    raise exception 'You cannot remove your own admin access. Ask another admin.';
  end if;
  if v_t.role = 'admin' and v_t.active and (v_role <> 'admin' or not coalesce(p_active, true))
     and (select count(*) from public.profiles where role = 'admin' and active) <= 1 then
    raise exception 'Keep at least one active admin';
  end if;
  perform set_config('brp.admin_fn', 'on', true);
  update public.profiles set role = v_role, inst = p_inst, active = coalesce(p_active, true)
  where id = p_user returning * into v_new;
  perform set_config('brp.admin_fn', 'off', true);
  return jsonb_build_object('id', v_new.id, 'email', v_new.email, 'role', v_new.role::text,
                            'role_label', brp.role_label(v_new.role), 'inst', v_new.inst, 'active', v_new.active);
end $$;

-- ---------------------------------------------------------------------------
-- Demo reset. brp.reset_demo_data() does the work (service role and the seed call it);
-- public.admin_reset_demo() is the Admin button. Accounts and push tokens stay; the nine demo
-- accounts get their demo role back; every operational table is reloaded from brp_seed.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, note) values
  ('demo_mode', '{"enabled": true}', 'When false, the demo reset is refused. Turn it off before any real data goes in.')
on conflict (key) do nothing;

create or replace function brp.reset_demo_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform set_config('brp.bulk', 'on', true);

  delete from public.po_lines;
  delete from public.purchase_list;
  delete from public.purchase_orders;
  delete from public.wo_events;
  delete from public.work_orders;
  delete from public.satisfaction;
  delete from public.email_outbox;
  delete from public.alert_recipients;
  delete from public.alerts;
  delete from public.stock;
  delete from public.cabinets;
  delete from public.parts;
  delete from public.catalog_items;
  delete from public.vendors;
  delete from public.rooms;
  delete from public.buildings;
  delete from public.installations;      -- profiles.inst is a deferred check, satisfied again below

  insert into public.installations    select * from brp_seed.installations;
  insert into public.buildings        select * from brp_seed.buildings;
  insert into public.rooms            select * from brp_seed.rooms;
  insert into public.vendors          select * from brp_seed.vendors;
  insert into public.catalog_items    select * from brp_seed.catalog_items;
  insert into public.parts            select * from brp_seed.parts;
  insert into public.cabinets         select * from brp_seed.cabinets;
  insert into public.stock            select * from brp_seed.stock;
  insert into public.work_orders      select * from brp_seed.work_orders;
  insert into public.wo_events        select * from brp_seed.wo_events;
  insert into public.purchase_orders  select * from brp_seed.purchase_orders;
  insert into public.po_lines         select * from brp_seed.po_lines;
  insert into public.purchase_list    select * from brp_seed.purchase_list;
  insert into public.satisfaction     select * from brp_seed.satisfaction;
  insert into public.alerts           select * from brp_seed.alerts;
  insert into public.alert_recipients select * from brp_seed.alert_recipients;
  insert into public.email_outbox     select * from brp_seed.email_outbox;

  -- Demo accounts get their demo role, installation and home room back.
  update public.profiles p set role = d.role, inst = d.inst, full_name = d.full_name,
         home_bldg = d.home_bldg, home_room = d.home_room, active = true, demo = true
  from brp_seed.demo_accounts d where lower(p.email) = d.email;
  -- Anyone else pointing at an installation that is no longer in the sample set loses the installation and is deactivated.
  update public.profiles p set inst = null, active = false
  where p.inst is not null and not exists (select 1 from public.installations i where i.id = p.inst);

  -- Link sample records to the demo people by name and email.
  update public.work_orders w set tech_id = p.id from public.profiles p where p.demo and p.role = 'technician' and p.full_name = w.tech_name;
  update public.work_orders w set soldier_id = p.id from public.profiles p where p.demo and p.role = 'soldier' and p.full_name = w.soldier_name;
  update public.satisfaction s set by_id = p.id from public.profiles p where not s.anon and p.demo and p.role = 'soldier' and p.full_name = s.by_name;
  update public.alert_recipients r set profile_id = p.id from public.profiles p where lower(p.email) = lower(r.email);

  perform setval('public.wo_seq', 10001, false);
  perform setval('public.csat_seq', 2001, false);
  perform setval('public.alert_seq', coalesce((select max(substr(id, 4)::int) from public.alerts where id ~ '^AL-\d+$'), 0) + 1, false);
  perform setval('public.plist_seq', coalesce((select max(substr(id, 4)::int) from public.purchase_list where id ~ '^PL-\d+$'), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.wo_events', 'id'), coalesce((select max(id) from public.wo_events), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.po_lines', 'id'), coalesce((select max(id) from public.po_lines), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.alert_recipients', 'id'), coalesce((select max(id) from public.alert_recipients), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.email_outbox', 'id'), coalesce((select max(id) from public.email_outbox), 0) + 1, false);

  perform set_config('brp.bulk', 'off', true);

  select jsonb_build_object(
    'installations', (select count(*) from public.installations), 'buildings', (select count(*) from public.buildings),
    'rooms', (select count(*) from public.rooms), 'work_orders', (select count(*) from public.work_orders),
    'purchase_orders', (select count(*) from public.purchase_orders), 'parts', (select count(*) from public.parts),
    'catalog_items', (select count(*) from public.catalog_items), 'stock', (select count(*) from public.stock),
    'satisfaction', (select count(*) from public.satisfaction), 'purchase_list', (select count(*) from public.purchase_list),
    'alerts', (select count(*) from public.alerts), 'email_outbox', (select count(*) from public.email_outbox)) into v;
  return v;
end $$;

create or replace function public.admin_reset_demo() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not brp.is_admin() then raise exception 'Admin only' using errcode = '42501'; end if;
  if coalesce((select (value->>'enabled')::boolean from public.settings where key = 'demo_mode'), false) is not true then
    raise exception 'Demo reset is turned off on this server (settings.demo_mode)' using errcode = '42501';
  end if;
  v := brp.reset_demo_data();
  insert into public.audit_log (actor_id, actor_email, actor_role, action, table_name, row_id, new_row)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), brp.my_role(), 'demo.reset', null, null, v);
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges. Postgres grants EXECUTE to PUBLIC by default, so take it back first.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema brp from public, anon;
revoke execute on function public.whoami(), public.raise_alert(jsonb), public.mark_alert_read(text),
  public.register_push_token(text, text, text, text, text), public.unregister_push_token(text),
  public.admin_set_role(uuid, text, text, boolean), public.admin_reset_demo() from public, anon;

grant execute on function public.whoami(), public.raise_alert(jsonb), public.mark_alert_read(text),
  public.register_push_token(text, text, text, text, text), public.unregister_push_token(text),
  public.admin_set_role(uuid, text, text, boolean), public.admin_reset_demo() to authenticated, service_role;

-- Policy helpers stay callable by signed-in users; the internals do not.
grant execute on function brp.uid(), brp.my_role(), brp.my_inst(), brp.my_name(), brp.sees_all(), brp.my_home_room(),
  brp.is_admin(), brp.is_demo_admin(), brp.is_alert_recipient(text), brp.alert_inst(text), brp.role_key(text),
  brp.role_label(text), brp.bulk(), brp.resolve_window(text) to authenticated, service_role;
revoke execute on function brp.reset_demo_data() from authenticated;
grant execute on function brp.reset_demo_data() to service_role;
