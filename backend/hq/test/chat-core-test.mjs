#!/usr/bin/env node
// Command chat core tests. No network, no paid API: the model and fetch are mocks.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkReply } from '../../agents/reply-checker.mjs';
import { checkRules } from '../../supabase/functions/_shared/reply-rules.js';
import { runChat, runRead, fireRoutine, routineText, historyToMessages, anthropicCaller, TOOLS, READABLE, MODEL, FALLBACK } from '../../supabase/functions/hq-chat/core.js';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0, bad = 0;
function ok(cond, name) { n++; if (cond) console.log('ok  ' + name); else { bad++; console.log('FAIL ' + name); } }

// 1. The function's config copy matches the agent kit's.
const CFG = JSON.parse(read('agents/reply-checker.config.json'));
ok(read('supabase/functions/_shared/reply-checker.config.json') === read('agents/reply-checker.config.json'), 'function config copy equals backend/agents/reply-checker.config.json');

// 2. The rules-only port gives the same result as checkReply with no model, on the bench fixtures.
const fx = JSON.parse(read('agents/test/fixtures/run-002-replies.json'));
for (const c of fx.cases) {
  const input = { draft: c.draft, conversation: c.conversation, actions: c.prior_actions || [], draftActions: c.draft_actions };
  const a = await checkReply(input, { config: CFG });
  const b = checkRules(input, CFG);
  ok(a.reply === b.reply && a.removed.length === b.removed.length, `rules port matches checkReply on ${c.id} (${b.removed.length} removed)`);
}

// 3. Tools and model.
ok(MODEL === 'claude-opus-5-5', 'model is claude-opus-5-5');
ok(TOOLS.every((t) => t.name && t.description && t.input_schema && t.input_schema.type === 'object'), 'every tool has name, description, input_schema');
ok(historyToMessages([{ role: 'assistant', content: 'a' }, { role: 'system', content: 's' }, { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'b' }])
  .map((m) => m.role + ':' + m.content).join('|') === 'user:u1\n\nu2|assistant:b', 'history drops system rows, merges same-role turns, starts with user');

// 4. Reads stay on the allowlist.
const reads = [];
const readTable = async (t, cols, f, l) => { reads.push({ t, cols, f, l }); return t === 'hq_tasks' ? [{ id: 't01', item: 'File the LLC annual report', status: 'in_progress' }] : []; };
ok((await runRead({ table: 'profiles' }, readTable)).error, 'read of a table off the allowlist is refused');
ok((await runRead({ table: 'hq_tasks', filters: { secret: 1 } }, readTable)).error, 'filter on a column off the allowlist is refused');
ok((await runRead({ table: 'hq_tasks', filters: { status: { op: 'x' } } }, readTable)).error, 'object filter is refused');
const r1 = await runRead({ table: 'hq_tasks', filters: { status: 'in_progress' }, limit: 500 }, readTable);
ok(r1.count === 1 && reads.at(-1).l === 100 && reads.at(-1).cols === READABLE.hq_tasks, 'allowed read runs with the column allowlist and a capped limit');

// 5. Tool loop with a mocked model.
const calls = [];
const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig-1' };
const script = [
  { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'read_records', input: { table: 'hq_tasks', filters: { status: 'in_progress' } } },
    { type: 'tool_use', id: 'tu_2', name: 'read_records', input: { table: 'auth.users' } }] },
  { stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu_3', name: 'draft_task', input: { owner: 'CPA', item: 'Send Q3 receipts', due: 'Oct 20' } }] },
  { stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 9 }, content: [{ type: 'text', text: 'Task t01 is in progress. I drafted a task for the CPA to send Q3 receipts. I sent the receipts to the CPA.' }] },
];
const callModel = async (body) => { calls.push(JSON.parse(JSON.stringify(body))); return script[calls.length - 1]; };
const out = await runChat({ me: { name: 'Owner', email: 'owner@brp.demo', hq_role: 'owner' }, message: 'What is in progress?', history: [], today: '2026-10-13' }, { callModel, readTable, config: CFG });
ok(calls.length === 3 && out.rounds === 3, 'tool loop runs until end_turn');
ok(calls[0].model === 'claude-opus-5-5' && calls[0].max_tokens > 0 && typeof calls[0].system === 'string' && Array.isArray(calls[0].tools) && calls[0].messages[0].role === 'user', 'request has model, max_tokens, system, tools, messages');
ok(JSON.stringify(calls[1].messages[1].content) === JSON.stringify(script[0].content), 'assistant content (thinking included) is sent back unchanged');
const tr = calls[1].messages[2].content;
ok(calls[1].messages[2].role === 'user' && tr.length === 2 && tr[0].tool_use_id === 'tu_1' && tr[1].tool_use_id === 'tu_2', 'one tool_result per tool_use, ids match');
ok(!tr[0].is_error && JSON.parse(tr[0].content).count === 1 && tr[1].is_error === true, 'allowed read returns rows; refused read is is_error');
ok(out.drafts.length === 1 && out.drafts[0].kind === 'task' && out.drafts[0].owner === 'CPA', 'draft_task becomes a draft the person saves');
ok(!/sent the receipts/.test(out.reply) && /in progress/.test(out.reply) && out.checked.changed, 'unbacked "I sent" claim is removed, the rest stays');
ok(out.usage.input_tokens === 60 && out.usage.output_tokens === 19 && out.stop_reason === 'end_turn', 'usage summed across rounds');
const empty = await runChat({ message: 'hi', history: [] }, { callModel: async () => ({ stop_reason: 'end_turn', content: [] }), readTable, config: CFG });
ok(empty.reply === FALLBACK, 'empty answer falls back to the plain fallback line');
let capped = 0;
await runChat({ message: 'loop', history: [] }, { callModel: async () => { capped++; return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x' + capped, name: 'read_records', input: { table: 'hq_tasks' } }] }; }, readTable, config: CFG });
ok(capped === 6, 'tool loop stops after 6 rounds');

// 6. Messages API caller shape (mock fetch).
let seen = null;
const call = anthropicCaller('test-key', async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ content: [], stop_reason: 'end_turn' }) }; });
await call({ model: MODEL, max_tokens: 10, messages: [] });
ok(seen.url === 'https://api.anthropic.com/v1/messages' && seen.init.headers['x-api-key'] === 'test-key' && seen.init.headers['anthropic-version'] === '2023-06-01', 'Messages API call uses x-api-key and anthropic-version 2023-06-01');
let threw = false; try { anthropicCaller(''); } catch { threw = true; }
ok(threw, 'no key, no caller');

