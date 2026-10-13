// BRP HQ "Ask Claude": the part of the hq-chat Edge Function that does not depend on Deno, so Node tests can run it
// with a mocked model and mocked tables. index.ts wires it to Supabase (the caller's JWT) and the Messages API.
//
// One turn:
//   1. The caller's history in this thread (last 30 messages) plus the new message go to the Messages API with the
//      system prompt and the tools below.
//   2. While the model asks for tools, each tool runs AS THE CALLER (row-level security decides what it can read) and
//      the results go back as tool_result blocks. At most MAX_ROUNDS rounds.
//   3. Draft tools never write. They return a draft that HQ shows with a Save button; only Andrew's tap saves it.
//   4. The final text goes through the reply checker rules (backend/agents/reply-checker.config.json). Only the checked
//      text is stored and shown. The draft tools count as the action records the checker looks for.
import { checkRules } from '../_shared/reply-rules.js';

export const MODEL = 'claude-opus-5-5';
export const MAX_ROUNDS = 6;
export const MAX_TOKENS = 8000;
export const HISTORY = 30;
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const FALLBACK = 'I could not give you a checked answer to that. Ask it another way, or send it to the Claude team.';

// What the read tool may touch: table -> columns. Anything else is refused before the database sees it.
// Soldier names, account ids and free-text Soldier comments are left out on purpose.
export const READABLE = {
  hq_tasks: 'id,owner,desk,area,item,status,due,sort_date,next,note,inst,shared,updated_at,done_at',
  hq_decisions: 'id,kind,proposal_id,question,context,options,recommended,owner,answer,answer_note,answered_at,sort_date,inst',
  hq_requests: 'id,text,status,result,links,requested_by_name,created_at,done_at',
  hq_agent_levels: 'id,name,agent,level,mode,evidence,next',
  hq_systems: 'id,name,status,state,url,note',
  hq_documents: 'id,title,url,area,note,owner',
  installations: 'id,name,state,climate,lead_name,manager_name,pilot',
  rooms: 'id,inst,bldg,room,occupancy,status,offline_reason,sensor_rh,sensor_temp_f,sensor_state,sensor_read_at',
  work_orders: 'id,inst,bldg,room,title,prio,status,step,source,created_at,due_at,closed_at,tech_name,po_ids',
  purchase_orders: 'id,inst,vendor_id,status,total,issued_at,eta,wo_id,kind',
  purchase_list: 'id,inst,description,qty,est_unit_cost,vendor_id,source,status,po_id,reason',
  stock: 'cabinet_id,inst,sku,qty,rop',
  parts: 'sku,name,cat,cost,vendor_id,lead_days,rop',
  vendors: 'id,name,city,cat',
  agent_proposals: 'id,agent,inst,kind,status,rationale,cited_ids,flags,approver_required,created_at,decision_note',
  agent_settings: 'agent,inst,mode,note',
  alerts: 'id,at,type,severity,title,inst,ref',
};

export const TOOLS = [
  {
    name: 'read_records',
    description: 'Read rows from one BRP table as the signed-in person (row-level security applies, so you only see what they may see). ' +
      'HQ tables: hq_tasks, hq_decisions, hq_requests, hq_agent_levels, hq_systems, hq_documents. Business tables: installations, rooms, work_orders, ' +
      'purchase_orders, purchase_list, stock, parts, vendors, agent_proposals, agent_settings, alerts. Filters are exact matches on listed columns. ' +
      'Returns at most 100 rows. Cite the ids you use.',
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: Object.keys(READABLE) },
        filters: { type: 'object', description: 'Column to exact value, for example {"owner":"Andrew","status":"at_risk"}', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['table'],
    },
  },
  {
    name: 'draft_task',
    description: 'Draft a new HQ task. Nothing is saved: Andrew sees the draft with a Save button and decides. Use plain words.',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', enum: ['Andrew', 'Claude', 'Rynoc', 'Attorney', 'CPA'] },
        area: { type: 'string' },
        item: { type: 'string', description: 'What needs doing, under 120 characters' },
        due: { type: 'string', description: 'A label like "Oct 24" or "This week"' },
        sort_date: { type: 'string', description: 'YYYY-MM-DD, when known' },
        next: { type: 'string', description: 'The next concrete step' },
      },
      required: ['owner', 'item'],
    },
  },
  {
    name: 'draft_decision',
    description: 'Draft a decision for Andrew with two to four one-tap options. Nothing is saved until he taps Save.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string', description: 'The facts he needs, with record ids' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
        recommended: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'draft_request',
    description: 'Draft a request to the Claude team for bigger work (writing code, a document, research). Nothing is sent until Andrew taps Send.',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'What to do, what done looks like, where the result goes' } }, required: ['text'] },
  },
];

