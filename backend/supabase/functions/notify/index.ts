// BRP notify: raise an alert, fan it out, and deliver it.
//
// POST /functions/v1/notify   Authorization: Bearer <the signed-in user's access token>
// Body: the BRP One alert shape (HOST-API.md 4.0):
//   { title, body, tags:[{ role, name, email }], severity:'critical'|'high'|'info', ref:'wo:WO-24366', type?, inst? }
//
// 1. Calls public.raise_alert as the caller (row-level security applies). The database stores the alert, adds the
//    default people, and writes one email_outbox row per tagged person with status 'logged'.
// 2. Email: OFF by default. Mail is sent only when BOTH switches are on:
//      - the EMAIL_PROVIDER secret is 'resend' or 'postmark' (with its key), and
//      - settings.email_delivery.enabled is true in the database (an Admin who is not a demo account can set it).
//    Addresses at EMAIL_BLOCK_DOMAINS (default brp.demo, example.com, example.org) are never mailed; their rows become 'suppressed'.
//    With either switch off, the rows stay 'logged' and nothing leaves the server. The demo runs this way.
// 3. Push: sent to the tagged people's registered devices when APNs and/or FCM secrets are set; otherwise skipped.
import { cors, json, userClient, serviceClient, signJwt } from '../_shared/util.ts';

type Recipient = { email: string; name: string | null; role: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!req.headers.get('Authorization')) return json({ error: 'Sign in first' }, 401);

  let alert: Record<string, unknown>;
  try { alert = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }

  const user = userClient(req);
  const { data: raised, error } = await user.rpc('raise_alert', { p_alert: alert });
  if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);

  const svc = serviceClient();
  const alertRow = raised.alert as { id: string; title: string; body: string; ref: string | null; severity: string; tagged: Recipient[] };
  const outboxIds = (raised.outbox ?? []) as number[];

  const email = await deliverEmail(svc, outboxIds);
  const push = await deliverPush(svc, alertRow);

  return json({ alert: alertRow, email, push });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
async function deliverEmail(svc: ReturnType<typeof serviceClient>, ids: number[]) {
  const provider = (Deno.env.get('EMAIL_PROVIDER') ?? 'off').toLowerCase();
  const { data: setting } = await svc.from('settings').select('value').eq('key', 'email_delivery').maybeSingle();
  const enabled = provider !== 'off' && setting?.value?.enabled === true;
  if (!enabled || ids.length === 0) {
    return { mode: 'outbox_only', provider, sent: 0, logged: ids.length, note: 'Email delivery is off. Rows are in the outbox only.' };
  }
  const from = Deno.env.get('EMAIL_FROM') ?? '';
  const block = (Deno.env.get('EMAIL_BLOCK_DOMAINS') ?? 'brp.demo,example.com,example.org').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const { data: rows } = await svc.from('email_outbox').select('*').in('id', ids).eq('status', 'logged');
  let sent = 0, failed = 0, suppressed = 0;
  for (const row of rows ?? []) {
    const domain = String(row.to_email).split('@')[1]?.toLowerCase() ?? '';
    if (block.includes(domain)) {
      await svc.from('email_outbox').update({ status: 'suppressed', provider, error: 'Blocked domain ' + domain }).eq('id', row.id);
      suppressed++; continue;
    }
    try {
      const messageId = await sendOne(provider, from, row.to_email, row.subject, row.body);
      await svc.from('email_outbox').update({ status: 'sent', provider, provider_message_id: messageId, sent_at: new Date().toISOString(), error: null }).eq('id', row.id);
      sent++;
    } catch (e) {
      await svc.from('email_outbox').update({ status: 'failed', provider, error: String((e as Error).message ?? e).slice(0, 500) }).eq('id', row.id);
      failed++;
    }
  }
  return { mode: 'send', provider, sent, failed, suppressed };
}

async function sendOne(provider: string, from: string, to: string, subject: string, text: string): Promise<string> {
  if (!from) throw new Error('EMAIL_FROM is not set');
  if (provider === 'resend') {
    const key = Deno.env.get('RESEND_API_KEY'); if (!key) throw new Error('RESEND_API_KEY is not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (j.message ?? ''));
    return j.id ?? '';
  }
  if (provider === 'postmark') {
    const key = Deno.env.get('POSTMARK_SERVER_TOKEN'); if (!key) throw new Error('POSTMARK_SERVER_TOKEN is not set');
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST', headers: { 'X-Postmark-Server-Token': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Postmark ' + r.status + ': ' + (j.Message ?? ''));
    return j.MessageID ?? '';
  }
  throw new Error('Unknown EMAIL_PROVIDER ' + provider);
}