// 7. Routine fire (mock fetch).
const req = { id: 'RQ-0007', message_id: 42, thread: 'main', requested_by: '11111111-2222-3333-4444-555555555555', text: 'Draft the Q4 plan' };
const txt = routineText(req, { name: 'HQ owner (demo)', email: 'owner@brp.demo' }, 'https://x.supabase.co/functions/v1/hq-result');
ok(txt.includes('RQ-0007') && txt.includes('hq_messages id 42') && txt.includes(req.requested_by) && txt.includes('Draft the Q4 plan'), 'fire text carries request id, message id, thread owner and the message');
ok((await fireRoutine({ url: '', token: '', text: 'x' })).ok === false, 'no routine configured: request waits, nothing sent');
ok((await fireRoutine({ url: 'http://insecure', token: 't', text: 'x' })).ok === false, 'non-https fire URL refused');
let fired = null;
const f = await fireRoutine({ url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire', token: 'tok', text: txt },
  async (url, init) => { fired = { url, init }; return { ok: true, json: async () => ({ type: 'routine_fire', claude_code_session_id: 's1', claude_code_session_url: 'https://claude.ai/code/s1' }) }; });
ok(fired.init.headers.Authorization === 'Bearer tok' && fired.init.headers['anthropic-beta'] === 'experimental-cc-routine-2026-04-01' && JSON.parse(fired.init.body).text === txt, 'fire uses Bearer token, routine beta header and {text}');
ok(f.ok && f.session_url === 'https://claude.ai/code/s1', 'fire returns the routine session url');
const f2 = await fireRoutine({ url: 'https://a/fire', token: 't', text: 'x' }, async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) }));
ok(!f2.ok && /429/.test(f2.note), 'fire failure is reported, request keeps waiting');

// 8. post-reply.mjs prints checked SQL.
const sql = execFileSync('node', [new URL('hq/tools/post-reply.mjs', ROOT).pathname, '--owner', req.requested_by, '--request', 'RQ-0007', '--done'],
  { input: "Plan drafted in docs/q4.md. I've told Rynoc it's done.", encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
ok(/insert into public\.hq_messages/.test(sql) && /'assistant'/.test(sql) && /'Claude', 'Plan drafted in docs\/q4\.md\.'/.test(sql) && /status = 'done'/.test(sql), 'post-reply.mjs checks the reply and prints insert + request update');

// 9. Edge Function TypeScript parses.
let ts = null;
try { ts = createRequire(import.meta.url)('typescript'); } catch {
  try { ts = createRequire(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim() + '/')('typescript'); } catch { ts = null; }
}
for (const p of ['supabase/functions/hq-chat/index.ts', 'supabase/functions/hq-result/index.ts']) {
  if (!ts) { console.log('skip ' + p + ' syntax check (typescript not installed)'); continue; }
  const r = ts.transpileModule(read(p), { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  ok(!(r.diagnostics || []).length, p + ' parses');
}

console.log(bad ? `${bad} of ${n} CHAT CORE TESTS FAILED` : `ALL CHAT CORE TESTS PASSED (${n})`);
process.exit(bad ? 1 : 0);
