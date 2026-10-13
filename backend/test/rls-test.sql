-- BRP One backend: row-level security and function tests. Run on a local Postgres after
-- test/supabase-shim.sql, the three migrations and supabase/seed/seed.sql (see test/run-local.sh).
-- Each block impersonates a demo account the way Supabase does: role authenticated + request.jwt.claims.sub.
\set ON_ERROR_STOP on
\pset footer off

create or replace function public.t_ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; raise notice 'ok  %', msg; end $$;
create or replace function public.t_err(stmt text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then raise notice 'ok  % (refused: %)', msg, sqlerrm; return; end;
  raise exception 'FAIL: % (statement was allowed)', msg;
end $$;
create or replace function public.t_as(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated')::text, false);
end $$;
grant execute on function public.t_ok(boolean, text), public.t_err(text, text), public.t_as(text) to anon, authenticated;

-- A non-demo admin and a non-demo user (as if Andrew created them), to test the demo-admin limits.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'real.admin@example.com', '', now(),
        '{"brp_role":"admin","brp_active":true}', '{"full_name":"Real Admin"}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'new.signup@example.com', '', now(),
        '{}', '{"full_name":"New Signup"}', now(), now());

\echo
\echo '== Visibility matrix (rows each account can read) =='
create temp table vis (account text, profiles int, rooms int, work_orders int, wo_events int, purchase_orders int, stock int,
                       purchase_list int, satisfaction int, alerts int, outbox int, audit int, vendors int);
grant all on vis to authenticated;
do $$
declare e text;
begin
  foreach e in array array['soldier@brp.demo','tech@brp.demo','manager@brp.demo','sitelead@brp.demo','pm@brp.demo','buyer@brp.demo',
                           'cor@brp.demo','commander@brp.demo','admin@brp.demo','new.signup@example.com'] loop
    perform public.t_as(e);
    set local role authenticated;
    insert into vis values (e, (select count(*) from public.profiles), (select count(*) from public.rooms), (select count(*) from public.work_orders),
      (select count(*) from public.wo_events), (select count(*) from public.purchase_orders), (select count(*) from public.stock),
      (select count(*) from public.purchase_list), (select count(*) from public.satisfaction), (select count(*) from public.alerts),
      (select count(*) from public.email_outbox), (select count(*) from public.audit_log), (select count(*) from public.vendors));
    reset role;
  end loop;
end $$;
select * from vis;

\echo '== anon key reaches nothing =='
set role anon;
select public.t_err('select count(*) from public.work_orders', 'anon cannot read work orders');
select public.t_err('select public.raise_alert(''{"title":"x"}'')', 'anon cannot raise alerts');
reset role;

\echo '== Soldier =='
select public.t_as('soldier@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders where soldier_name <> 'SGT J. Parker') = 0, 'soldier sees only own requests');
select public.t_ok((select count(*) from public.work_orders) >= 1, 'soldier sees own requests');
select public.t_ok((select array_agg(id) from public.rooms) = array['STW-412-1K'], 'soldier sees only home room STW-412-1K');
select public.t_ok((select count(*) from public.vendors) = 0, 'soldier sees no vendors');
select public.t_ok((select count(*) from public.profiles) = 1, 'soldier sees only own profile');
select public.t_err($q$insert into public.work_orders (inst, bldg, room, title, prio) values ('BLS','20214','101','x','Routine')$q$, 'soldier cannot file for another installation');
insert into public.work_orders (inst, bldg, room, title, prio, soldier_id) values ('STW','412','1K','Test request: hall light out','Routine', auth.uid());
select public.t_ok((select source = 'Soldier' and soldier_name = 'SGT J. Parker' and id like 'WO-1%' and room_id = 'STW-412-1K' from public.work_orders where title = 'Test request: hall light out'), 'soldier request gets id, source, name and room');
update public.work_orders set status = 'closed';
select public.t_ok((select count(*) from public.work_orders where status = 'closed' and title = 'Test request: hall light out') = 0, 'soldier update changed nothing');
insert into public.satisfaction (inst, bldg, room, score, scale, text, anon, by_id) values ('STW','412','1K',1,'3','Still dripping',true,null);
reset role;
select public.t_ok((select by_id is null and by_name is null from public.satisfaction where text = 'Still dripping'), 'anonymous answer stores no identity');
select public.t_as('soldier@brp.demo');
set role authenticated;
select public.t_err($q$update public.profiles set role = 'admin' where id = auth.uid()$q$, 'soldier cannot make themself admin');
update public.profiles set phone = '555-0100' where id = auth.uid();
select public.t_ok((select phone = '555-0100' from public.profiles where id = auth.uid()), 'soldier can edit own phone');
reset role;

\echo '== Technician =='
select public.t_as('tech@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders where tech_name is distinct from 'D. Reyes') = 0, 'technician sees only own queue');
select public.t_ok((select count(*) from public.work_orders) > 0, 'technician queue is not empty');
update public.work_orders set status = 'in_progress', step = 'Accepted' where id = 'T-2107';
select public.t_ok((select status = 'in_progress' from public.work_orders where id = 'T-2107'), 'technician updates own order');
select public.t_err($q$update public.work_orders set prio = 'Routine' where id = 'T-2107'$q$, 'technician cannot change priority');
update public.work_orders set status = 'closed' where id = 'WO-24366';
reset role;
select public.t_ok((select status <> 'closed' from public.work_orders where id = 'WO-24366'), 'technician cannot touch another tech''s order');
select public.t_as('tech@brp.demo');
set role authenticated;
select public.register_push_token('ios-token-0123456789abcdef', 'ios', 'sandbox', 'D. Reyes iPhone', '1.0');
select public.t_ok((select count(*) from public.push_tokens) = 1, 'technician registered a push token');
update public.stock set qty = qty - 1 where cabinet_id = 'CAB-STW' and sku = 'FLT-1620';
select public.t_ok((select qty = 18 from public.stock where cabinet_id = 'CAB-STW' and sku = 'FLT-1620'), 'technician pulls stock in own installation');
update public.stock set qty = 0 where cabinet_id = 'CAB-BLS';
reset role;
select public.t_ok((select sum(qty) > 0 from public.stock where cabinet_id = 'CAB-BLS'), 'technician cannot change another installation''s stock');

\echo '== Barracks manager (Fort Stewart) =='
select public.t_as('manager@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders where inst <> 'STW') = 0, 'manager sees Fort Stewart only');
select public.t_ok((select count(*) from public.push_tokens) = 0, 'manager cannot see the technician''s push token');
select public.t_ok((select count(*) from public.audit_log) = 0, 'manager cannot read the audit log');
update public.rooms set status = 'offline', offline_reason = 'Carpet replacement' where id = 'STW-305-1A';
select public.t_ok((select status = 'offline' from public.rooms where id = 'STW-305-1A'), 'manager edits a Fort Stewart room');
select public.t_err($q$update public.profiles set inst = 'BLS' where id = auth.uid()$q$, 'manager cannot change own installation');
select public.t_err($q$select public.admin_set_role(auth.uid(), 'admin', null, true)$q$, 'manager cannot call admin_set_role');
select public.t_err($q$select public.admin_reset_demo()$q$, 'manager cannot reset demo data');
select (public.raise_alert('{"title":"PTAC leaking again","body":"Second leak this week.","severity":"high","type":"custom","ref":"wo:WO-24364","tags":[{"role":"Buyer"}]}')->'alert'->'tagged') as fanout;
reset role;
select public.t_ok((select inst = 'STW' from public.alerts where title = 'PTAC leaking again'), 'alert installation comes from the work order');
select public.t_ok((select array_agg(email order by email) from public.alert_recipients r join public.alerts a on a.id = r.alert_id where a.title = 'PTAC leaking again')
                   = array['buyer@brp.demo','manager@brp.demo','sitelead@brp.demo'], 'fan-out: tagged buyer plus the site lead and manager by default');
select public.t_ok((select count(*) = 3 and bool_and(status = 'logged') from public.email_outbox o join public.alerts a on a.id = o.alert_id where a.title = 'PTAC leaking again'), 'one outbox row per person, logged, not sent');
select public.t_as('manager@brp.demo');
set role authenticated;
select public.t_err($q$select public.raise_alert('{"title":"x","inst":"BLS"}')$q$, 'manager cannot raise alerts for Fort Bliss');
select public.t_err($q$insert into public.email_outbox (to_email, subject, body) values ('x@example.com','s','b')$q$, 'nobody writes the outbox from the client');
reset role;

\echo '== Site lead =='
select public.t_as('sitelead@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.email_outbox where inst <> 'STW') = 0 and (select count(*) from public.email_outbox) > 0, 'site lead reads the Fort Stewart outbox only');
select public.t_ok((select count(*) from public.alerts where title = 'PTAC leaking again') = 1, 'site lead sees the alert they were tagged on');
reset role;

\echo '== Buyer =='
select public.t_as('buyer@brp.demo');
set role authenticated;
update public.work_orders set status = 'closed' where id = 'WO-24366';
update public.purchase_orders set status = 'issued' where id = 'BRP-STW-27-0436';
select public.t_ok((select status = 'issued' from public.purchase_orders where id = 'BRP-STW-27-0436'), 'buyer issues a PO');
select public.t_ok((select count(*) from public.purchase_list) = 0, 'buyer cannot read the purchasing list (Admin only)');
select public.t_err($q$insert into public.purchase_list (id, status, note) values ('D01', 'not_ordered', 'x')$q$, 'buyer cannot write the purchasing list');
reset role;
select public.t_as('admin@brp.demo');
set role authenticated;
-- the purchasing module's row shape
insert into public.purchase_list (id, status, note, po_id, description, qty) values ('D01', 'not_ordered', 'Lever locksets for Bldg 305', null, 'Door lever lockset', 4)
  on conflict (id) do update set status = excluded.status, note = excluded.note, po_id = excluded.po_id;
insert into public.purchase_list (id, status, note, po_id, description, qty) values ('D01', 'ordered', 'Lever locksets for Bldg 305', 'BRP-STW-27-0436', 'Door lever lockset', 4)
  on conflict (id) do update set status = excluded.status, note = excluded.note, po_id = excluded.po_id;
select public.t_ok((select status = 'ordered' and updated_by = 'admin@brp.demo' from public.purchase_list where id = 'D01'), 'admin upsert in the purchasing module shape works, updated_by stamped');
reset role;
select public.t_ok((select status <> 'closed' from public.work_orders where id = 'WO-24366'), 'buyer cannot change work orders');

\echo '== COR and Commander (read-only) =='
select public.t_as('cor@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders) = 54, 'COR reads every work order');
update public.purchase_orders set status = 'cancelled';
select public.t_err($q$insert into public.wo_events (wo_id, body, actor_id) values ('WO-24366','note',auth.uid())$q$, 'COR cannot add work order notes');
select public.t_ok((select count(*) from public.audit_log) > 0, 'COR reads the audit log');
reset role;
select public.t_ok((select count(*) from public.purchase_orders where status = 'cancelled') = 0, 'COR cannot change POs');
select public.t_as('commander@brp.demo');
set role authenticated;
update public.rooms set status = 'ok';
select public.t_ok((select count(*) from public.satisfaction) > 1000, 'commander reads satisfaction');
reset role;
select public.t_ok((select count(*) from public.rooms where status <> 'ok') > 0, 'commander cannot change rooms');

\echo '== New sign-up (inactive until an admin sets a role) =='
select public.t_as('new.signup@example.com');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders) = 0 and (select count(*) from public.installations) = 0, 'inactive sign-up sees nothing');
select public.t_ok((public.whoami()->>'active')::boolean = false, 'whoami reports inactive');
reset role;

\echo '== Admin =='
select public.t_as('admin@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.profiles) = 11, 'admin sees every profile');
select public.admin_set_role((select id from public.profiles where email = 'manager@brp.demo'), 'Barracks manager', 'BRG', true);
select public.t_err($q$select public.admin_set_role('22222222-2222-2222-2222-222222222222', 'site_lead', 'STW', true)$q$, 'demo admin cannot change a real account');
select public.t_err($q$select public.admin_set_role(auth.uid(), 'buyer', null, true)$q$, 'admin cannot demote themself');
update public.settings set value = '{"enabled":true}' where key = 'email_delivery';
reset role;
select public.t_ok((select value->>'enabled' = 'false' from public.settings where key = 'email_delivery'), 'email delivery still off');
select public.t_ok((select count(*) from public.audit_log where action = 'role.change') = 1, 'role change is audited');
select public.t_as('manager@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.work_orders where inst = 'BRG') > 0 and (select count(*) from public.work_orders where inst = 'STW') = 0, 'manager moved to Fort Bragg sees Bragg only');
reset role;

select public.t_as('real.admin@example.com');
set role authenticated;
select public.admin_set_role('22222222-2222-2222-2222-222222222222', 'technician', 'BLS', true);
reset role;
select public.t_ok((select role = 'technician' and active from public.profiles where email = 'new.signup@example.com'), 'real admin activates a new account');

select public.t_as('admin@brp.demo');
set role authenticated;
select public.admin_reset_demo() as reset_counts;
reset role;
select public.t_ok((select inst = 'STW' from public.profiles where email = 'manager@brp.demo'), 'reset restores the demo manager to Fort Stewart');
select public.t_ok((select count(*) from public.alerts) = 3 and (select count(*) from public.email_outbox) = 9, 'reset restores the sample alerts and outbox');
select public.t_ok((select count(*) from public.work_orders where title = 'Test request: hall light out') = 0, 'reset removes new work orders');
select public.t_ok((select count(*) from public.push_tokens) = 1, 'reset keeps push tokens');
select public.t_ok((select role = 'technician' from public.profiles where email = 'new.signup@example.com'), 'reset leaves real accounts alone');
select public.t_ok((select count(*) from public.audit_log where action = 'demo.reset') = 1, 'reset is audited');
select public.t_ok((select count(*) from public.work_orders where tech_id is not null) > 0 and (select count(*) from public.work_orders where soldier_id is not null) > 0, 'sample orders linked to demo tech and soldier');

update public.settings set value = '{"enabled": false}' where key = 'demo_mode';
select public.t_as('real.admin@example.com');
set role authenticated;
select public.t_err($q$select public.admin_reset_demo()$q$, 'reset refused once demo mode is off');
reset role;

\echo 'ALL TESTS PASSED'