// ---------------------------------------------------------------------------
// Push (APNs for iOS, FCM HTTP v1 for Android)
// ---------------------------------------------------------------------------
async function deliverPush(svc: ReturnType<typeof serviceClient>, alert: { id: string; title: string; body: string; ref: string | null; severity: string }) {
  const apnsReady = !!(Deno.env.get('APNS_KEY_P8') && Deno.env.get('APNS_KEY_ID') && Deno.env.get('APNS_TEAM_ID') && Deno.env.get('APNS_BUNDLE_ID'));
  const fcmReady = !!Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');

  const { data: recips } = await svc.from('alert_recipients').select('id, profile_id').eq('alert_id', alert.id);
  const pids = (recips ?? []).map((r) => r.profile_id).filter(Boolean) as string[];
  const { data: prefs } = pids.length ? await svc.from('profiles').select('id, push_alerts').in('id', pids) : { data: [] };
  const pushOn = new Map((prefs ?? []).map((p) => [p.id as string, p.push_alerts !== false]));
  const list = (recips ?? []).map((r) => ({ id: r.id as number, profile_id: r.profile_id as string | null,
    profiles: r.profile_id ? { push_alerts: pushOn.get(r.profile_id) ?? true } : null }));
  if (!apnsReady && !fcmReady) {
    await svc.from('alert_recipients').update({ push_status: 'not_configured' }).eq('alert_id', alert.id);
    return { mode: 'not_configured', sent: 0 };
  }
  const ids = list.filter((r) => r.profile_id && r.profiles?.push_alerts !== false).map((r) => r.profile_id as string);
  const { data: tokens } = ids.length
    ? await svc.from('push_tokens').select('*').in('profile_id', ids).is('disabled_at', null)
    : { data: [] };

  const msg = { title: alert.title, body: (alert.body ?? '').slice(0, 180), data: { alert_id: alert.id, ref: alert.ref ?? '', severity: alert.severity } };
  const okBy = new Map<string, boolean>();
  let sent = 0, failed = 0;
  let fcmToken: string | null = null;
  for (const t of tokens ?? []) {
    try {
      if (t.platform === 'ios' && apnsReady) await sendApns(t.token, t.environment, msg);
      else if (t.platform === 'android' && fcmReady) { fcmToken ??= await fcmAccessToken(); await sendFcm(fcmToken, t.token, msg); }
      else continue;
      sent++; okBy.set(t.profile_id, true);
      await svc.from('push_tokens').update({ last_error: null }).eq('id', t.id);
    } catch (e) {
      failed++; if (!okBy.has(t.profile_id)) okBy.set(t.profile_id, false);
      const m = String((e as Error).message ?? e);
      const dead = /Unregistered|BadDeviceToken|UNREGISTERED|NOT_FOUND|410/.test(m);
      await svc.from('push_tokens').update({ last_error: m.slice(0, 300), disabled_at: dead ? new Date().toISOString() : null }).eq('id', t.id);
    }
  }
  for (const r of list) {
    const status = !r.profile_id || r.profiles?.push_alerts === false ? 'off' : okBy.has(r.profile_id) ? (okBy.get(r.profile_id) ? 'sent' : 'failed') : 'no_token';
    await svc.from('alert_recipients').update({ push_status: status }).eq('id', r.id);
  }
  return { mode: 'send', apns: apnsReady, fcm: fcmReady, sent, failed };
}

let apnsJwt: { token: string; at: number } | null = null;
async function sendApns(deviceToken: string, environment: string, msg: { title: string; body: string; data: Record<string, string> }) {
  const now = Math.floor(Date.now() / 1000);
  if (!apnsJwt || now - apnsJwt.at > 40 * 60) {   // Apple accepts a provider token for up to an hour
    const token = await signJwt({ alg: 'ES256', kid: Deno.env.get('APNS_KEY_ID') }, { iss: Deno.env.get('APNS_TEAM_ID'), iat: now }, Deno.env.get('APNS_KEY_P8')!, 'ES256');
    apnsJwt = { token, at: now };
  }
  const host = environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const r = await fetch(host + '/3/device/' + deviceToken, {
    method: 'POST',
    headers: { authorization: 'bearer ' + apnsJwt.token, 'apns-topic': Deno.env.get('APNS_BUNDLE_ID')!, 'apns-push-type': 'alert', 'apns-priority': '10' },
    body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, ...msg.data }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('APNs ' + r.status + ' ' + (j.reason ?? '')); }
}

async function fcmAccessToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')!);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }, sa.private_key, 'RS256');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('FCM auth ' + r.status + ' ' + (j.error_description ?? ''));
  return j.access_token;
}

async function sendFcm(accessToken: string, deviceToken: string, msg: { title: string; body: string; data: Record<string, string> }) {
  const sa = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')!);
  const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, notification: { title: msg.title, body: msg.body }, data: msg.data, android: { priority: 'high' } } }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('FCM ' + r.status + ' ' + (j.error?.status ?? '')); }
}
