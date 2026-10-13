-- BRP One backend: tests for migration 4 (operations agents in shadow mode). Runs after rls-test.sql (see run-local.sh),
-- which defines t_ok / t_err / t_as. Checks: the brp_agent role reads only what it should and writes only proposals and
-- run rows; proposals cite real records and carry the money check; the weekly cap matches Andrew's rule, including the
-- 3-month switch and the +10% ceiling; only an Admin decides a proposal.
\set ON_ERROR_STOP on
\pset footer off

grant execute on function public.t_ok(boolean, text), public.t_err(text, text) to brp_agent;
-- Act as an agent the way the agent-mcp Edge Function does: role brp_agent plus a brp_agent claim.
create or replace function public.t_agent(p_agent text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('brp_agent', p_agent)::text, false); end $$;
grant execute on function public.t_agent(text) to anon, authenticated, brp_agent;

-- A non-demo admin (as if Andrew created one), so a real decision can be tested.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'agent.admin@example.com', '', now(),
        '{"brp_role":"admin","brp_active":true}', '{"full_name":"Agent Admin"}', now(), now());

\echo
\echo '== Money rule: weekly cap per installation (test installations, fixed clock) =='
-- Week boundaries are Monday 00:00 America/Chicago. The fixed "now" is Wed Oct 14, 2026 12:00 Chicago (week of Oct 12).
insert into public.installations (id, name, sample) values ('TST-A', 'Test A (new site)', true), ('TST-B', 'Test B (13 weeks at $1,000)', true),
  ('TST-C', 'Test C (13 weeks at $3,000)', true), ('TST-D', 'Test D (proposals)', true);
-- TST-A: first spend Sep 1, 2026. Under 3 months of history on Oct 14.
insert into public.purchase_orders (id, inst, status, total, issued_at) values ('T-A-1', 'TST-A', 'received', 100, '2026-09-01 10:00 America/Chicago');
-- TST-B: first spend Jun 2 ($200), then $1,000 every Tuesday from Jul 14 to Oct 6 (13 weeks), plus noise that must not count.
insert into public.purchase_orders (id, inst, status, total, issued_at) values ('T-B-0', 'TST-B', 'received', 200, '2026-06-02 10:00 America/Chicago');
insert into public.purchase_orders (id, inst, status, total, issued_at)
  select 'T-B-' || g, 'TST-B', 'received', 1000, ('2026-07-14 10:00'::timestamp + (g - 1) * interval '7 days') at time zone 'America/Chicago' from generate_series(1, 13) g;
insert into public.purchase_orders (id, inst, status, total, issued_at) values
  ('T-B-X', 'TST-B', 'cancelled', 5000, '2026-09-15 10:00 America/Chicago'),     -- cancelled: never counts
  ('T-B-W', 'TST-B', 'issued',     300, '2026-10-12 09:00 America/Chicago');     -- this week: counts toward this week, not the average
insert into public.purchase_orders (id, inst, status, total, issued_at) values ('T-B-R', 'TST-B', 'requested', 9000, null);  -- not placed
-- TST-C: $3,000 a week for the 13 weeks before Oct 12 (first spend Jul 13).
insert into public.purchase_orders (id, inst, status, total, issued_at)
  select 'T-C-' || g, 'TST-C', 'received', 3000, ('2026-07-13 08:00'::timestamp + (g - 1) * interval '7 days') at time zone 'America/Chicago' from generate_series(1, 13) g;

create temp table cap as select i, public.buyer_weekly_cap(i, '2026-10-14 12:00 America/Chicago') c from unnest(array['TST-A','TST-B','TST-C']) i;
select i as inst, c->>'rule' as rule, c->>'weekly_cap' as weekly_cap, c->>'average_weekly_spend' as avg_week, c->>'detail' as detail from cap order by i;
select public.t_ok((select c->>'rule' = 'default' and (c->>'weekly_cap')::numeric = 2500 from cap where i = 'TST-A'), 'under 3 months of history: weekly cap is $2,500');
select public.t_ok((select c->>'rule' = 'trailing_average' and (c->>'trailing_spend')::numeric = 13000 and (c->>'average_weekly_spend')::numeric = 1000
                    and (c->>'weekly_cap')::numeric = 1100 from cap where i = 'TST-B'),
                   'TST-B: 13 weeks at $1,000 (cancelled, unplaced and this week''s orders left out): cap = $1,000 + 10% = $1,100');