export function systemPrompt(me, today) {
  return [
    `You are Claude, working inside BRP Command, the portal ${me && me.name ? me.name : 'the owner'} uses to run BRP (Barracks Readiness Program). Today is ${today}.`,
    `You are talking with ${me ? `${me.name} (${me.email}), HQ role ${me.hq_role || 'none'}${me.inst ? ', installation ' + me.inst : ''}` : 'a signed-in person'}.`,
    'Answer from the records. Use read_records before you state a number, a status or a date, and cite the record ids you used. If the records do not show it, say you do not know.',
    'You cannot change anything. To suggest a task, a decision or bigger work for the Claude team, call draft_task, draft_decision or draft_request; the person saves or sends it with one tap.',
    'Never say you sent, logged, booked, ordered, flagged or told anyone anything. Never say what another person, office or system can do or how fast, and never say who decides something unless a record says so. A checker removes sentences like that before the person sees them.',
    'Write plain, short sentences. No em dashes. Money in dollars with cents. Dates like Oct 17. Demo records are sample data; say so when it matters.',
  ].join('\n');
}

/** Turns stored hq_messages rows into Messages API turns: user and assistant only, alternating, starting with user. */
export function historyToMessages(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === r.role) last.content += '\n\n' + r.content;
    else out.push({ role: r.role, content: String(r.content) });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** Validates and runs one read. readTable(table, columns, filters, limit) is given by the caller and runs as the person. */
export async function runRead(input, readTable) {
  const table = String(input && input.table || '');
  if (!READABLE[table]) return { error: `Table ${table} is not readable here.` };
  const cols = READABLE[table].split(',');
  const filters = {};
  for (const [k, v] of Object.entries((input && input.filters) || {})) {
    if (!cols.includes(k)) return { error: `Column ${k} is not readable on ${table}. Readable: ${cols.join(', ')}` };
    if (v === null || typeof v === 'object') return { error: `Filter ${k} must be a string, number or boolean.` };
    filters[k] = v;
  }
  const limit = Math.min(Math.max(parseInt(input && input.limit, 10) || 50, 1), 100);
  const rows = await readTable(table, READABLE[table], filters, limit);
  return { table, count: rows.length, rows };
}

