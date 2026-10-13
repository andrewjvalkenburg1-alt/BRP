-- BRP One backend, migration 2 of 3: role helpers, row-level security and grants.
--
-- The model in one paragraph:
--   Every signed-in person has one row in profiles with a role and an installation (inst, null = all installations).
--   An inactive profile has no role, so it sees nothing. Scope: an Admin sees every installation; any other staff role
--   with inst null sees every installation; a staff role with inst set sees that installation only; a Soldier never
--   sees all installations, only their own requests, room and answers. Writes follow the BRP One permissions
--   (HOST-API.md: wo.write, po.write, stock.write, csat.write, alerts.raise, outbox.read). COR and Commander are read-only.
--   Role and installation changes go only through public.admin_set_role (migration 3).
--
-- Policies call the helpers inside (select ...) so Postgres evaluates them once per statement, not once per row.

-- ---------------------------------------------------------------------------
-- Helpers (security definer, so they can read profiles under RLS without recursion)
-- ---------------------------------------------------------------------------
create or replace function brp.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function brp.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select p.role::text from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function brp.my_inst() returns text
language sql stable security definer set search_path = '' as $$
  select p.inst from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function brp.my_name() returns text
language sql stable security definer set search_path = '' as $$
  select p.full_name from public.profiles p where p.id = auth.uid() and p.active
$$;

-- true for Admin, and for any active staff role whose installation is null (all installations). Never for a Soldier.
create or replace function brp.sees_all() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' or (p.inst is null and p.role <> 'soldier')
                   from public.profiles p where p.id = auth.uid() and p.active), false)
$$;

create or replace function brp.my_home_room() returns text
language sql stable security definer set search_path = '' as $$
  select p.inst || '-' || p.home_bldg || '-' || p.home_room
  from public.profiles p where p.id = auth.uid() and p.active and p.home_room is not null
$$;

create or replace function brp.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' from public.profiles p where p.id = auth.uid() and p.active), false)
$$;

-- true when the current admin is one of the public demo accounts (password published). Demo admins may only touch demo data.
create or replace function brp.is_demo_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' and p.demo from public.profiles p where p.id = auth.uid() and p.active), false)
$$;

-- Used by the alert policies so alerts and alert_recipients do not reference each other through RLS.
create or replace function brp.is_alert_recipient(p_alert text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.alert_recipients r where r.alert_id = p_alert and r.profile_id = auth.uid())
$$;
create or replace function brp.alert_inst(p_alert text) returns text
language sql stable security definer set search_path = '' as $$
  select a.inst from public.alerts a where a.id = p_alert
$$;

grant usage on schema brp to authenticated, service_role;
grant execute on all functions in schema brp to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. No table is reachable without a policy.
-- ---------------------------------------------------------------------------
alter table public.installations    enable row level security;
alter table public.profiles         enable row level security;
alter table public.buildings        enable row level security;
alter table public.rooms            enable row level security;
alter table public.work_orders      enable row level security;
alter table public.wo_events        enable row level security;
alter table public.vendors          enable row level security;
alter table public.catalog_items    enable row level security;
alter table public.parts            enable row level security;
alter table public.cabinets         enable row level security;
alter table public.stock            enable row level security;
alter table public.purchase_orders  enable row level security;
alter table public.po_lines         enable row level security;
alter table public.purchase_list    enable row level security;
alter table public.satisfaction     enable row level security;
alter table public.alerts           enable row level security;
alter table public.alert_recipients enable row level security;
alter table public.email_outbox     enable row level security;
alter table public.push_tokens      enable row level security;
alter table public.audit_log        enable row level security;
alter table public.settings         enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select brp.uid())
  or (select brp.is_admin())
  or ((select brp.my_role()) <> 'soldier' and active
      and ((select brp.sees_all()) or inst is null or inst = (select brp.my_inst())))
);
-- Own row (name, phone, alert preferences). A trigger blocks role, inst, active, email and demo changes outside admin_set_role.
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select brp.uid())) with check (id = (select brp.uid()));
create policy profiles_update_admin on public.profiles for update to authenticated
  using ((select brp.is_admin()) and (demo or not (select brp.is_demo_admin())))
  with check ((select brp.is_admin()));

-- ---------------------------------------------------------------------------
-- installations, buildings, rooms (setup and intake data)
-- ---------------------------------------------------------------------------
create policy inst_select on public.installations for select to authenticated using (
  (select brp.sees_all()) or id = (select brp.my_inst())
);
create policy inst_write on public.installations for all to authenticated
  using ((select brp.is_admin()) or ((select brp.my_role()) = 'program_manager' and (select brp.sees_all())))
  with check ((select brp.is_admin()) or ((select brp.my_role()) = 'program_manager' and (select brp.sees_all())));

create policy bldg_select on public.buildings for select to authenticated using (
  (select brp.sees_all()) or inst = (select brp.my_inst())
);
create policy bldg_insert on public.buildings for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy bldg_update on public.buildings for update to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
         and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.sees_all()) or inst = (select brp.my_inst()));