select public.t_ok((select c->>'from_week' = '2026-07-13' and c->>'to_week' = '2026-10-05' from cap where i = 'TST-B'), 'trailing window is the 13 full weeks before this week');
select public.t_ok((select (c->>'weekly_cap')::numeric = 3300 from cap where i = 'TST-C'), 'TST-C: average $3,000 gives $3,300, above the $2,500 default but never more than +10%');
select public.t_ok((select (c->>'weekly_cap')::numeric / (c->>'average_weekly_spend')::numeric = 1.1 from cap where i = 'TST-C'), 'cap is exactly average x 1.10');

-- The 3-month switch for TST-B (first spend Tue Jun 2, 2026 10:00 Chicago, so the switch is Sep 2, 2026 10:00).
select public.t_ok((public.buyer_weekly_cap('TST-B', '2026-09-02 09:59 America/Chicago')->>'rule') = 'default'
                   and (public.buyer_weekly_cap('TST-B', '2026-09-02 09:59 America/Chicago')->>'weekly_cap')::numeric = 2500,
                   'one minute before 3 months of history: still the $2,500 default');
-- On Thu Sep 3 (week of Aug 31) the 13 weeks Jun 1 to Aug 24 hold $200 + 7 x $1,000 = $7,200. $7,200 / 13 x 1.1 = $609.23.
select public.t_ok((public.buyer_weekly_cap('TST-B', '2026-09-03 12:00 America/Chicago')->>'rule') = 'trailing_average'
                   and (public.buyer_weekly_cap('TST-B', '2026-09-03 12:00 America/Chicago')->>'weekly_cap')::numeric = 609.23,
                   'after 3 months the cap switches to the trailing average: $7,200 / 13 x 1.1 = $609.23 (can be below $2,500)');
-- Settings override: history since May 1 for TST-A switches it to the average: $100 / 13 x 1.1 = $8.46.
update public.settings set value = jsonb_set(value, '{history_since}', '{"TST-A": "2026-05-01"}') where key = 'buyer_money_rule';
select public.t_ok((public.buyer_weekly_cap('TST-A', '2026-10-14 12:00 America/Chicago')->>'weekly_cap')::numeric = 8.46, 'history_since override in settings is honored');
update public.settings set value = jsonb_set(value, '{history_since}', '{}') where key = 'buyer_money_rule';

\echo '== Money rule: spend check (per order, weekly cap, approver) =='
-- TST-B this week: $300 spent, cap $1,100.
select public.t_ok((select (c->>'needs_approval')::boolean = false and c->>'approver' = 'auto' and (c->>'week_spend_before')::numeric = 300
                    from public.buyer_spend_check('TST-B', 450, '2026-10-14 12:00 America/Chicago') c), '$450 with $300 spent this week: inside both limits, auto');
select public.t_ok((select c->'codes' = '[]' and c->>'approver' = 'auto'
                    from public.buyer_spend_check('TST-B', 500, '2026-10-14 12:00 America/Chicago') c), '$500 exactly is at the per-order limit, not over it');
select public.t_ok((select c->'codes' = '["over_per_order_limit", "over_weekly_cap"]' and c->>'approver' = 'site_lead'
                    from public.buyer_spend_check('TST-B', 900, '2026-10-14 12:00 America/Chicago') c), '$900: over $500 per order, and $300 + $900 is over the $1,100 cap: site lead');
select public.t_ok((select (c->>'week_spend_before')::numeric = 0 and c->'codes' = '[]'
                    from public.buyer_spend_check('TST-B', 450, '2026-10-12 08:00 America/Chicago') c), 'week-to-date spend counts only orders issued by the time asked');
-- TST-C this week: $3,000 already issued Monday. Cap $3,300 (average $3,000 + 10%).
insert into public.purchase_orders (id, inst, status, total, issued_at) values ('T-C-W', 'TST-C', 'issued', 3000, '2026-10-12 09:00 America/Chicago');
select public.t_ok((select c->'codes' = '[]' from public.buyer_spend_check('TST-C', 300, '2026-10-14 12:00 America/Chicago') c),
                   'TST-C: $3,000 + $300 = $3,300 is exactly average + 10%: allowed');
