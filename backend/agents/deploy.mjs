#!/usr/bin/env node
// Deploys the BRP operations agents to Claude Managed Agents (beta) as scheduled, shadow-mode deployments.
// Creates or updates, by name and metadata, so it is safe to run again:
//   1. one cloud environment   "brp-agents-shadow"  (limited networking; MCP servers only, no other hosts)
//   2. one vault               "BRP agents"         (one static_bearer credential per agent, keyed by its MCP URL)
//   3. one agent per enabled definition (backend/agents/<agent>.json), with the brp MCP server
//   4. one scheduled deployment per agent (cron + America/Chicago, a budget on every run)
// The disabled soldier_liaison definition is never deployed.
//
// Usage
//   node backend/agents/deploy.mjs --dry-run            print every request; no network, no key needed
//   node backend/agents/deploy.mjs                      deploy (needs the env below)
//   node backend/agents/deploy.mjs --only sensor_watch  limit to some agents (comma list)
//   node backend/agents/deploy.mjs pause <agent>        stop an agent's schedule (also: unpause, run)
//   node backend/agents/deploy.mjs status               list the BRP deployments and their next runs
//   node backend/agents/deploy.mjs token-hashes         print the Supabase secret command (hashes only) for the MCP tokens
//
// Environment (never commit these; keep them in a shell, a .env outside git, or your CI secret store)
//   ANTHROPIC_API_KEY             Anthropic Console API key (sent only to api.anthropic.com, never printed)
//   SUPABASE_URL                  https://<ref>.supabase.co  (the MCP server is <SUPABASE_URL>/functions/v1/agent-mcp/<agent>)
//   BRP_AGENT_TOKEN_<AGENT>       one random token per agent, e.g. BRP_AGENT_TOKEN_SENSOR_WATCH (openssl rand -hex 32).
//                                 Stored in the Anthropic vault; Supabase keeps only its SHA-256 (see token-hashes).
//   ANTHROPIC_BASE_URL            optional, default https://api.anthropic.com
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const ONLY = onlyArg ? onlyArg.split(',').map((s) => s.trim()) : null;
const cmd = argv.find((a) => !a.startsWith('--') && a !== onlyArg) || 'deploy';
const cmdArg = argv[argv.indexOf(cmd) + 1];

const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const BETA = 'managed-agents-2026-04-01';
const ENV_NAME = 'brp-agents-shadow';
const VAULT_NAME = 'BRP agents';
const KEY = process.env.ANTHROPIC_API_KEY || '';
let SUPA = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

function die(m) { console.error('deploy: ' + m); process.exit(1); }
if (!DRY && ['deploy', 'pause', 'unpause', 'run', 'status'].includes(cmd)) {
  if (!KEY) die('ANTHROPIC_API_KEY is not set. Put it in your shell or secret store, never in this repo.');
  if (/^sk-ant-admin/.test(KEY)) die('That looks like an Admin API key. Use a normal API key from the Console.');
}
if (cmd === 'deploy' || cmd === 'token-hashes') {
  if (!SUPA) { if (DRY) SUPA = 'https://<project-ref>.supabase.co'; else die('SUPABASE_URL is not set (https://<ref>.supabase.co).'); }
  if (!DRY && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPA)) die('SUPABASE_URL must look like https://<ref>.supabase.co');
}

const defs = readdirSync(HERE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(HERE, f), 'utf8')))
  .filter((d) => d.key && d.system).sort((a, b) => a.key.localeCompare(b.key));
const tokenVar = (key) => 'BRP_AGENT_TOKEN_' + key.toUpperCase();
const mcpUrl = (d) => d.mcp_server.url.replace('${SUPABASE_URL}', SUPA);