create policy bldg_delete on public.buildings for delete to authenticated using (
  (select brp.my_role()) = any (array['admin','program_manager'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);

create policy rooms_select on public.rooms for select to authenticated using (
  ((select brp.my_role()) <> 'soldier' and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  or id = (select brp.my_home_room())
);
create policy rooms_insert on public.rooms for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy rooms_update on public.rooms for update to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
         and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.sees_all()) or inst = (select brp.my_inst()));
create policy rooms_delete on public.rooms for delete to authenticated using (
  (select brp.my_role()) = any (array['admin','program_manager'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);

-- ---------------------------------------------------------------------------
-- work orders and their history
-- ---------------------------------------------------------------------------
create policy wo_select on public.work_orders for select to authenticated using (
  ((select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager','buyer','cor','commander'])
     and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  or ((select brp.my_role()) = 'technician' and tech_id = (select brp.uid()))
  or ((select brp.my_role()) = 'soldier' and soldier_id = (select brp.uid()))
);
create policy wo_insert_staff on public.work_orders for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager','technician'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy wo_insert_soldier on public.work_orders for insert to authenticated with check (
  (select brp.my_role()) = 'soldier' and soldier_id = (select brp.uid()) and inst = (select brp.my_inst()) and status = 'open'
);
create policy wo_update_staff on public.work_orders for update to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
         and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.sees_all()) or inst = (select brp.my_inst()));
create policy wo_update_tech on public.work_orders for update to authenticated
  using ((select brp.my_role()) = 'technician' and tech_id = (select brp.uid()))
  with check (tech_id = (select brp.uid()));
create policy wo_delete on public.work_orders for delete to authenticated using ((select brp.is_admin()));

-- History follows the work order: if you can see the order, you can see its history.
create policy woev_select on public.wo_events for select to authenticated using (
  exists (select 1 from public.work_orders w where w.id = wo_id)
);
create policy woev_insert on public.wo_events for insert to authenticated with check (
  (select brp.my_role()) <> all (array['cor','commander','buyer'])
  and actor_id = (select brp.uid())
  and exists (select 1 from public.work_orders w where w.id = wo_id)
);
create policy woev_admin on public.wo_events for delete to authenticated using ((select brp.is_admin()));

-- ---------------------------------------------------------------------------
-- vendors, catalog, parts (reference data: any staff role reads, purchasing roles write)
-- ---------------------------------------------------------------------------
create policy vend_select on public.vendors for select to authenticated using ((select brp.my_role()) <> 'soldier');
create policy vend_write on public.vendors for all to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','buyer']))
  with check ((select brp.my_role()) = any (array['admin','program_manager','buyer']));

create policy cat_select on public.catalog_items for select to authenticated using ((select brp.my_role()) <> 'soldier');
create policy cat_write on public.catalog_items for all to authenticated
  using ((select brp.is_admin())) with check ((select brp.is_admin()));

create policy parts_select on public.parts for select to authenticated using ((select brp.my_role()) <> 'soldier');
create policy parts_write on public.parts for all to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','buyer','site_lead']))
  with check ((select brp.my_role()) = any (array['admin','program_manager','buyer','site_lead']));

-- ---------------------------------------------------------------------------
-- cabinets and stock (stock.write: Admin, Program manager, Site lead, Buyer, Technician)
-- ---------------------------------------------------------------------------
create policy cab_select on public.cabinets for select to authenticated using (
  (select brp.my_role()) <> 'soldier' and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy cab_write on public.cabinets for all to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead']) and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.my_role()) = any (array['admin','program_manager','site_lead']) and ((select brp.sees_all()) or inst = (select brp.my_inst())));

create policy stock_select on public.stock for select to authenticated using (
  (select brp.my_role()) <> 'soldier' and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy stock_insert on public.stock for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer','technician'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy stock_update on public.stock for update to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer','technician'])
         and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.sees_all()) or inst = (select brp.my_inst()));
create policy stock_delete on public.stock for delete to authenticated using ((select brp.is_admin()));