select public.t_ok((select c->'codes' = '["over_weekly_cap"]' and c->>'approver' = 'site_lead'
                    from public.buyer_spend_check('TST-C', 300.01, '2026-10-14 12:00 America/Chicago') c),
                   'TST-C: one cent more is over the weekly cap (never more than +10%): site lead');
select public.t_ok((public.buyer_weekly_cap('TST-C', '2026-10-14 12:00 America/Chicago')->>'weekly_cap')::numeric = 3300, 'this week''s own spend does not raise this week''s cap');
select public.t_ok((select c->>'approver' = 'program_manager' and c->'codes' ? 'over_site_lead_authority'
                    from public.buyer_spend_check('TST-C', 2600, '2026-10-14 12:00 America/Chicago') c), 'over $2,500 for one order: program manager');
select public.t_err($q$select public.buyer_spend_check('TST-B', 0)$q$, 'a $0 order is refused');

\echo '== brp_agent: reads =='
select public.t_agent('buyer_dispatch');
set role brp_agent;
select public.t_ok((select count(*) from public.work_orders) > 0, 'buyer_dispatch reads work orders');
select public.t_ok((select count(*) from public.purchase_orders where inst = 'STW') > 0, 'buyer_dispatch reads purchase orders');
select public.t_ok((select count(*) from public.purchase_list) > 0, 'buyer_dispatch reads the purchase list (its input queue)');
select public.t_err('select soldier_name from public.work_orders limit 1', 'agent cannot read Soldier names on work orders');
select public.t_err('select * from public.work_orders limit 1', 'agent cannot select * (column grants only)');
select public.t_err('select count(*) from public.profiles', 'agent cannot read profiles');
select public.t_err('select count(*) from public.satisfaction', 'agent cannot read satisfaction answers');
select public.t_err('select count(*) from public.email_outbox', 'agent cannot read the email outbox');
select public.t_err('select count(*) from public.audit_log', 'agent cannot read the audit log');
select public.t_err('select count(*) from public.push_tokens', 'agent cannot read push tokens');
select public.t_err('select requested_by_name from public.purchase_list limit 1', 'agent cannot read who requested a purchase');
select public.t_ok((public.agent_read('work_orders', '{"inst": "STW", "status": ["open", "waiting_parts"]}', 5)->>'count')::int between 1 and 5, 'agent_read filters and limits');
select public.t_ok((select bool_and(r ? 'title' and not (r ? 'soldier_name')) from jsonb_array_elements(public.agent_read('work_orders', '{}', 50)->'rows') r), 'agent_read never returns Soldier columns');
select public.t_err($q$select public.agent_read('work_orders', '{"soldier_name": "x"}')$q$, 'agent_read refuses a filter on a hidden column');
select public.t_err($q$select public.agent_read('profiles')$q$, 'agent_read refuses a table off the list');
select public.t_ok((public.agent_read('work_orders', '{"id": {"gte": "1''; drop table public.rooms; --"}}')->>'count') is not null, 'agent_read quotes filter values (an injection attempt is only a comparison)');
reset role;
select public.t_ok((select count(*) from public.rooms) = 141, 'rooms table still intact after the injection attempt');

select public.t_agent('sensor_watch');
set role brp_agent;
select public.t_ok((select count(*) from public.rooms) > 0, 'sensor_watch reads rooms');
select public.t_ok((select count(*) from public.purchase_orders) = 0, 'sensor_watch sees no purchase orders (not on its list)');
select public.t_ok((select count(*) from public.purchase_list) = 0, 'sensor_watch sees no purchase list');
select public.t_err($q$select public.agent_read('purchase_orders')$q$, 'agent_read refuses purchase orders to sensor_watch');
reset role;

select set_config('request.jwt.claims', '', false);
set role brp_agent;
select public.t_ok((select count(*) from public.work_orders) = 0 and (select count(*) from public.vendors) = 0, 'brp_agent with no agent claim sees nothing');
select public.t_err($q$select public.agent_begin_run()$q$, 'brp_agent with no agent claim cannot start a run');
reset role;

select public.t_agent('soldier_liaison');
set role brp_agent;
select public.t_ok((select count(*) from public.work_orders) = 0 and (select count(*) from public.installations) = 0, 'soldier_liaison (off) sees nothing');
select public.t_err($q$select public.agent_propose('STW', 'intake', '{}', 'A Soldier reported a leak in the hall.', array['STW'])$q$, 'soldier_liaison (off) cannot propose');
reset role;

