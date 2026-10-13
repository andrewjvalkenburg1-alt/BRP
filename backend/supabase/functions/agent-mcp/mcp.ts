// BRP agent MCP server: the protocol and tool layer. No Deno or Node APIs here, so the same file runs in the Supabase
// Edge Function (index.ts) and in the local Node test (backend/agents/test/mcp-test.mjs).
//
// Tools (the only things a BRP agent can do):
//   brp_begin_run     start a run, get run_id, your installations and modes, readable tables, proposal kinds
//   brp_read          read rows from an allowed table (read-only; Soldier and account columns are never readable)
//   brp_spend_status  Buyer only: the money rule for an installation and an order total
//   brp_propose       write a proposal with rationale and cited record ids (the only write)
//   brp_end_run       log the end of the run with a short summary
// Every call runs in its own transaction as the Postgres role brp_agent with the agent's name in the request claims.
// The database decides what the agent may see and refuses every write except agent_runs and agent_proposals.

export type Exec = (sql: string, params: (string | null)[]) => Promise<unknown>;
export type Ctx = { agent: string; exec: Exec };
type Json = Record<string, unknown>;

export const SERVER_INFO = { name: 'brp-agent-mcp', version: '1.0.0' };
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const AGENTS = ['buyer_dispatch', 'sensor_watch', 'inspection_scheduler', 'room_readiness', 'soldier_liaison'];

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const js = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  agents?: string[];
  sql: string;
  params: (a: Json) => (string | null)[];
};

