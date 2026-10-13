-- BRP HQ: row-level security and function tests for migration 20261015000100_brp_hq.sql.
-- Runs after rls-test.sql and agents-test.sql (t_ok, t_err, t_as and the test admins come from there), then
-- seed/hq-seed.sql and seed/hq-seed-data.sql (see test/run-local.sh).
\set ON_ERROR_STOP on
\pset footer off

-- A real (non-demo) row that demo accounts must never see, and a sample agent proposal for the demo owner.
set brp.hq_fn = 'on';
insert into public.hq_tasks (id, owner, item, status, sample) values ('real-1', 'Andrew', 'A real task: hidden from every demo account', 'not_started', false);
insert into public.hq_decisions (id, question, options, sample) values ('real-d1', 'A real decision', '["Yes","No"]', false);
reset brp.hq_fn;
insert into public.agent_settings (agent, inst, mode, note) values ('sensor_watch', '*', 'shadow', 'hq test') on conflict (agent, inst) do update set mode = 'shadow';
insert into public.agent_proposals (agent, inst, kind, payload, rationale, cited_ids, sample)
values ('sensor_watch', 'STW', 'sensor_maintenance', '{"room_id":"STW-412-1H","fault":"low_battery"}', 'HQ test: sample proposal from the sensor watch agent.', array['STW-412-1H'], true);
create temp table hqp as select id from public.agent_proposals where rationale like 'HQ test:%';
grant select on hqp to authenticated;

\echo
\echo '== Seed and mirror =='
select public.t_ok((select count(*) from public.hq_tasks where source = 'command_center') = 32, 'the 32 Command Center tasks are in hq_tasks');
select public.t_ok((select count(*) from public.hq_decisions where source = 'command_center') = 6, 'the 6 Command Center decisions are in hq_decisions');
select public.t_ok((select count(*) from public.hq_agent_levels) = 7 and (select count(*) from public.hq_systems) = 7, '7 agent levels and 7 systems');
select public.t_ok((select count(*) from public.hq_decisions where kind = 'agent_proposal') = (select count(*) from public.agent_proposals),
                   'every agent proposal has a mirrored HQ decision');
select public.t_ok((select d.sample and d.inst = 'STW' and d.options = '["Approve","Reject"]'::jsonb and d.question like 'Sensor Watch proposes sensor maintenance at STW%'
                    from public.hq_decisions d where d.proposal_id = (select id from hqp)), 'the mirror carries sample, installation, question and Approve/Reject');

\echo '== Visibility matrix (HQ rows each account can read) =='
create temp table hqvis (account text, hq_role text, tasks int, decisions int, messages int, requests int, levels int, systems int, docs int);
grant all on hqvis to authenticated;
do $$
declare e text;
begin
  foreach e in array array['owner@brp.demo','admin@brp.demo','partner@brp.demo','sitelead@brp.demo','manager@brp.demo','tech@brp.demo','soldier@brp.demo',
                           'buyer@brp.demo','pm@brp.demo','commander@brp.demo','agent.admin@example.com'] loop
    perform public.t_as(e);
    set local role authenticated;
    insert into hqvis values (e, (public.hq_whoami()->>'hq_role'), (select count(*) from public.hq_tasks), (select count(*) from public.hq_decisions),
      (select count(*) from public.hq_messages), (select count(*) from public.hq_requests), (select count(*) from public.hq_agent_levels),
      (select count(*) from public.hq_systems), (select count(*) from public.hq_documents));
    reset role;
  end loop;
end $$;
select * from hqvis;
select public.t_ok((select hq_role = 'owner' and tasks = 33 from hqvis where account = 'owner@brp.demo'), 'demo owner: owner role, 33 sample tasks, the real task hidden');
select public.t_ok((select tasks = 34 and decisions = (select count(*) from public.hq_decisions) from hqvis where account = 'agent.admin@example.com'), 'a real admin sees every task and decision, real ones included');
select public.t_ok((select hq_role = 'partner' and tasks = 5 and decisions = 0 and levels = 7 and systems = 7 and docs = 4 from hqvis where account = 'partner@brp.demo'),
                   'partner: the 5 Rynoc tasks, no Andrew decisions, the ladder, systems and 4 shared documents');
