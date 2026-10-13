#!/usr/bin/env node
// Moves the Command Center artifact's records into BRP HQ.
//
// The Command Center artifact keeps its data in collections: tasks, decisions, agents, systems and meta. This script
// reads that data in any of three shapes and writes it out for HQ:
//   - a folder of <collection>-<doc id>.json files (one record per file, as exported by Claude);
//   - a JSON array of { op: "set", collection, doc_id, data } writes (the artifact's batch format);
//   - a normalized export: { "exported_at", "collections": { "tasks": { "<id>": {...} }, ... } }.
//
// Outputs (pick any):
//   --json <file>   normalized export (the file kept in backend/hq/seed/)
//   --sql  <file>   SQL that upserts every record into the hq_* tables (run it with psql or the Supabase connector)
//   --js   <file>   window.BRP_HQ_SEED for HQ's local demo mode (backend/hq/hq-seed.js)
// Options:
//   --sample        mark rows as sample data (demo seed). Leave it off for Andrew's real rows: real rows are hidden from
//                   the demo accounts, whose passwords are published.
//   --demo-extras   add the few labeled demo rows HQ's local demo uses to show the partner and site lead views.
//
// Examples:
//   node backend/hq/tools/import-command-center.mjs <docs folder> --json backend/hq/seed/command-center.json
//   node backend/hq/tools/import-command-center.mjs backend/hq/seed/command-center.json --sql /tmp/hq-import.sql
//   node backend/hq/tools/import-command-center.mjs backend/hq/seed/command-center.json --sample --demo-extras \
//        --sql backend/supabase/seed/hq-seed-data.sql --js backend/hq/hq-seed.js
// Re-running is safe: every row is an upsert by id. Rows answered or finished in HQ keep their answers and status
// unless the source says otherwise (status and answers come from the source on each run).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const OWNERS = ['Andrew', 'Claude', 'Rynoc', 'Attorney', 'CPA'];
const STATUSES = ['not_started', 'in_progress', 'waiting', 'at_risk', 'done'];
const AGENT_KEY = { buyer: 'buyer_dispatch', sensor: 'sensor_watch', inspect: 'inspection_scheduler', rooms: 'room_readiness', soldier: 'soldier_liaison' };
const AGENT_SORT = ['buyer', 'sensor', 'inspect', 'rooms', 'soldier', 'brief', 'books'];

export function readSource(path) {
  const st = statSync(path);
  const cols = {};
  const put = (c, id, d) => { (cols[c] = cols[c] || {})[id] = d; };
  if (st.isDirectory()) {
    for (const f of readdirSync(path).filter((x) => x.endsWith('.json')).sort()) {
      const m = basename(f, '.json').match(/^([a-z_]+)-(.+)$/);
      if (!m) continue;
      put(m[1], m[2], JSON.parse(readFileSync(join(path, f), 'utf8')));
    }
    return { exported_at: null, collections: cols };
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(j)) {
    for (const w of j) if (w && w.op === 'set' && w.collection && w.doc_id) put(w.collection, w.doc_id, w.data);
    return { exported_at: null, collections: cols };
  }
  if (j && j.collections) return j;
  throw new Error('Unknown input shape: expected a folder, a batch array or { collections }');
}

const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);