export const TOOLS: Tool[] = [
  {
    name: 'brp_begin_run',
    description: 'Call first, once per run. Returns run_id, server_time, the installations you are switched on for and your mode there (shadow means propose only), the tables and columns you may read, the proposal kinds you may write, and (Buyer) the money rule.',
    inputSchema: { type: 'object', properties: { session_ref: { type: 'string', description: 'Your Managed Agents session id, if you know it.' }, model: { type: 'string' } }, additionalProperties: false },
    sql: 'select public.agent_begin_run($1::text, $2::text) as r',
    params: (a) => [str(a.session_ref), str(a.model)],
  },
  {
    name: 'brp_read',
    description: 'Read rows from one BRP table. filter: {"col": value} equals, {"col": [v1, v2]} any of, {"col": {"gte": x, "lte": y, "gt": x, "lt": y, "ilike": "%text%", "is_null": true}}. limit 1 to 500 (default 100). order: a readable column; desc: true for newest first. Read-only.',
    inputSchema: {
      type: 'object', required: ['table'], additionalProperties: false,
      properties: {
        table: { type: 'string', enum: ['installations', 'buildings', 'rooms', 'work_orders', 'wo_events', 'vendors', 'catalog_items', 'parts', 'cabinets', 'stock', 'purchase_orders', 'po_lines', 'purchase_list', 'agent_proposals'] },
        filter: { type: 'object' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, order: { type: 'string' }, desc: { type: 'boolean' },
      },
    },
    sql: 'select public.agent_read($1::text, coalesce($2::jsonb, \'{}\'::jsonb), $3::int, $4::text, coalesce($5::boolean, false)) as r',
    params: (a) => [str(a.table), js(a.filter), str(a.limit), str(a.order), str(a.desc)],
  },
  {
    name: 'brp_spend_status',
    description: 'Money rule check for one installation: per-order limit, this week\'s spend, the weekly cap in force and how it was set, and whether an order of `amount` (full total including shipping) needs approval and from whom. Check before every purchase proposal.',
    inputSchema: { type: 'object', required: ['installation', 'amount'], additionalProperties: false, properties: { installation: { type: 'string' }, amount: { type: 'number', exclusiveMinimum: 0 } } },
    agents: ['buyer_dispatch'],
    sql: 'select public.buyer_spend_check($1::text, $2::numeric) as r',
    params: (a) => [str(a.installation), str(a.amount)],
  },
  {
    name: 'brp_propose',
    description: 'Write one proposal. This is your only write and it executes nothing: a person approves or rejects it. cited_ids: the BRP record ids your proposal rests on (work orders, rooms, POs, parts, vendors, installations...); ids that do not exist are refused. For kind purchase_order, payload must include total (USD, including shipping), vendor_id and lines [{sku, qty, unit_cost}]; the server adds the money check and routes over-limit orders to the site lead or program manager.',
    inputSchema: {
      type: 'object', required: ['installation', 'kind', 'payload', 'rationale', 'cited_ids', 'run_id'], additionalProperties: false,
      properties: {
        installation: { type: 'string' }, kind: { type: 'string' }, payload: { type: 'object' },
        rationale: { type: 'string', minLength: 10, maxLength: 4000, description: 'Why, in plain words, with the facts and their record ids. Label your own arithmetic.' },
        cited_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, run_id: { type: 'string' },
      },
    },
    sql: 'select public.agent_propose($1::text, $2::text, $3::jsonb, $4::text, array(select jsonb_array_elements_text($5::jsonb)), $6::uuid) as r',
    params: (a) => [str(a.installation), str(a.kind), js(a.payload ?? {}), str(a.rationale), js(a.cited_ids ?? []), str(a.run_id)],
  },
  {
    name: 'brp_end_run',
    description: 'Call last. Logs the end of the run: ok false if you could not finish, and a short summary (what you reviewed, what you proposed, what you could not check).',
    inputSchema: { type: 'object', required: ['run_id', 'summary'], additionalProperties: false, properties: { run_id: { type: 'string' }, ok: { type: 'boolean' }, summary: { type: 'string', maxLength: 4000 }, counts: { type: 'object' } } },
    sql: 'select public.agent_end_run($1::uuid, coalesce($2::boolean, true), $3::text, coalesce($4::jsonb, \'{}\'::jsonb)) as r',
    params: (a) => [str(a.run_id), str(a.ok), str(a.summary), js(a.counts)],
  },
];

export function toolsFor(agent: string): Tool[] {
  return TOOLS.filter((t) => !t.agents || t.agents.includes(agent));
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC message. Returns null for notifications (no response body). */
export async function handleMessage(msg: Json, ctx: Ctx): Promise<Json | null> {
  const id = msg.id;
  const method = String(msg.method ?? '');
  if (msg.jsonrpc !== '2.0' || !method) return rpcError(id, -32600, 'Invalid request');
  if (id === undefined || id === null) return null; // notifications/initialized and friends need no answer

  if (method === 'initialize') {
    const asked = String((msg.params as Json | undefined)?.protocolVersion ?? '');
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `BRP operations data for agent ${ctx.agent}. SHADOW MODE: read, then propose with cited record ids. Nothing you do here changes an operations record.`,
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: toolsFor(ctx.agent).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
  }
  if (method === 'tools/call') {
    const p = (msg.params ?? {}) as Json;
    const tool = toolsFor(ctx.agent).find((t) => t.name === p.name);
    if (!tool) return rpcError(id, -32602, `Unknown tool ${String(p.name)}`);
    const args = (p.arguments ?? {}) as Json;
    if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
    try {
      const out = await ctx.exec(tool.sql, tool.params(args));
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: { result: out }, isError: false } };
    } catch (e) {
      // Database refusals (permission, unknown id, over the money rule) go back to the agent as a tool error it can read.
      const m = e instanceof Error ? e.message : String(e);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Refused: ${m}` }], isError: true } };
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle a POST body: one message or a batch. Returns the response body, or null when only notifications came in. */
export async function handleBody(body: unknown, ctx: Ctx): Promise<unknown> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m as Json, ctx)))).filter((x) => x !== null);
    return out.length ? out : null;
  }
  if (!body || typeof body !== 'object') return rpcError(null, -32700, 'Parse error');
  return handleMessage(body as Json, ctx);
}

/** Constant-time compare of two hex strings. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