\echo '== brp_agent: no writes to operations data =='
select public.t_agent('buyer_dispatch');
set role brp_agent;
select public.t_err($q$update public.work_orders set status = 'closed' where id = 'WO-24366'$q$, 'agent cannot update a work order');
select public.t_err($q$insert into public.work_orders (inst, bldg, room, title, prio) values ('STW','412','1K','x','Routine')$q$, 'agent cannot create a work order');
select public.t_err($q$delete from public.work_orders where id = 'WO-24366'$q$, 'agent cannot delete a work order');
select public.t_err($q$update public.purchase_orders set status = 'issued'$q$, 'agent cannot change a PO');
select public.t_err($q$insert into public.purchase_orders (id, inst, total) values ('X-1','STW',10)$q$, 'agent cannot place a PO');
select public.t_err($q$insert into public.po_lines (po_id, sku, qty) values ('BRP-STW-27-0436','FLT-1620',1)$q$, 'agent cannot add PO lines');
select public.t_err($q$update public.stock set qty = 0$q$, 'agent cannot change stock');
select public.t_err($q$update public.rooms set status = 'ok'$q$, 'agent cannot change rooms');
select public.t_err($q$insert into public.wo_events (wo_id, body) values ('WO-24366','x')$q$, 'agent cannot write work order history');
select public.t_err($q$update public.purchase_list set status = 'ordered'$q$, 'agent cannot change the purchase list');
select public.t_err($q$select public.raise_alert('{"title":"x"}')$q$, 'agent cannot raise alerts');
select public.t_err($q$update public.settings set value = '{}' where key = 'buyer_money_rule'$q$, 'agent cannot change the money rule');
select public.t_err($q$update public.agent_settings set mode = 'live'$q$, 'agent cannot change its own mode');
select public.t_err($q$insert into public.agent_settings (agent, inst, mode) values ('buyer_dispatch','STW','live')$q$, 'agent cannot add a mode row');
select public.t_err($q$select public.admin_set_agent_mode('buyer_dispatch', 'STW', 'live')$q$, 'agent cannot call admin_set_agent_mode');
select public.t_err($q$select public.agent_proposal_decide('AP-00001', 'approve')$q$, 'agent cannot decide proposals');
reset role;
select public.t_ok((select status <> 'closed' from public.work_orders where id = 'WO-24366'), 'work order unchanged');
select public.t_ok(not exists (select 1 from information_schema.role_table_grants where grantee = 'brp_agent' and privilege_type in ('UPDATE','DELETE','TRUNCATE')),
                   'brp_agent holds no UPDATE, DELETE or TRUNCATE grant on any table');
select public.t_ok((select array_agg(distinct table_name::text order by table_name::text) from information_schema.column_privileges
                    where grantee = 'brp_agent' and privilege_type = 'INSERT') = array['agent_proposals','agent_runs'],
                   'brp_agent can INSERT only into agent_runs and agent_proposals');

\echo '== brp_agent: runs and proposals =='
select public.t_agent('buyer_dispatch');
set role brp_agent;
create temp table run as select public.agent_begin_run('sesn_test', 'claude-opus-5-5') r;
select public.t_ok((select r->>'agent' = 'buyer_dispatch' and r->'proposal_kinds' ? 'purchase_order' and r->'money_rule' is not null from run), 'begin_run returns the agent, its kinds and the money rule');
select public.t_ok((select r->'readable_tables' ? 'purchase_list' and not (r->'readable_tables' ? 'profiles') from run), 'begin_run lists only readable tables');
create temp table p1 as select public.agent_propose('STW', 'priority',
  '{"wo_id": "WO-24366", "from": "Urgent", "to": "Emergency"}', 'Intake text says water is still running into the hallway; active water is Emergency (core/05).',
  array['WO-24366'], (select (r->>'run_id')::uuid from run)) p;