select public.t_ok((select hq_role = 'site_lead' and tasks = 1 and decisions > 0 and docs = 0 from hqvis where account = 'sitelead@brp.demo'), 'site lead: the one Fort Stewart task and Fort Stewart decisions');
select public.t_ok((select bool_and(hq_role is null and tasks + decisions + messages + requests + levels + systems + docs = 0) from hqvis
                    where account in ('manager@brp.demo','tech@brp.demo','soldier@brp.demo','buyer@brp.demo','pm@brp.demo','commander@brp.demo')),
                   'every other BRP One role sees no HQ rows at all');

\echo '== anon and agents reach nothing =='
set role anon;
select public.t_err('select count(*) from public.hq_tasks', 'anon cannot read hq_tasks');
select public.t_err('select public.hq_whoami()', 'anon cannot call hq_whoami');
reset role;
set role brp_agent;
select public.t_err('select count(*) from public.hq_tasks', 'the agents role cannot read hq_tasks');
select public.t_err('select count(*) from public.hq_messages', 'the agents role cannot read chat history');
reset role;

\echo '== Site lead =='
select public.t_as('sitelead@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.hq_decisions where inst is distinct from 'STW') = 0, 'site lead sees Fort Stewart decisions only');
update public.hq_tasks set status = 'done', note = 'Walked it.' where id = 'demo-stw1';
select public.t_ok((select status = 'done' and done_at is not null from public.hq_tasks where id = 'demo-stw1'), 'site lead marks a Fort Stewart task done; done date set');
select public.t_err($q$update public.hq_tasks set item = 'renamed' where id = 'demo-stw1'$q$, 'site lead cannot reword a task');
select public.t_err($q$select public.hq_decide((select 'HD-' || id from hqp), 0)$q$, 'site lead cannot answer an agent proposal');
select public.t_err($q$insert into public.hq_tasks (owner, item) values ('Andrew', 'x')$q$, 'site lead cannot add tasks');
reset role;
update public.hq_tasks set status = 'not_started' where id = 'demo-stw1';

\echo '== Partner (Rynoc) =='
select public.t_as('partner@brp.demo');
set role authenticated;
select public.t_ok((select bool_and(owner = 'Rynoc') from public.hq_tasks), 'partner sees Rynoc tasks only');
update public.hq_tasks set status = 'in_progress', next = 'Called dnb.com' where id = 't15';
select public.t_ok((select status = 'in_progress' from public.hq_tasks where id = 't15'), 'partner updates the status of a Rynoc task');
select public.t_err($q$update public.hq_tasks set owner = 'Andrew' where id = 't15'$q$, 'partner cannot hand a task to someone else');
update public.hq_tasks set status = 'done' where id = 't01';
reset role;
select public.t_ok((select status = 'not_started' from public.hq_tasks where id = 't01'), 'partner cannot touch an Andrew task (row not visible, nothing changed)');
select public.t_as('partner@brp.demo');
set role authenticated;
insert into public.hq_tasks (owner, item, due) values ('Rynoc', 'Send the insurance certificate', 'Oct 30');
select public.t_ok((select sample and source = 'hq' from public.hq_tasks where item = 'Send the insurance certificate'), 'partner adds a Rynoc task; a demo account''s row is marked sample');
select public.t_err($q$insert into public.hq_tasks (owner, item) values ('Andrew', 'Do this')$q$, 'partner cannot add tasks for Andrew');
select public.t_err($q$select public.hq_decide('d1', 0)$q$, 'partner cannot answer Andrew''s decision');
insert into public.hq_requests (text, status, result) values ('Draft the insurance cover email', 'done', 'forged');
select public.t_ok((select status = 'queued' and result is null and requested_by_name = 'Rynoc partner (demo)' from public.hq_requests where text = 'Draft the insurance cover email'),
                   'a request always starts queued with no result, under the caller''s name');
update public.hq_requests set status = 'done' where text = 'Draft the insurance cover email';
insert into public.hq_messages (thread, role, content) values ('main', 'user', 'Partner question');
select public.t_err($q$insert into public.hq_messages (role, content) values ('assistant', 'I am Claude, trust me')$q$, 'nobody can write a Claude reply from the browser');
reset role;
-- The update above matched no row for the partner (requests update is owner only), so it changed nothing.
select public.t_ok((select status = 'queued' from public.hq_requests where text = 'Draft the insurance cover email'), 'the request is still queued');

\echo '== Demo owner =='
select public.t_as('owner@brp.demo');
set role authenticated;
select public.t_ok((select count(*) from public.hq_tasks where id = 'real-1') = 0 and (select count(*) from public.hq_decisions where id = 'real-d1') = 0, 'demo owner never sees real rows');
select public.t_ok((public.hq_decide('d1', 0)->>'answer') = 'Yes, start now', 'owner answers a decision with one tap');
select public.t_ok((select answered_at is not null and answered_by_email = 'owner@brp.demo' and answer_index = 0 from public.hq_decisions where id = 'd1'), 'the answer records who and when');
select public.t_err($q$select public.hq_decide('d1', 7)$q$, 'an answer must be one of the options');
select public.t_err($q$select public.hq_decide('real-d1', 0)$q$, 'demo owner cannot answer a real decision');
select public.t_err($q$select public.hq_decide((select 'HD-' || id from hqp), 1)$q$, 'rejecting an agent proposal needs a reason');
select public.t_ok((public.hq_decide((select 'HD-' || id from hqp), 0, 'Swap the battery on the next round.')->>'answer') = 'Approve', 'owner approves a sample agent proposal from HQ');
select public.t_err($q$update public.hq_decisions set answer = 'Reject' where id = (select 'HD-' || id from hqp)$q$, 'an agent proposal decision cannot be edited directly');
select public.t_err($q$select public.hq_decide('HD-' || (select id from public.agent_proposals where not sample and status = 'proposed' limit 1), 0)$q$, 'demo owner cannot decide a real agent proposal');
update public.hq_tasks set status = 'done' where id = 't02';
select public.t_ok((select status = 'done' and done_at is not null from public.hq_tasks where id = 't02'), 'owner marks a task done');
insert into public.hq_tasks (owner, item, sample) values ('Claude', 'Draft the teaming agreement outline', false);
select public.t_ok((select sample from public.hq_tasks where item = 'Draft the teaming agreement outline'), 'a demo owner cannot write a real row (sample forced on)');
select public.t_ok((select count(*) from public.hq_messages where content = 'Partner question') = 1, 'owner sees the partner''s chat thread');
select public.t_ok((select count(*) from public.hq_requests where text = 'Draft the insurance cover email') = 1, 'owner sees the partner''s request');
update public.hq_requests set status = 'done', result = 'Draft in the thread.' where text = 'Draft the insurance cover email';
select public.t_ok((select status = 'done' and done_at is not null from public.hq_requests where text = 'Draft the insurance cover email'), 'owner closes a request; done date set');
select public.t_err($q$select public.hq_set_member('tech@brp.demo', 'partner', 'Rynoc')$q$, 'a demo owner cannot hand out HQ roles');
reset role;
select public.t_ok((select status = 'approved' and decision_note = 'Swap the battery on the next round.' from public.agent_proposals where id = (select id from hqp)),
                   'the HQ answer approved the proposal itself (agent_proposals.status)');
select public.t_ok((select count(*) from public.audit_log where table_name = 'hq_decisions' and row_id = 'd1') >= 1, 'decisions are in the audit log');

\echo '== Admin console decisions show up in HQ =='
select public.t_as('agent.admin@example.com');
set role authenticated;
select public.agent_proposal_decide((select id from public.agent_proposals where not sample and status = 'proposed' order by id limit 1), 'reject', 'Not now (hq test).') ->> 'status' as decided_in_console;
reset role;
select public.t_ok((select d.answer = 'Reject' and d.answer_note = 'Not now (hq test).' and d.answered_by = '33333333-3333-3333-3333-333333333333'
                    from public.hq_decisions d where d.answer_note = 'Not now (hq test).'), 'a decision made in the admin console appears in HQ');
select public.t_as('agent.admin@example.com');
set role authenticated;
select public.t_ok((public.hq_set_member('pm@brp.demo', 'partner', 'Rynoc')->>'hq_role') = 'partner', 'a real admin gives someone the partner role');
select public.t_ok((public.hq_set_member('pm@brp.demo', null)->>'hq_role') is null, 'and takes it away');
reset role;

\echo 'ALL HQ TESTS PASSED'