// ---------------------------------------------------------------- HTTP (dry run prints, never sends)
let step = 0, fakeN = 0;
const redact = (body) => JSON.parse(JSON.stringify(body ?? null, (k, v) => (k === 'token' ? '<redacted: from env ' + v.env + '>' : v)));
async function api(method, path, body, label) {
  const url = BASE + path + (path.includes('?') ? '&' : '?') + 'beta=true';
  if (DRY) {
    step++;
    console.log(`\n--- [${step}] ${label}\n${method} ${url}`);
    console.log('x-api-key: <redacted: $ANTHROPIC_API_KEY>\nanthropic-version: 2023-06-01\nanthropic-beta: ' + BETA + (body ? '\ncontent-type: application/json' : ''));
    if (body) console.log(JSON.stringify(redact(body), (k, v) => (k === 'system' && typeof v === 'string' ? `<${v.length} chars from the agent definition; first line: ${v.split('\n')[0].slice(0, 90)}...>` : v), 2));
    if (method === 'GET') return { data: [] };
    fakeN++;
    return { id: `<${label.split(' ')[0].toLowerCase()}_id_${fakeN}>`, version: 1, schedule: body && body.schedule ? { ...body.schedule, upcoming_runs_at: ['(returned by the API)'] } : undefined };
  }
  const real = body ? JSON.parse(JSON.stringify(body, (k, v) => (k === 'token' ? process.env[v.env] : v))) : undefined;
  const r = await fetch(url, { method, headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'content-type': 'application/json' }, body: real ? JSON.stringify(real) : undefined });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${(j.error && j.error.message) || text.slice(0, 300)}`);
  return j;
}
async function listAll(path) {
  const out = []; let page = null;
  for (let i = 0; i < 20; i++) {
    const j = await api('GET', path + (path.includes('?') ? '&' : '?') + 'limit=100' + (page ? '&page=' + encodeURIComponent(page) : ''), null, 'List ' + path);
    out.push(...(j.data || []));
    if (!j.next_page || DRY) break; page = j.next_page;
  }
  return out;
}

// ---------------------------------------------------------------- request bodies
function agentBody(d) {
  return {
    name: d.name,
    description: d.description,
    model: d.model,
    system: d.system,
    mcp_servers: [{ type: 'url', name: d.mcp_server.name, url: mcpUrl(d) }],
    tools: d.tools,
    metadata: d.metadata,
  };
}
function deploymentBody(d, agent, envId, vaultId) {
  return {
    name: d.name,
    description: `${d.description} Schedule: ${d.schedule_text}`,
    agent: { type: 'agent', id: agent.id, version: agent.version },
    environment_id: envId,
    vault_ids: [vaultId],
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: d.initial_message }] }],
    schedule: d.schedule,
    budget: d.budget,
    metadata: d.metadata,
  };
}

// ---------------------------------------------------------------- commands
async function deploy() {
  const todo = defs.filter((d) => (!ONLY || ONLY.includes(d.key)));
  const skipped = todo.filter((d) => !d.enabled || !d.schedule);
  const live = todo.filter((d) => d.enabled && d.schedule);
  for (const d of skipped) console.log(`skip ${d.key}: disabled (readiness L${d.readiness.level}). Never deployed by this script.`);
  if (!live.length) return;
  for (const d of live) if (!DRY && !process.env[tokenVar(d.key)]) die(`${tokenVar(d.key)} is not set. Generate one with: openssl rand -hex 32`);
  if (DRY) console.log(`DRY RUN. Nothing is sent. ${live.length} agents: ${live.map((d) => d.key).join(', ')}. MCP base: ${SUPA}/functions/v1/agent-mcp/`);

  // 1. Environment
  let env = (await listAll('/v1/environments')).find((e) => e.name === ENV_NAME && !e.archived_at);
  const envBody = {
    name: ENV_NAME,
    description: 'BRP operations agents, shadow mode. No package installs and no outbound hosts: the agents reach only their MCP server.',
    config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [], allow_mcp_servers: true, allow_package_managers: false } },
    metadata: { brp: 'agents' },
  };
  if (!env) env = await api('POST', '/v1/environments', envBody, 'Environment create ' + ENV_NAME);
  else console.log('environment exists: ' + env.id);

  // 2. Vault and one bearer credential per agent MCP URL
  let vault = (await listAll('/v1/vaults')).find((v) => v.display_name === VAULT_NAME && !v.archived_at);
  if (!vault) vault = await api('POST', '/v1/vaults', { display_name: VAULT_NAME, metadata: { brp: 'agents' } }, 'Vault create');
  const creds = vault.id.startsWith('<') ? [] : await listAll(`/v1/vaults/${vault.id}/credentials`);
  for (const d of live) {
    const url = mcpUrl(d);
    if (creds.find((c) => c.auth && c.auth.mcp_server_url === url && !c.archived_at)) { console.log(`credential exists for ${d.key} (to rotate: archive it in the Console, then run again)`); continue; }
    await api('POST', `/v1/vaults/${vault.id}/credentials`, {
      display_name: 'BRP MCP ' + d.key,
      auth: { type: 'static_bearer', mcp_server_url: url, token: { env: tokenVar(d.key) } },
      metadata: { brp_agent: d.key },
    }, 'Credential create ' + d.key);
  }

  // 3. Agents and 4. scheduled deployments
  const agents = await listAll('/v1/agents');
  const deps = await listAll('/v1/deployments');
  for (const d of live) {
    const found = agents.find((a) => a.metadata && a.metadata.brp_agent === d.key && !a.archived_at);
    const agent = found
      ? await api('POST', `/v1/agents/${found.id}`, agentBody(d), 'Agent update ' + d.key)
      : await api('POST', '/v1/agents', agentBody(d), 'Agent create ' + d.key);
    const dep = deps.find((x) => x.metadata && x.metadata.brp_agent === d.key && x.status !== 'archived');
    const body = deploymentBody(d, agent, env.id, vault.id);
    const out = dep
      ? await api('POST', `/v1/deployments/${dep.id}`, body, 'Deployment update ' + d.key)
      : await api('POST', '/v1/deployments', body, 'Deployment create ' + d.key);
    if (!DRY) console.log(`${d.key}: agent ${agent.id} v${agent.version}, deployment ${out.id} ${out.status || ''}; next runs ${(out.schedule && out.schedule.upcoming_runs_at || []).slice(0, 3).join(', ')}`);
  }
  if (DRY) console.log(`\nDRY RUN complete: ${step} requests printed, none sent.`);
}

async function findDeployment(key) {
  if (!key || !defs.find((d) => d.key === key)) die('name an agent: ' + defs.map((d) => d.key).join(', '));
  if (DRY) return { id: `<deployment_id_${key}>` };
  const dep = (await listAll('/v1/deployments')).find((x) => x.metadata && x.metadata.brp_agent === key && x.status !== 'archived');
  if (!dep) die('no deployment found for ' + key);
  return dep;
}

async function main() {
  if (cmd === 'deploy') return deploy();
  if (cmd === 'pause' || cmd === 'unpause' || cmd === 'run') {
    const dep = await findDeployment(cmdArg);
    const r = await api('POST', `/v1/deployments/${dep.id}/${cmd}`, null, `Deployment ${cmd} ${cmdArg}`);
    if (!DRY) console.log(`${cmdArg}: ${cmd} ok`, r.status || '', r.session_id || '');
    return;
  }
  if (cmd === 'status') {
    for (const x of (await listAll('/v1/deployments')).filter((x) => x.metadata && x.metadata.brp_agent)) {
      console.log(`${x.metadata.brp_agent.padEnd(22)} ${String(x.status).padEnd(8)} ${x.paused_reason ? 'paused: ' + JSON.stringify(x.paused_reason) : ''} next: ${(x.schedule && x.schedule.upcoming_runs_at || []).slice(0, 2).join(', ')}`);
    }
    return;
  }
  if (cmd === 'token-hashes') {
    const m = {};
    for (const d of defs.filter((x) => x.enabled)) {
      const t = process.env[tokenVar(d.key)];
      if (!t) { console.error(`(${tokenVar(d.key)} not set; skipped)`); continue; }
      if (t.length < 32) die(tokenVar(d.key) + ' is too short; use openssl rand -hex 32');
      m[d.key] = createHash('sha256').update(t).digest('hex');
    }
    console.log(`npx -y supabase@2.118.0 secrets set BRP_AGENT_TOKEN_SHA256='${JSON.stringify(m)}'`);
    return;
  }
  die('unknown command ' + cmd);
}
main().catch((e) => die(e.message));
