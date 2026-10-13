// BRP Command: "Claude (BRP Command thread)". The default route is send_request (the thread); chat is the optional Quick answer.
//
// POST /functions/v1/hq-chat   Authorization: Bearer <the signed-in person's access token>   (verify_jwt = true)
//   { "action": "chat", "thread": "main", "message": "..." }
//       -> { reply, drafts, checked, message_id, user_message_id }
//   { "action": "send_request", "id": "RQ-0001" }      (the row was inserted by the browser, under row-level security)
//       -> { request }   status 'working' when a Claude Code routine was started, else still 'queued' with a note
//
// Secrets (Supabase > Edge Functions > Secrets; never in the repo):
//   ANTHROPIC_API_KEY        required for chat. Billing is the Anthropic Console account that owns the key.
//   HQ_CHAT_MODEL            optional, default claude-opus-5-5.
//   CLAUDE_ROUTINE_FIRE_URL  optional: https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire
//   CLAUDE_ROUTINE_TOKEN     optional: the routine's bearer token (shown once when the API trigger is made).
// Every read the model asks for runs with the CALLER's token, so row-level security limits it to what they may see.
// Claude's replies pass the reply checker rules before they are stored or shown.
import { cors, json, userClient, serviceClient } from '../_shared/util.ts';
import CONFIG from '../_shared/reply-checker.config.json' with { type: 'json' };
import { runChat, anthropicCaller, fireRoutine, routineText, HISTORY, MODEL } from './core.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!req.headers.get('Authorization')) return json({ error: 'Sign in first' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }

  const user = userClient(req);
  const { data: me, error: meErr } = await user.rpc('hq_whoami');
  if (meErr || !me || !me.active) return json({ error: 'Sign in first' }, 401);
  if (!me.hq_role) return json({ error: 'HQ is for the owner, the partner and site leads.' }, 403);
  const svc = serviceClient();

  if (body.action === 'send_request') {
    const { data: rq, error } = await user.from('hq_requests').select('*').eq('id', String(body.id || '')).maybeSingle();
    if (error || !rq) return json({ error: 'No request ' + body.id + ' that you can see' }, 404);
    if (rq.status !== 'queued') return json({ request: rq });
    const resultUrl = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/hq-result';
    const fired = await fireRoutine({ url: Deno.env.get('CLAUDE_ROUTINE_FIRE_URL') ?? '', token: Deno.env.get('CLAUDE_ROUTINE_TOKEN') ?? '', text: routineText(rq, me, resultUrl) });
    const patch = fired.ok ? { status: 'working', routine_session_url: fired.session_url, fire_note: fired.note } : { fire_note: fired.note };
    const { data: saved } = await svc.from('hq_requests').update(patch).eq('id', rq.id).select().single();
    return json({ request: saved ?? rq, fired: fired.ok });
  }

  if (body.action !== 'chat') return json({ error: 'action must be chat or send_request' }, 400);
  const message = String(body.message ?? '').trim();
  const thread = /^[A-Za-z0-9_-]{1,60}$/.test(String(body.thread ?? 'main')) ? String(body.thread ?? 'main') : 'main';
  if (!message) return json({ error: 'Type a message' }, 400);
  if (message.length > 4000) return json({ error: 'Keep a message under 4,000 characters' }, 400);
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!key) return json({ error: 'Claude is not connected yet: ANTHROPIC_API_KEY is not set on the server.' }, 503);

  // History first (as the caller), then the new message (as the caller, so row-level security checks it).
  const { data: hist } = await user.from('hq_messages').select('role, content, created_at').eq('thread_owner', me.id).eq('thread', thread)
    .order('created_at', { ascending: false }).limit(HISTORY);
  const { data: um, error: umErr } = await user.from('hq_messages').insert({ thread, role: 'user', content: message }).select('id').single();
  if (umErr) return json({ error: umErr.message }, 403);

  const readTable = async (table: string, cols: string, filters: Record<string, unknown>, limit: number) => {
    let q = user.from(table).select(cols);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v as string);
    const { data, error } = await q.limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  let out;
  try {
    out = await runChat({ me, message, history: (hist ?? []).reverse(), today: new Date().toISOString().slice(0, 10) },
      { callModel: anthropicCaller(key), readTable, config: CONFIG, model: Deno.env.get('HQ_CHAT_MODEL') || MODEL });
  } catch (e) {
    return json({ error: 'Claude did not answer: ' + String((e as Error).message ?? e).slice(0, 300), user_message_id: um.id }, 502);
  }
  const { data: am, error: amErr } = await svc.from('hq_messages').insert({
    thread, thread_owner: me.id, role: 'assistant', content: out.reply, author: 'Claude', author_id: null,
    checked: out.checked, drafts: out.drafts, model: out.model, sample: !!me.demo,
  }).select('id').single();
  if (amErr) return json({ error: amErr.message }, 500);
  return json({ reply: out.reply, drafts: out.drafts, checked: out.checked, message_id: am.id, user_message_id: um.id });
});
