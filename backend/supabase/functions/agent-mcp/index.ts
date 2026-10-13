// BRP agent-mcp: the MCP server Claude Managed Agents connect to (streamable HTTP, JSON responses).
//
// URL:   https://<ref>.supabase.co/functions/v1/agent-mcp/<agent>     agent = buyer_dispatch | sensor_watch | ...
// Auth:  Authorization: Bearer <that agent's token>. The token lives in an Anthropic vault (static_bearer credential
//        keyed by this URL) and is injected by Anthropic at session time. This function stores only SHA-256 hashes:
//          supabase secrets set BRP_AGENT_TOKEN_SHA256='{"buyer_dispatch":"<hex>", ...}'
//        A token works only for its own agent's URL, so one agent cannot act as another.
// DB:    SUPABASE_DB_URL (provided to Edge Functions by Supabase). Each tool call is one transaction that first runs
//        `set local role brp_agent` and sets the agent claim, then calls one fixed SQL function (see mcp.ts).
// Deploy with JWT verification off for this function only (the bearer token is not a Supabase JWT):
//        npx -y supabase@2.118.0 functions deploy agent-mcp --no-verify-jwt   (config.toml also says verify_jwt = false)
// Kill switches: settings in public.agent_settings (mode off), BRP_AGENTS_DISABLED=1 (refuses every call), or
// removing the agent's hash from BRP_AGENT_TOKEN_SHA256.
import postgres from 'npm:postgres@3.4.5';
import { AGENTS, handleBody, sameHex, type Exec } from './mcp.ts';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';
const sql = DB_URL ? postgres(DB_URL, { prepare: false, max: 3, idle_timeout: 20 }) : null;

function hashes(): Record<string, string> {
  try { return JSON.parse(Deno.env.get('BRP_AGENT_TOKEN_SHA256') ?? '{}'); } catch { return {}; }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function reply(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  if (Deno.env.get('BRP_AGENTS_DISABLED') === '1') return reply({ error: 'BRP agents are switched off on this server' }, 503);
  const agent = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  if (!AGENTS.includes(agent)) return reply({ error: 'Unknown agent' }, 404);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const want = hashes()[agent];
  if (!token || !want || !sameHex(await sha256Hex(token), String(want).toLowerCase())) return reply({ error: 'Unauthorized' }, 401);

  if (req.method === 'GET') return reply({ error: 'No server-sent stream. POST JSON-RPC messages.' }, 405);
  if (req.method === 'DELETE') return reply(null, 204);
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!sql) return reply({ error: 'SUPABASE_DB_URL is not set' }, 500);

  let body: unknown;
  try { body = await req.json(); } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const exec: Exec = (text, params) => sql.begin(async (tx) => {
    await tx.unsafe('set local role brp_agent');
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ brp_agent: agent })}, true)`;
    const rows = await tx.unsafe(text, params as (string | null)[]);
    return rows[0]?.r;
  });

  const out = await handleBody(body, { agent, exec });
  return out === null ? reply(null, 202) : reply(out);
});