/** Normalizes the artifact records into HQ rows. Throws on anything that would fail the database checks. */
export function toRows(src, { sample = false, demoExtras = false } = {}) {
  const C = src.collections || {};
  const tasks = Object.entries(C.tasks || {}).map(([id, t]) => {
    if (!OWNERS.includes(t.owner)) throw new Error(`task ${id}: owner ${t.owner} is not one of ${OWNERS.join(', ')}`);
    if (!STATUSES.includes(t.status)) throw new Error(`task ${id}: status ${t.status} is not one of ${STATUSES.join(', ')}`);
    return { id, owner: t.owner, desk: t.desk || '', area: t.area || '', item: t.item, status: t.status, due: t.due || '', sort_date: isoDate(t.sort),
      next: t.next || '', note: t.note || '', inst: t.inst || null, shared: !!t.shared, source: 'command_center', sample };
  });
  const decisions = Object.entries(C.decisions || {}).map(([id, d]) => {
    if (!Array.isArray(d.options) || d.options.length < 2) throw new Error(`decision ${id}: needs at least two options`);
    return { id, kind: 'question', question: d.question, context: d.context || '', options: d.options, recommended: Number.isInteger(d.recommended) ? d.recommended : null,
      owner: d.owner || 'Andrew', answer: d.answer ?? null, answer_index: d.answer != null ? d.options.indexOf(d.answer) : null,
      answered_at: d.answered_at || null, sort_date: isoDate(d.sort), shared: !!d.shared, source: 'command_center', sample };
  });
  const agents = Object.entries(C.agents || {}).map(([id, a]) => ({ id, name: a.name, agent: AGENT_KEY[id] || null, level: a.level, mode: a.mode || 'Off',
    evidence: a.evidence || '', next: a.next || '', sort: AGENT_SORT.indexOf(id) < 0 ? 99 : AGENT_SORT.indexOf(id), sample }));
  const systems = Object.entries(C.systems || {}).map(([id, s]) => ({ id, name: s.name, status: s.status || '', state: s.state || 'building', url: s.url || '',
    note: s.note || '', sort: s.sort ?? 0, sample }));
  for (const s of systems) if (!['live', 'building', 'blocked'].includes(s.state)) throw new Error(`system ${s.id}: state ${s.state}`);
  const documents = Object.entries(C.documents || {}).map(([id, d]) => ({ id, title: d.title, url: d.url, area: d.area || '', note: d.note || '',
    owner: d.owner || 'Andrew', shared: !!d.shared, inst: d.inst || null, sort: d.sort ?? 0, sample }));
  const meta = C.meta || {};
  const out = { tasks, decisions, agents, systems, documents, meta };
  if (demoExtras) addDemoExtras(out);
  return out;
}

/** A few labeled rows that let the demo show the partner and site lead views and the Documents page. Not Andrew's data. */
function addDemoExtras(out) {
  const R = 'https://github.com/andrewjvalkenburg1-alt/brp/blob/main/';
  out.tasks.push({ id: 'demo-stw1', owner: 'Rynoc', desk: '', area: 'Operations', item: 'Walk Fort Stewart Bldg 412 with the site lead (demo row)', status: 'not_started',
    due: 'Oct 22', sort_date: '2026-10-22', next: 'Demo row for the partner and site lead views. Not from the Command Center.', note: '', inst: 'STW', shared: false, source: 'hq', sample: true });
  out.documents.push(
    { id: 'doc-backend', title: 'Backend setup (BACKEND.md)', url: R + 'backend/BACKEND.md', area: 'Systems', note: 'Supabase, roles, edge functions', owner: 'Andrew', shared: true, inst: null, sort: 1, sample: true },
    { id: 'doc-agents', title: 'Operations agents (AGENTS.md)', url: R + 'backend/agents/AGENTS.md', area: 'Agents', note: 'Readiness ladder and shadow mode', owner: 'Andrew', shared: true, inst: null, sort: 2, sample: true },
    { id: 'doc-hq', title: 'Command guide (HQ.md)', url: R + 'backend/hq/HQ.md', area: 'Systems', note: 'How Command goes live and who sees what', owner: 'Andrew', shared: true, inst: null, sort: 3, sample: true },
    { id: 'doc-admin', title: 'Admin console', url: 'https://andrewjvalkenburg1-alt.github.io/BRP/backend/client/admin.html', area: 'Systems', note: 'Users, rooms, work orders, purchasing', owner: 'Andrew', shared: false, inst: null, sort: 4, sample: true },
    { id: 'doc-app', title: 'BRP One app', url: 'https://andrewjvalkenburg1-alt.github.io/BRP/', area: 'Product', note: 'The Soldier and staff app', owner: 'Andrew', shared: true, inst: null, sort: 5, sample: true });
  return out;
}