function draftFrom(name, input, n) {
  const id = `DRAFT-${n}`;
  if (name === 'draft_task') {
    const owner = ['Andrew', 'Claude', 'Rynoc', 'Attorney', 'CPA'].includes(input.owner) ? input.owner : 'Andrew';
    const item = String(input.item || '').trim().slice(0, 300);
    if (!item) return { error: 'A task needs an item.' };
    return { draft: { _id: id, kind: 'task', owner, area: String(input.area || ''), item, due: String(input.due || ''),
      sort_date: /^\d{4}-\d{2}-\d{2}$/.test(input.sort_date || '') ? input.sort_date : null, next: String(input.next || '') },
      action: { _id: id, type: 'human_task', role: owner.toLowerCase() } };
  }
  if (name === 'draft_decision') {
    const options = (Array.isArray(input.options) ? input.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
    if (!String(input.question || '').trim() || options.length < 2) return { error: 'A decision needs a question and at least two options.' };
    const rec = Number.isInteger(input.recommended) && input.recommended < options.length ? input.recommended : null;
    return { draft: { _id: id, kind: 'decision', question: String(input.question).trim().slice(0, 500), context: String(input.context || '').slice(0, 4000), options, recommended: rec },
      action: { _id: id, type: 'human_task', role: 'andrew' } };
  }
  if (name === 'draft_request') {
    const text = String(input.text || '').trim();
    if (text.length < 3) return { error: 'A request needs text.' };
    return { draft: { _id: id, kind: 'request', text: text.slice(0, 8000) }, action: { _id: id, type: 'human_task', role: 'andrew' } };
  }
  return { error: `Unknown tool ${name}` };
}

/**
 * Runs one chat turn.
 * @param {object} turn  { me, message, history: hq_messages rows (oldest first), today }
 * @param {object} deps  { callModel(body) -> Messages API response JSON, readTable(table, cols, filters, limit) -> rows[], config: reply checker config, model? }
 * @returns {{ reply, draft_reply, drafts, checked, model, rounds, usage, stop_reason }}
 */
export async function runChat(turn, deps) {
  const model = deps.model || MODEL;
  const messages = historyToMessages([...(turn.history || []), { role: 'user', content: String(turn.message) }]);
  const system = systemPrompt(turn.me, turn.today || new Date().toISOString().slice(0, 10));
  const drafts = [], usage = { input_tokens: 0, output_tokens: 0 };
  let res = null, rounds = 0;
  for (;;) {
    rounds++;
    res = await deps.callModel({ model, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages });
    if (res && res.usage) { usage.input_tokens += res.usage.input_tokens || 0; usage.output_tokens += res.usage.output_tokens || 0; }
    if (!res || res.stop_reason !== 'tool_use' || rounds >= MAX_ROUNDS) break;
    // Send the assistant turn back unchanged (thinking blocks included), then one tool_result per tool_use.
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const b of res.content || []) {
      if (b.type !== 'tool_use') continue;
      let out;
      try {
        if (b.name === 'read_records') out = await runRead(b.input, deps.readTable);
        else {
          const d = draftFrom(b.name, b.input || {}, drafts.length + 1);
          if (d.error) out = { error: d.error };
          else { drafts.push(d.draft); out = { draft_id: d.draft._id, saved: false, note: 'Shown to the person with a Save button. Not saved until they tap it.' }; }
        }
      } catch (e) { out = { error: String((e && e.message) || e).slice(0, 500) }; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), ...(out && out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  const draft = ((res && res.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim() ||
    (drafts.length ? 'Here is a draft for you to look at.' : FALLBACK);
  const checked = checkRules({ draft, conversation: messages.filter((m) => typeof m.content === 'string').map((m) => ({ from: m.role, text: m.content })),
    // Drafts are not done yet, so they back no claim: "I sent" or "I logged" is removed even when a draft exists.
    actions: [] },
    { ...deps.config, fallback_reply: FALLBACK });
  return { reply: checked.reply, draft_reply: draft, drafts, checked: { changed: checked.changed, removed: checked.removed, checked_sentences: checked.checked_sentences },
    model, rounds, usage, stop_reason: res && res.stop_reason };
}

/** The Messages API call. Only index.ts (or a deliberate live check) uses it; the key comes from the function's secrets. */
export function anthropicCaller(apiKey, fetchFn = fetch) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return async (body) => {
    const r = await fetchFn(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Messages API returned ${r.status}`);
    return j;
  };
}

/** The text a Claude Code routine receives for a Command message (it arrives wrapped as untrusted fire text; the routine's
 *  saved prompt tells it to act on it). Each fire starts a NEW routine session, so the text carries everything needed to
 *  answer in the right thread: the request id, the message id and the thread owner. */
export function routineText(req, me, resultUrl) {
  return [
    `BRP Command message ${req.id}${req.message_id ? ' (hq_messages id ' + req.message_id + ')' : ''} from ${me ? me.name + ' (' + me.email + ')' : 'Command'}.`,
    `thread: ${req.thread || 'main'}   thread_owner: ${req.requested_by || (me && me.id) || ''}`,
    '',
    String(req.text),
    '',
    'Reply in the thread: insert into public.hq_messages (thread, thread_owner, role, author, content) values',
    `  ('${req.thread || 'main'}', '${req.requested_by || (me && me.id) || ''}', 'assistant', 'Claude', '<your reply>');`,
    `Then set public.hq_requests status to 'working' or 'done' (with result and links) for id ${req.id}.`,
    `Or POST {"id":"${req.id}","status":"working"|"done","result":"...","links":[{"title":"...","url":"https://..."}]} to ${resultUrl} with header x-hq-result-token from HQ_RESULT_TOKEN.`,
  ].join('\n');
}

/** Starts the routine. Returns { ok, session_url?, note }. fetchFn is injectable for tests. */
export async function fireRoutine({ url, token, text }, fetchFn = fetch) {
  if (!url || !token) return { ok: false, note: 'No Claude Code routine is connected yet. The request waits in HQ.' };
  if (!/^https:\/\//.test(url)) return { ok: false, note: 'CLAUDE_ROUTINE_FIRE_URL must start with https://' };
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, note: `The routine did not start (HTTP ${r.status}${j.error && j.error.message ? ': ' + j.error.message : ''}). The request waits in HQ.` };
    return { ok: true, session_url: j.claude_code_session_url || null, session_id: j.claude_code_session_id || null, note: 'Routine started.' };
  } catch (e) {
    return { ok: false, note: 'The routine did not start (' + String((e && e.message) || e).slice(0, 200) + '). The request waits in HQ.' };
  }
}