grant select on run, p1 to public;   -- temp tables created as the agent; later steps read them as other roles
select public.t_ok((select p->>'id' like 'AP-%' and p->>'status' = 'proposed' from p1), 'agent writes a proposal with cited record ids');
select public.t_err($q$select public.agent_propose('STW', 'priority', '{"wo_id":"WO-99999"}', 'Made-up record should be refused here.', array['WO-99999'])$q$, 'proposal citing a record that does not exist is refused');
select public.t_err($q$select public.agent_propose('STW', 'priority', '{}', 'No citations at all should be refused.', array[]::text[])$q$, 'proposal with no cited ids is refused');
select public.t_err($q$select public.agent_propose('STW', 'page_oncall', '{}', 'Buyer cannot page the on-call technician.', array['WO-24366'])$q$, 'agent cannot propose a kind outside its role');
insert into public.agent_proposals (agent, inst, kind, payload, rationale, cited_ids) values ('sensor_watch', 'STW', 'wo_note', '{}', 'Trying to write as another agent.', array['WO-24366']);
select public.t_ok((select agent = 'buyer_dispatch' from public.agent_proposals where rationale = 'Trying to write as another agent.'), 'agent cannot propose as another agent (name comes from the claim)');
select public.t_err($q$update public.agent_proposals set status = 'approved'$q$, 'agent cannot approve its own proposals');
select public.t_err($q$delete from public.agent_proposals$q$, 'agent cannot delete proposals');
reset role;

\echo '== brp_agent: purchase proposals carry the money check =='
-- TST-D: no history (default $2,500 cap). One $2,200 order already issued this week.
insert into public.purchase_orders (id, inst, status, total, issued_at) values ('T-D-1', 'TST-D', 'issued', 2200, now() - interval '1 minute');
insert into public.vendors (id, name) values ('V-TST', 'Test vendor (sample)');
select public.t_agent('buyer_dispatch');
set role brp_agent;
create temp table pp as select
  public.agent_propose('TST-D', 'purchase_order', '{"vendor_id": "V-TST", "lines": [{"sku": "FLT-1620", "qty": 10, "unit_cost": 28.5}], "shipping": 0, "total": 285, "approval_level": "auto"}',
    'Cabinet below reorder point; quote on file. Inside both limits.', array['V-TST','FLT-1620','TST-D']) a,
  public.agent_propose('TST-D', 'purchase_order', '{"vendor_id": "V-TST", "lines": [{"sku": "FLT-1620", "qty": 20, "unit_cost": 30}], "shipping": 12, "total": 612}',
    'Two cabinets below reorder point; one order, not split.', array['V-TST','FLT-1620']) b,
  public.agent_propose('TST-D', 'purchase_order', '{"vendor_id": "V-TST", "total": 2600, "lines": [{"sku": "FLT-1620", "qty": 1, "unit_cost": 100}]}',
    'Large replenishment order for the whole site.', array['V-TST']) c;
select public.t_ok((select a->'flags' = '[]' and a->>'approver_required' is null from pp), '$285 with $2,200 spent: inside $500 and the $2,500 cap, no flag');
select public.t_ok((select b->'flags' = '["over_per_order_limit", "over_weekly_cap"]' and b->>'approver_required' = 'site_lead' from pp), '$612 is flagged over $500 and over the weekly cap; routed to the site lead');
select public.t_ok((select c->>'approver_required' = 'program_manager' and c->'flags' ? 'total_mismatch' from pp), '$2,600 goes to the program manager; a total that does not match its lines is flagged');
select public.t_err($q$select public.agent_propose('TST-D', 'purchase_order', '{"vendor_id":"V-TST","total":350,"approval_level":"auto"}', 'Claims auto approval while over the weekly cap.', array['V-TST'])$q$,
                    'over-cap proposal that claims auto approval is rejected');
select public.t_err($q$select public.agent_propose('TST-D', 'purchase_order', '{"vendor_id":"V-TST"}', 'No total given for the order.', array['V-TST'])$q$, 'purchase proposal without a total is rejected');
select public.t_ok((public.agent_end_run((select (r->>'run_id')::uuid from run), true, 'Test run: 5 proposals.')->>'proposals')::int = 1, 'end_run logs the finish and counts this run''s proposals');
reset role;
select public.t_ok((select array_agg(event order by id) from public.agent_runs where session_ref = 'sesn_test' or run_id = (select (r->>'run_id')::uuid from run)) = array['start','finish'], 'run log has a start and a finish row');

