// Local test of the agent MCP server's tool layer (supabase/functions/agent-mcp/mcp.ts) against the local Postgres
// built by test/run-local.sh. No network, no Anthropic API. Run: node backend/agents/test/mcp-test.mjs
import assert from 'node:assert/strict';
import { handleBody, toolsFor } from '../../supabase/functions/agent-mcp/mcp.ts';
import { agentExec } from './pg-exec.mjs';

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('ok  ' + msg); };
const call = (ctx, id, name, args) => handleBody({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, ctx);
const parse = (r) => JSON.parse(r.result.content[0].text);

const buyer = { agent: 'buyer_dispatch', exec: agentExec('buyer_dispatch') };
const sensor = { agent: 'sensor_watch', exec: agentExec('sensor_watch') };

const init = await handleBody({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, buyer);
ok(init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools, 'initialize negotiates the protocol and offers tools');
ok((await handleBody({ jsonrpc: '2.0', method: 'notifications/initialized' }, buyer)) === null, 'notifications get no response body');

const list = await handleBody({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, buyer);
ok(list.result.tools.map((t) => t.name).join(',') === 'brp_begin_run,brp_read,brp_spend_status,brp_propose,brp_end_run', 'buyer_dispatch sees exactly 5 tools: begin, read, spend status, propose, end');
ok(!toolsFor('sensor_watch').some((t) => t.name === 'brp_spend_status'), 'sensor_watch does not get the spend tool');
ok(toolsFor('buyer_dispatch').every((t) => !/update|delete|insert|order_place|close/i.test(t.name)), 'no tool can update, delete, place an order or close anything');

const begin = parse(await call(buyer, 3, 'brp_begin_run', { session_ref: 'sesn_local_test', model: 'claude-opus-5-5' }));
ok(begin.agent === 'buyer_dispatch' && /^[0-9a-f-]{36}$/.test(begin.run_id) && /SHADOW MODE/.test(begin.rule), 'brp_begin_run returns a run id and the shadow rule');

const wos = parse(await call(buyer, 4, 'brp_read', { table: 'work_orders', filter: { inst: 'STW', status: ['open', 'waiting_parts'] }, limit: 3, order: 'created_at', desc: true }));
ok(wos.count >= 1 && wos.rows.every((r) => r.inst === 'STW' && !('soldier_name' in r)), 'brp_read returns filtered rows without Soldier columns');
const bad = await call(buyer, 5, 'brp_read', { table: 'profiles' });
ok(bad.result.isError && /may not read/.test(bad.result.content[0].text), 'brp_read refuses profiles');
const sbad = await call(sensor, 6, 'brp_read', { table: 'purchase_orders' });
ok(sbad.result.isError, 'sensor_watch cannot read purchase orders');

const spend = parse(await call(buyer, 7, 'brp_spend_status', { installation: 'STW', amount: 640 }));
ok(spend.needs_approval === true && spend.approver === 'site_lead' && spend.codes.includes('over_per_order_limit'), '$640 at Fort Stewart needs the site lead (over $500 per order)');

const wo = wos.rows[0];
const prop = parse(await call(buyer, 8, 'brp_propose', { installation: 'STW', kind: 'human_task', run_id: begin.run_id, cited_ids: [wo.id],
  payload: { role: 'barracks_manager', task_type: 'inspection', wo_id: wo.id }, rationale: `${wo.id} is open with no inspection on record; every work order needs a barracks manager inspection (OPERATOR-BRIEF).` }));
ok(/^AP-\d{5}$/.test(prop.id) && prop.status === 'proposed', 'brp_propose writes a proposal: ' + prop.id);
const fake = await call(buyer, 9, 'brp_propose', { installation: 'STW', kind: 'wo_note', run_id: begin.run_id, cited_ids: ['WO-00000'], payload: {}, rationale: 'Citing a record that does not exist.' });
ok(fake.result.isError && /not found/.test(fake.result.content[0].text), 'a made-up record id is refused and the agent is told why');
const po = parse(await call(buyer, 10, 'brp_propose', { installation: 'STW', kind: 'purchase_order', run_id: begin.run_id, cited_ids: ['FLT-1620'],
  payload: { vendor_id: null, lines: [{ sku: 'FLT-1620', qty: 30, unit_cost: 21 }], shipping: 0, total: 630 }, rationale: 'Thirty filters to refill both Fort Stewart cabinets in one order.' }));
ok(po.approver_required === 'site_lead' && po.flags.includes('over_per_order_limit'), '$630 purchase proposal is flagged and routed to the site lead');
const auto = await call(buyer, 11, 'brp_propose', { installation: 'STW', kind: 'purchase_order', run_id: begin.run_id, cited_ids: ['FLT-1620'],
  payload: { total: 630, approval_level: 'auto' }, rationale: 'Same order, claiming auto approval.' });
ok(auto.result.isError && /cannot be auto-approved/.test(auto.result.content[0].text), 'claiming auto approval over the limit is refused');
const unknown = await handleBody({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'order_place', arguments: {} } }, buyer);
ok(unknown.error && unknown.error.code === -32602, 'a tool that does not exist (order_place) is an error');

const end = parse(await call(buyer, 13, 'brp_end_run', { run_id: begin.run_id, summary: 'Local MCP test run.' }));
ok(end.logged === true && end.proposals === 2, 'brp_end_run logs the finish; this run wrote 2 proposals');

console.log(`ALL MCP TESTS PASSED (${n})`);