const q = (v) => (v === null || v === undefined ? 'null' : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
function upsert(table, rows, cols, keep = []) {
  if (!rows.length) return '';
  const upd = cols.filter((c) => c !== 'id' && !keep.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  return `insert into public.${table} (${cols.join(', ')}) values\n` +
    rows.map((r) => '  (' + cols.map((c) => (c === 'options' ? q(JSON.stringify(r[c])) + '::jsonb' : c === 'sort_date' ? (r[c] ? q(r[c]) + '::date' : 'null') : q(r[c]))).join(', ') + ')').join(',\n') +
    `\non conflict (id) do update set ${upd};\n`;
}

export function toSql(rows, { label = 'Command Center import' } = {}) {
  return `-- ${label}. Generated by backend/hq/tools/import-command-center.mjs. Upserts by id; safe to run again.\n` +
    `-- Run as the database owner (psql, or the Supabase connector's SQL tool). Rows with sample = false are hidden from demo accounts.\n` +
    'begin;\nset local brp.hq_fn = \'on\';\n' +
    upsert('hq_tasks', rows.tasks, ['id', 'owner', 'desk', 'area', 'item', 'status', 'due', 'sort_date', 'next', 'note', 'inst', 'shared', 'source', 'sample']) +
    upsert('hq_decisions', rows.decisions, ['id', 'kind', 'question', 'context', 'options', 'recommended', 'owner', 'answer', 'answer_index', 'answered_at', 'sort_date', 'shared', 'source', 'sample']) +
    upsert('hq_agent_levels', rows.agents, ['id', 'name', 'agent', 'level', 'mode', 'evidence', 'next', 'sort', 'sample']) +
    upsert('hq_systems', rows.systems, ['id', 'name', 'status', 'state', 'url', 'note', 'sort', 'sample']) +
    upsert('hq_documents', rows.documents, ['id', 'title', 'url', 'area', 'note', 'owner', 'shared', 'inst', 'sort', 'sample']) +
    'commit;\n';
}

export function toJs(rows, normalized) {
  return '/* BRP Command local demo seed. GENERATED by backend/hq/tools/import-command-center.mjs from the Command Center export.\n' +
    '   Tasks, decisions, agent levels and systems are Andrew\'s Command Center records as of ' + ((normalized.collections.meta || {}).sync || {}).at_label + '.\n' +
    '   Rows whose id starts with demo- or doc- are demo rows. Nothing here is a secret. */\n' +
    'window.BRP_HQ_SEED=' + JSON.stringify({ generated: (((normalized.collections.meta || {}).sync || {}).at) || null, ...rows }) + ';\n';
}

function main(argv) {
  const args = argv.slice(2);
  const src = args.find((a, i) => !a.startsWith('--') && !(i > 0 && /^--(json|sql|js)$/.test(args[i - 1])));
  if (!src) { console.error('Usage: import-command-center.mjs <docs folder | export.json> [--json f] [--sql f] [--js f] [--sample] [--demo-extras]'); process.exit(2); }
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const normalized = readSource(src);
  if (!normalized.exported_at) normalized.exported_at = new Date().toISOString();
  const rows = toRows(normalized, { sample: args.includes('--sample'), demoExtras: args.includes('--demo-extras') });
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(normalized, null, 1) + '\n');
  if (opt('--sql')) writeFileSync(opt('--sql'), toSql(rows, { label: args.includes('--sample') ? 'BRP HQ demo seed (sample rows)' : 'Command Center import (real rows)' }));
  if (opt('--js')) writeFileSync(opt('--js'), toJs(rows, normalized));
  const n = (o) => Object.keys(o || {}).length;
  const C = normalized.collections;
  console.log(`Read ${n(C.tasks)} tasks, ${n(C.decisions)} decisions, ${n(C.agents)} agents, ${n(C.systems)} systems, ${n(C.meta)} meta (${n(C.tasks) + n(C.decisions) + n(C.agents) + n(C.systems) + n(C.meta)} records).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