\echo '== Off switch per installation =='
select public.t_as('agent.admin@example.com');
set role authenticated;
select public.admin_set_agent_mode('sensor_watch', 'STW', 'off', 'Test: off at Fort Stewart');
reset role;
select public.t_agent('sensor_watch');
set role brp_agent;
select public.t_ok((select count(*) from public.rooms where inst = 'STW') = 0 and (select count(*) from public.rooms where inst = 'BLS') > 0, 'sensor_watch off at STW: sees no STW rooms, still sees Fort Bliss');
select public.t_err($q$select public.agent_propose('STW', 'sensor_work_order', '{}', 'Humidity above 60 percent for 72 hours.', array['STW-412-3F'])$q$, 'sensor_watch off at STW cannot propose there');
reset role;
select public.t_as('agent.admin@example.com');
set role authenticated;
select public.admin_set_agent_mode('sensor_watch', 'STW', 'shadow', 'Test: back to shadow');
reset role;
select public.t_ok((select count(*) from public.audit_log where table_name = 'agent_settings') >= 2, 'mode changes are audited');

\echo '== People: who reads and who decides =='
select public.t_as('manager@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.agent_proposals) = 0, 'barracks manager does not see agent proposals');
select public.t_err($q$select public.agent_proposal_decide((select id from public.agent_proposals limit 1), 'approve')$q$, 'barracks manager cannot decide');
select public.t_err($q$select public.agent_propose('STW', 'priority', '{}', 'A person cannot write as an agent.', array['WO-24366'])$q$, 'a signed-in person cannot call agent_propose');
select public.t_err($q$insert into public.agent_proposals (agent, inst, kind, rationale, cited_ids) values ('buyer_dispatch','STW','priority','Direct insert by a person.', array['WO-24366'])$q$, 'a signed-in person cannot insert proposals');
reset role;
-- A person who forges the agent claim alongside their own session is still not the agent.
select set_config('request.jwt.claims', json_build_object('sub', (select id from auth.users where email = 'manager@brp.demo'), 'role', 'authenticated', 'brp_agent', 'buyer_dispatch')::text, false);
set role authenticated;
select public.t_ok(brp.agent_name() is null, 'a brp_agent claim on a person''s session is ignored');
reset role;
select public.t_as('sitelead@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.agent_proposals) > 0 and (select count(*) from public.agent_proposals where inst <> 'STW') = 0, 'site lead reads Fort Stewart proposals only');
select public.t_ok((public.buyer_weekly_cap('STW')->>'weekly_cap')::numeric > 0, 'site lead can read the cap for Fort Stewart');
select public.t_err($q$select public.buyer_weekly_cap('BLS')$q$, 'site lead cannot read the cap for another installation');
reset role;
select public.t_as('admin@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.agent_proposals) >= 5, 'admin reads every proposal');
select public.t_err($q$select public.agent_proposal_decide((select p->>'id' from p1), 'approve')$q$, 'demo admin cannot decide real (non-sample) proposals');
select public.t_err($q$select public.admin_set_agent_mode('buyer_dispatch', '*', 'live')$q$, 'demo admin cannot set an agent live');
reset role;
select public.t_as('agent.admin@example.com');
set role authenticated;
select public.t_err($q$select public.agent_proposal_decide((select p->>'id' from p1), 'reject')$q$, 'a rejection needs a reason');
select public.agent_proposal_decide((select p->>'id' from p1), 'approve', 'Agree: active water is Emergency.') ->> 'status' as decided;
select public.t_err($q$select public.agent_proposal_decide((select p->>'id' from p1), 'reject', 'changed my mind')$q$, 'a decided proposal cannot be decided again');
select public.t_err($q$update public.agent_proposals set rationale = 'edited'$q$, 'nobody edits a proposal directly');
reset role;
select public.t_ok((select status = 'approved' and decided_by = '33333333-3333-3333-3333-333333333333' and decided_at is not null from public.agent_proposals where id = (select p->>'id' from p1)),
                   'approval records who and when');
select public.t_ok((select count(*) from public.audit_log where table_name = 'agent_proposals' and row_id = (select p->>'id' from p1)) = 1, 'the decision is in the audit log');
select public.t_ok((select prio from public.work_orders where id = 'WO-24366') = (select prio from brp_seed.work_orders where id = 'WO-24366'), 'approving a shadow proposal executes nothing: WO-24366 priority unchanged');

\echo 'ALL AGENT TESTS PASSED'