-- ---------------------------------------------------------------------------
-- purchase orders (po.write: Admin, Program manager, Site lead, Buyer. COR reads.)
-- ---------------------------------------------------------------------------
create policy po_select on public.purchase_orders for select to authenticated using (
  ((select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer','cor','commander','barracks_manager'])
     and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  or ((select brp.my_role()) = 'technician' and wo_id is not null
      and exists (select 1 from public.work_orders w where w.id = wo_id))
);
create policy po_insert on public.purchase_orders for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy po_update on public.purchase_orders for update to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer'])
         and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  with check ((select brp.sees_all()) or inst = (select brp.my_inst()));
create policy po_delete on public.purchase_orders for delete to authenticated using ((select brp.is_admin()));

create policy pol_select on public.po_lines for select to authenticated using (
  exists (select 1 from public.purchase_orders p where p.id = po_id)
);
create policy pol_write on public.po_lines for all to authenticated
  using ((select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer'])
         and exists (select 1 from public.purchase_orders p where p.id = po_id))
  with check ((select brp.my_role()) = any (array['admin','program_manager','site_lead','buyer'])
         and exists (select 1 from public.purchase_orders p where p.id = po_id));

-- ---------------------------------------------------------------------------
-- purchasing list: Admin only, read and write (Andrew: the purchasing list sits behind the admin login).
-- The BRP One purchasing module (brp-purchasing.js) upserts here as an Admin.
-- ---------------------------------------------------------------------------
create policy pl_admin on public.purchase_list for all to authenticated
  using ((select brp.is_admin())) with check ((select brp.is_admin()));

-- ---------------------------------------------------------------------------
-- satisfaction (csat.write: Barracks manager, Site lead, Program manager, Admin; Soldiers answer for themselves)
-- ---------------------------------------------------------------------------
create policy csat_select on public.satisfaction for select to authenticated using (
  ((select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager','commander','cor'])
     and ((select brp.sees_all()) or inst = (select brp.my_inst())))
  or ((select brp.my_role()) = 'soldier' and by_id = (select brp.uid()))
);
create policy csat_insert_staff on public.satisfaction for insert to authenticated with check (
  (select brp.my_role()) = any (array['admin','program_manager','site_lead','barracks_manager'])
  and ((select brp.sees_all()) or inst = (select brp.my_inst()))
);
create policy csat_insert_soldier on public.satisfaction for insert to authenticated with check (
  (select brp.my_role()) = 'soldier' and inst = (select brp.my_inst())
  and (by_id is null or by_id = (select brp.uid()))
);
create policy csat_admin on public.satisfaction for delete to authenticated using ((select brp.is_admin()));

-- ---------------------------------------------------------------------------
-- alerts (written only by public.raise_alert, read by the tagged people, Site leads and PMs in scope, and Admin)
-- ---------------------------------------------------------------------------
create policy alerts_select on public.alerts for select to authenticated using (
  (select brp.is_admin())
  or brp.is_alert_recipient(id)
  or ((select brp.my_role()) = any (array['program_manager','site_lead'])
      and ((select brp.sees_all()) or inst = (select brp.my_inst())))
);
create policy alerts_delete on public.alerts for delete to authenticated using ((select brp.is_admin()));

create policy ar_select on public.alert_recipients for select to authenticated using (
  profile_id = (select brp.uid())
  or (select brp.is_admin())
  or ((select brp.my_role()) = any (array['program_manager','site_lead'])
      and ((select brp.sees_all()) or brp.alert_inst(alert_id) = (select brp.my_inst())))
);

-- outbox.read: Admin, Site lead, Program manager
create policy outbox_select on public.email_outbox for select to authenticated using (
  (select brp.is_admin())
  or ((select brp.my_role()) = any (array['program_manager','site_lead'])
      and ((select brp.sees_all()) or inst = (select brp.my_inst())))
);

-- ---------------------------------------------------------------------------
-- push tokens: your own device tokens only. Admin can see and remove any.
-- ---------------------------------------------------------------------------
create policy push_select on public.push_tokens for select to authenticated using (
  profile_id = (select brp.uid()) or (select brp.is_admin())
);
create policy push_insert on public.push_tokens for insert to authenticated with check (profile_id = (select brp.uid()));
create policy push_update on public.push_tokens for update to authenticated
  using (profile_id = (select brp.uid())) with check (profile_id = (select brp.uid()));
create policy push_delete on public.push_tokens for delete to authenticated using (
  profile_id = (select brp.uid()) or (select brp.is_admin())
);

-- ---------------------------------------------------------------------------
-- audit log: Admin and COR read. Nobody writes from the client (triggers write it).
-- ---------------------------------------------------------------------------
create policy audit_select on public.audit_log for select to authenticated using (
  (select brp.my_role()) = any (array['admin','cor'])
);

-- settings: any active user reads; Admin (not the public demo admin) changes them.
create policy settings_select on public.settings for select to authenticated using ((select brp.my_role()) is not null);
create policy settings_update on public.settings for update to authenticated
  using ((select brp.is_admin()) and not (select brp.is_demo_admin()))
  with check ((select brp.is_admin()) and not (select brp.is_demo_admin()));

-- ---------------------------------------------------------------------------
-- Grants. The anon key can reach nothing. authenticated is filtered by the policies above.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on schema brp_seed from anon, authenticated;
revoke all on all tables in schema brp_seed from anon, authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.alerts, public.alert_recipients, public.email_outbox, public.audit_log from authenticated;
revoke insert, delete on public.profiles, public.settings from authenticated;
grant delete on public.alerts to authenticated;                         -- the policy limits it to Admin
grant usage on all sequences in schema public to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on schema brp_seed to service_role;
grant all on all tables in schema brp_seed to service_role;
