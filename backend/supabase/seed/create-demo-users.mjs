#!/usr/bin/env node
/* Fallback: create the nine BRP demo accounts through the Supabase Auth Admin API.
   Only needed if seed.sql warned that it could not write auth.users. Run seed.sql again afterwards so the
   sample work orders link to the demo technician and Soldier.
   Usage (keys stay in your shell, never in a file in this repo):
     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> node supabase/seed/create-demo-users.mjs */
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.'); process.exit(1); }
const PASSWORD = 'BRPdemo2026!';
const ACCOUNTS = [
  ['soldier@brp.demo', 'SGT J. Parker', 'soldier', 'STW', '412', '1K'], ['tech@brp.demo', 'D. Reyes', 'technician', 'STW'],
  ['manager@brp.demo', 'D. Hargrove', 'barracks_manager', 'STW'], ['sitelead@brp.demo', 'R. Okafor', 'site_lead', 'STW'],
  ['pm@brp.demo', 'M. Brennan', 'program_manager'], ['buyer@brp.demo', 'K. Lindqvist', 'buyer'], ['cor@brp.demo', 'L. Whitfield', 'cor'],
  ['commander@brp.demo', 'COL A. Grant', 'commander'], ['admin@brp.demo', 'BRP admin', 'admin']
];
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
for (const [email, full_name, role, inst, bldg, room] of ACCOUNTS) {
  const r = await fetch(URL_ + '/auth/v1/admin/users', {
    method: 'POST', headers: H,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name },
      app_metadata: { brp_role: role, brp_inst: inst || null, brp_home_bldg: bldg || null, brp_home_room: room || null, brp_active: true, brp_demo: true } })
  });
  const j = await r.json().catch(() => ({}));
  console.log(email, r.ok ? 'created' : 'skipped: ' + (j.msg || j.message || r.status));
}
