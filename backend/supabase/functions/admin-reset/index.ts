// BRP admin-reset: one-click "reset demo data".
//
// POST /functions/v1/admin-reset   Authorization: Bearer <an Admin's access token>
// 1. Calls public.admin_reset_demo() as the caller. The database refuses anyone who is not an active Admin,
//    and refuses everyone once settings.demo_mode.enabled is false.
// 2. With the service role, puts the nine @brp.demo accounts back on the published demo password, so a changed
//    demo password cannot lock the next presenter out. No other account is touched.
import { cors, json, userClient, serviceClient } from '../_shared/util.ts';

const DEMO_PASSWORD = Deno.env.get('BRP_DEMO_PASSWORD') ?? 'BRPdemo2026!';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!req.headers.get('Authorization')) return json({ error: 'Sign in first' }, 401);

  const { data: counts, error } = await userClient(req).rpc('admin_reset_demo');
  if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);

  const svc = serviceClient();
  const { data: demo } = await svc.from('profiles').select('id, email').eq('demo', true);
  let passwords = 0;
  for (const p of demo ?? []) {
    if (!String(p.email).endsWith('@brp.demo')) continue;
    const { error: e } = await svc.auth.admin.updateUserById(p.id, { password: DEMO_PASSWORD });
    if (!e) passwords++;
  }
  return json({ ok: true, counts, demo_passwords_reset: passwords });
});
