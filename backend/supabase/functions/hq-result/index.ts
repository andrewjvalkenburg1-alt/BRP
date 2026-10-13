// BRP Command: a Claude Code routine reports progress or the result of an HQ request.
//
// POST /functions/v1/hq-result   x-hq-result-token: <HQ_RESULT_TOKEN>   (verify_jwt = false; the token is checked here)
//   { "id": "RQ-0001", "status": "working" | "done", "result": "plain words", "links": [{ "title": "...", "url": "https://..." }] }
// Writes the request row with the service role and adds a system message to the requester's chat thread.
// HQ_RESULT_TOKEN is a long random string set in two places only: this function's secrets and the routine's environment.
import { cors, json, serviceClient } from '../_shared/util.ts';

function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const want = Deno.env.get('HQ_RESULT_TOKEN') ?? '';
  if (want.length < 32) return json({ error: 'HQ_RESULT_TOKEN is not set (32 characters or more)' }, 503);
  if (!same(req.headers.get('x-hq-result-token') ?? '', want)) return json({ error: 'Wrong token' }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }
  const id = String(b.id ?? '');
  const status = String(b.status ?? '');
  if (!/^RQ-\d{4,}$/.test(id)) return json({ error: 'id must look like RQ-0001' }, 400);
  if (!['working', 'done'].includes(status)) return json({ error: 'status must be working or done' }, 400);
  const links = (Array.isArray(b.links) ? b.links : []).slice(0, 20)
    .map((l: { title?: unknown; url?: unknown }) => ({ title: String(l?.title ?? '').slice(0, 200), url: String(l?.url ?? '') }))
    .filter((l) => /^https:\/\//.test(l.url));
  const result = b.result == null ? null : String(b.result).slice(0, 20000);

  const svc = serviceClient();
  const { data: rq, error } = await svc.from('hq_requests').update({ status, result, links }).eq('id', id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!rq) return json({ error: 'No request ' + id }, 404);
  if (rq.requested_by) {
    await svc.from('hq_messages').insert({
      thread: rq.thread || 'main', thread_owner: rq.requested_by, role: 'system', author: 'Claude team', author_id: null, sample: rq.sample,
      content: status === 'done' ? `Claude team finished ${id}.${result ? ' ' + result : ''}` : `Claude team started ${id}.`,
    });
  }
  return json({ ok: true, request: rq });
});
