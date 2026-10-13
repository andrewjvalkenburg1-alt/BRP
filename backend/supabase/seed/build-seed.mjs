#!/usr/bin/env node
/* BRP One backend seed builder. Sample data only; nothing in it happened.
   Reads the BRP v1 sample files and writes:
     supabase/seed/seed.sql   loads brp_seed.*, creates the nine demo accounts, then calls brp.reset_demo_data()
     client/demo-data.js      the same rows for the admin console's local demo mode (window.BRP_ADMIN_DEMO)
   Usage: node supabase/seed/build-seed.mjs [path to the barracks/v1 folder]
   Default source: /mnt/project-files/barracks/v1 (or $BRP_SOURCE).
   Inputs: apps/shared/brp-data.js (window.BRP_ENT), research/parts-catalog.json,
           ecosystem/modules/brp-erp-data.js (window.BRP_ERP_DATA), ecosystem/modules/brp-csat-data.js (window.BRP_CSAT_DATA). */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = process.argv[2] || process.env.BRP_SOURCE || '/mnt/project-files/barracks/v1';
const DEMO_PASSWORD = 'BRPdemo2026!';

function loadGlobal(file, name) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx, { filename: file });
  if (!ctx.window[name]) throw new Error(file + ' did not define window.' + name);
  return ctx.window[name];
}
const D = loadGlobal('apps/shared/brp-data.js', 'BRP_ENT');
const E = loadGlobal('ecosystem/modules/brp-erp-data.js', 'BRP_ERP_DATA');
const C = loadGlobal('ecosystem/modules/brp-csat-data.js', 'BRP_CSAT_DATA');
const CAT = JSON.parse(fs.readFileSync(path.join(SRC, 'research/parts-catalog.json'), 'utf8'));

/* Demo clock: record times are minutes from Oct 7, 2026 8:00 AM Eastern (12:00 UTC). */
const ANCHOR = Date.UTC(2026, 9, 7, 12, 0, 0);
const T = (m) => (m == null || m === '' ? null : new Date(ANCHOR + m * 60000).toISOString());
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const WINDOW = { Emergency: DAY, Urgent: 7 * DAY, Routine: 30 * DAY };
const due = (created, prio) => new Date(Date.parse(created) + (WINDOW[prio] || WINDOW.Routine)).toISOString();
const lines = (s) => (s ? String(s).split(' ').filter(Boolean).map((x) => { const [sku, q] = x.split('*'); return { sku, qty: +q || 1 }; }) : []);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- demo accounts (ecosystem/HOST-API.md) ---------- */
const ACCOUNTS = [
  ['soldier@brp.demo', 'SGT J. Parker', 'soldier', 'STW', '412', '1K'],
  ['tech@brp.demo', 'D. Reyes', 'technician', 'STW', null, null],
  ['manager@brp.demo', 'D. Hargrove', 'barracks_manager', 'STW', null, null],
  ['sitelead@brp.demo', 'R. Okafor', 'site_lead', 'STW', null, null],
  ['pm@brp.demo', 'M. Brennan', 'program_manager', null, null, null],
  ['buyer@brp.demo', 'K. Lindqvist', 'buyer', null, null, null],
  ['cor@brp.demo', 'L. Whitfield', 'cor', null, null, null],
  ['commander@brp.demo', 'COL A. Grant', 'commander', null, null, null],
  ['admin@brp.demo', 'BRP admin', 'admin', null, null, null]
];
const LABEL = { soldier: 'Soldier', technician: 'Technician', barracks_manager: 'Barracks manager', site_lead: 'Site lead', program_manager: 'Program manager', buyer: 'Buyer', cor: 'Government COR', commander: 'Garrison commander', admin: 'Admin' };
const demo_accounts = ACCOUNTS.map(([email, full_name, role, inst, home_bldg, home_room]) => ({ email, full_name, role, inst, home_bldg, home_room }));

/* ---------- installations ---------- */
const STAT_KEYS = ['c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'];
const installations = D.insts.map((r) => {
  const code = r[1], site = code ? D.sites[code] : null;
  const stats = { source: 'BRP_ENT.insts (commander dashboard sample KPIs, columns as in brp-data.js)' };
  r.slice(3).forEach((v, i) => { stats[STAT_KEYS[i] || 'c' + (i + 3)] = v; });
  return {
    id: code || slug(r[0]), name: r[0], state: site ? site[0] : null, climate: r[2],
    lead_name: site ? site[1] : null, manager_name: site ? site[2] : null, tech_names: site ? site[3] : [],
    pilot: !!code, stats, sample: true, created_at: T(0), updated_at: T(0)
  };
});
const INST = new Set(installations.map((i) => i.id));

/* ---------- buildings and rooms ---------- */
const SETUP = { '412': [3, 16, 'Mold'], '305': [3, 12, null], '118': [2, 10, null] };  // apps/shared/brp-setup.js seedData()
const buildings = [], bset = new Set();
function addBldg(inst, b, extra) {
  const id = inst + '-' + b;
  if (bset.has(id)) return;
  bset.add(id);
  buildings.push(Object.assign({ id, inst, bldg: b, type: null, built: null, floors: null, rooms_per_floor: null, numbering: 'custom', sensor_pod: null, stats: {}, sample: true, created_at: T(0), updated_at: T(0) }, extra || {}));
}
Object.keys(D.sites).forEach((code) => D.sites[code][4].forEach((b) => {
  const st = code === 'STW' && D.stb[b], su = code === 'STW' && SETUP[b];
  addBldg(code, b, st ? { type: st[3], built: st[4], floors: su[0], rooms_per_floor: su[1], numbering: 'letter', sensor_pod: su[2], stats: { source: 'BRP_ENT.stb', values: st } } : {});
}));

/* Work orders first (rooms need open orders for their status). */
const OSTEP = { request: 'open', verified: 'open', accepted: 'in_progress', longlead: 'waiting_parts', approval: 'waiting_parts', po: 'waiting_parts', shipped: 'waiting_parts', pulled: 'in_progress', delivered: 'in_progress', fab: 'in_progress', qa: 'in_progress', scheduled: 'in_progress', installed: 'in_progress', closed: 'closed' };
const TST = { 'Pending verification': 'open', New: 'open', Accepted: 'in_progress', 'En route': 'in_progress', 'On site': 'in_progress', 'Parts on order': 'waiting_parts', 'Awaiting Soldier confirmation': 'in_progress', Verified: 'closed' };
const DST = { New: 'open', Assigned: 'open', 'In work': 'in_progress', Fixed: 'closed', 'Verified by Soldier': 'closed' };
const SOURCES = new Set(['Soldier', 'Field', 'Sensor', 'Office', 'Inspection', 'Dashboard']);
const srcOf = (s, dflt) => { const v = /sensor/i.test(s) ? 'Sensor' : /QR|Soldier|portal/i.test(s) ? 'Soldier' : /Inspect|Baseline/i.test(s) ? 'Inspection' : s || dflt; return SOURCES.has(v) ? v : dflt; };
const SOLDIER_HOME = { name: 'SGT J. Parker', bldg: '412', room: '1K' };

const work_orders = [], wo_events = [];
let evId = 0;
const ev = (wo_id, at, actor_name, body, kind) => wo_events.push({ id: ++evId, wo_id, at, actor_name: actor_name || null, actor_id: null, kind: kind || 'note', body });
function wo(o) {
  const row = Object.assign({ ticket: null, alias: null, room_id: null, descr: null, step: null, closed_at: null, sched_at: null, room_down: false, tech_name: null, tech_id: null, soldier_name: null, soldier_id: null, parts: [], po_ids: [], interim: null, contractor: null, created_by: null, sample: true }, o);
  row.due_at = due(row.created_at, row.prio);
  row.updated_at = row.closed_at || row.created_at;
  work_orders.push(row);
  return row;
}
function opsWo(r, origin) {
  const last = r[16] || [];
  const w = wo({
    id: r[0], ticket: r[1] || null, inst: r[2], bldg: String(r[3]), room: String(r[4]).replace(/^Rm /, ''), title: r[5], descr: r[5],
    prio: r[6], step: r[7], status: OSTEP[r[7]] || 'open', room_down: !!r[8], soldier_name: r[9] || null, tech_name: r[10] || null,
    created_at: T(r[11]), po_ids: r[12] ? String(r[12]).split(' ').filter(Boolean) : [], parts: lines(r[13]),
    sched_at: r[14] != null ? T(r[14]) : null, interim: r[15] || null,
    closed_at: r[7] === 'closed' && last.length ? T(last[0]) : null,
    source: /Baseline/.test(r[9] || '') ? 'Inspection' : r[9] ? 'Soldier' : 'Office', origin
  });
  ev(w.id, w.created_at, w.soldier_name || 'BRP office', 'Request opened: ' + w.title + '.', 'opened');
  if (last.length > 1) ev(w.id, T(last[0]), last[1], last[2], 'step');
  if (w.closed_at) ev(w.id, w.closed_at, null, 'Closed.', 'closed');
  return w;
}
D.wo.forEach((r) => opsWo(r, 'office'));
D.tab.forEach((r) => {
  const home = String(r[1]) === SOLDIER_HOME.bldg && String(r[2]) === SOLDIER_HOME.room;
  const w = wo({ id: r[0], inst: 'STW', bldg: String(r[1]), room: String(r[2]), title: r[3], descr: r[9] || r[3], prio: r[4], step: r[5],
    status: TST[r[5]] || 'open', tech_name: r[6] || null, created_at: T(r[7]), source: srcOf(r[8], 'Field'), origin: 'field',
    soldier_name: home ? SOLDIER_HOME.name : null });
  ev(w.id, w.created_at, null, 'Reported through ' + r[8] + '. ' + (r[9] || ''), 'opened');
});
D.dt.forEach((r) => {
  const w = wo({ id: r[0], alias: r[1] || null, inst: r[10] || 'STW', bldg: String(r[2]), room: String(r[3]), title: r[4], descr: r[4], prio: r[5],
    source: srcOf(r[6], 'Dashboard'), step: r[7], status: DST[r[7]] || 'open', created_at: T(r[8]), contractor: r[9] || null,
    closed_at: r[11] != null ? T(r[11]) : null, origin: 'dashboard' });
  ev(w.id, w.created_at, null, 'Opened from the command dashboard (' + r[6] + ').', 'opened');
});
if (D.sim) {
  const w = opsWo(D.sim.wo, 'sim');
  wo_events.splice(wo_events.findIndex((e) => e.wo_id === w.id));   // the simulation carries its own full history
  D.sim.ev.forEach((e) => ev(w.id, T(e[0]), null, e[1], 'step'));
}

/* Rooms: the three Fort Stewart buildings with full room maps, plus any room a work order names. */
const rooms = [], rset = new Map();
const sens = {};
D.sens.split(' ').forEach((x) => { const m = x.split(':'); sens[m[0]] = { id: m[1], rh: +m[2], t: +m[3], wall: +m[4], st: m[5] }; });
const LET = 'ABCDEFGHIJKLMNOP';
const openWo = work_orders.filter((w) => w.status !== 'closed');
function roomStatus(inst, b, rm, off, s) {
  if (off) return 'offline';
  const ws = openWo.filter((w) => w.inst === inst && w.bldg === b && w.room === rm);
  if (ws.some((w) => w.prio === 'Emergency') || (s && (s.rh > 65 || s.wall >= 80))) return 'action';
  if (ws.length || (s && s.rh > 60)) return 'watch';
  return 'ok';
}
function addRoom(inst, b, rm, extra) {
  const id = inst + '-' + b + '-' + rm;
  if (rset.has(id)) return rset.get(id);
  addBldg(inst, b);
  const r = Object.assign({ id, inst, building_id: inst + '-' + b, bldg: b, room: rm, floor: null, room_type: '1+1', beds: 1, occupancy: 'unknown',
    status: roomStatus(inst, b, rm, null, null), offline_reason: null, note: null, sensor_id: null, sensor_pod: null, sensor_rh: null,
    sensor_temp_f: null, sensor_wall_rh: null, sensor_state: null, sensor_read_at: null, sample: true, created_at: T(0), updated_at: T(0) }, extra || {});
  rooms.push(r); rset.set(id, r);
  return r;
}
Object.keys(D.rooms).forEach((b) => {
  const s = D.rooms[b], per = SETUP[b][1];
  for (let i = 0; i < s.length; i++) {
    const rm = (Math.floor(i / per) + 1) + LET[i % per], off = D.offl[b + '-' + rm] || (s[i] === 'x' ? 'Offline for repairs' : null);
    const z = b === '412' ? sens[rm] : null;
    addRoom('STW', b, rm, {
      floor: Math.floor(i / per) + 1, occupancy: s[i] === 'o' ? 'occupied' : 'vacant', status: roomStatus('STW', b, rm, off, z), offline_reason: off,
      sensor_id: z ? z.id : null, sensor_pod: z ? 'Mold' : null, sensor_rh: z ? z.rh : null, sensor_temp_f: z ? z.t : null, sensor_wall_rh: z ? z.wall : null,
      sensor_state: z ? (z.st === 'r' ? 'reporting' : z.st === 'b' ? 'low_battery' : 'offline') : null, sensor_read_at: z ? T(-5) : null
    });
  }
});
work_orders.forEach((w) => {
  if (!/^[0-9]?[0-9A-Z]{1,5}$/.test(w.room)) return;   // skip "East wing (24 rooms)", "Mech"
  const r = addRoom(w.inst, w.bldg, w.room, { floor: /^\d/.test(w.room) ? +w.room[0] : null });
  w.room_id = r.id;
});
work_orders.forEach((w) => { if (!w.room_id && rset.has(w.inst + '-' + w.bldg + '-' + w.room)) w.room_id = w.inst + '-' + w.bldg + '-' + w.room; });

/* ---------- vendors, catalog, parts ---------- */
const vendors = Object.keys(D.vend).map((id) => ({ id, name: D.vend[id][0], city: D.vend[id][1], cat: D.vend[id][2], terms: (E.vend[id] || {}).terms || null, contact: (E.vend[id] || {}).contact || null, sample: true, updated_at: T(0) }));
Object.keys(E.vend).forEach((id) => { const v = E.vend[id]; if (!D.vend[id] && v.name) vendors.push({ id, name: v.name, city: v.city || null, cat: v.cat || null, terms: v.terms || null, contact: v.contact || null, sample: true, updated_at: T(0) }); });

const BASIS = {
  listing_page_opened: 'Listing page opened by BRP on the as-of date',
  search_index_snapshot: 'Search index snapshot of an undated listing. Verify before quoting.',
  dod_standard_price: 'DoD standard price on a public NSN listing'
};
const internal = (s) => /^file:/i.test(s.url || '') || /internal/i.test(s.publisher || '') || /internal/i.test(s.title || '');
const catalog_items = CAT.parts.map((p) => ({
  id: p.id, name: p.name, category: p.category, description: p.description || null,
  typical_spec: p.typical_spec == null ? null : (typeof p.typical_spec === 'string' ? { text: p.typical_spec } : p.typical_spec),
  manufacturer: p.manufacturer || null, mfr_part_number: p.mfr_part_number || null, mfr_part_number_source_url: p.mfr_part_number_source_url || null,
  nsn: p.nsn || null, nsn_source_url: p.nsn_source_url || null,
  price_low: p.price ? p.price.low : null, price_high: p.price ? p.price.high : null, price_currency: p.price ? p.price.currency : null,
  price_unit: p.price ? p.price.unit : null, price_basis: p.price ? p.price.basis : null, price_basis_label: p.price ? BASIS[p.price.basis] || p.price.basis : null,
  price_as_of: p.price ? p.price.as_of : null, price_note: p.price ? p.price.note : null, lead_time: p.lead_time || null,
  fixes_failures: p.fixes_failures || [], status: p.status || null, notes: p.notes || null,
  // Internal design documents are cited by title only: this repo is public.
  sources: (p.sources || []).map((s) => (internal(s) ? Object.assign({}, s, { url: null, title: s.title + ' (internal document, link withheld)' }) : s)),
  stocked_for: p.stocked_for_installations || [], updated_at: '2026-10-09T12:00:00.000Z'
}));
const CATID = new Set(catalog_items.map((c) => c.id));

const catOf = (sku) => { let best = null; E.cats.forEach(([pre, cat]) => { if (sku.startsWith(pre) && (!best || pre.length > best[0].length)) best = [pre, cat]; }); return best ? best[1] : null; };
const parts = [];
const addPart = (sku, p, extra) => parts.push(Object.assign({ sku, name: p[0], cat: catOf(sku), cost: p[1] == null ? null : p[1], vendor_id: p[2] || null, lead_days: p[3] == null ? null : p[3],
  rop: E.rop[sku] ? E.rop[sku][0] : null, roq: E.rop[sku] ? E.rop[sku][1] : null, catalog_id: E.catalogMap[sku] || null, design_only: false, sample: true, updated_at: T(0) }, extra || {}));
Object.keys(D.part).forEach((sku) => addPart(sku, D.part[sku]));
Object.keys(E.parts).forEach((sku) => { if (!D.part[sku]) addPart(sku, E.parts[sku]); });
Object.keys(E.sensors).forEach((sku) => addPart(sku, [E.sensors[sku][0], null, 'BRP', null], { cat: 'BRP sensor', design_only: true, catalog_id: CATID.has(sku) ? sku : null }));
const PART = Object.fromEntries(parts.map((p) => [p.sku, p]));
const ensurePart = (sku) => { if (!PART[sku]) { addPart(sku, [sku + ' (sample part)', null, null, null]); PART[sku] = parts[parts.length - 1]; } };

/* ---------- cabinets and stock ---------- */
const cabinets = [], stock = [];
const cabs = Object.assign({}, D.cab, E.cab);
Object.keys(cabs).forEach((id) => {
  const c = cabs[id];
  cabinets.push({ id, inst: c[0], name: c[1], kind: /field/i.test(c[1]) ? 'field' : 'cage', sample: true });
  c[2].split(' ').filter(Boolean).forEach((x) => {
    const [sku, q] = x.split(':'); ensurePart(sku);
    stock.push({ cabinet_id: id, sku, inst: c[0], qty: +q, rop: PART[sku].rop, roq: PART[sku].roq, updated_at: T(0) });
  });
});

/* ---------- purchase orders ---------- */
const purchase_orders = [], po_lines = [];
let plId = 0;
const allPo = D.po.concat(E.po).concat(D.sim ? [D.sim.po] : []);
allPo.forEach((r) => {
  purchase_orders.push({ id: r[0], wo_id: r[1] || null, kind: r[1] ? 'work_order' : 'replenishment', inst: r[2], vendor_id: r[3], status: r[4], total: r[5],
    issued_at: T(r[6]), eta: T(r[7]), flag: r[8] || 0, carrier: r[9] || null, tracking: r[10] || null, received_at: T(r[11]), created_by: null, sample: true,
    updated_at: T(r[11] != null ? r[11] : r[6]) });
  lines(r[12]).forEach((l) => { ensurePart(l.sku); po_lines.push({ id: ++plId, po_id: r[0], sku: l.sku, qty: l.qty, unit_cost: PART[l.sku].cost }); });
});
const WOID = new Set(work_orders.map((w) => w.id));
purchase_orders.forEach((p) => { if (p.wo_id && !WOID.has(p.wo_id)) p.wo_id = null; });

/* ---------- purchasing list: open requisitions, technician part requests, and cabinet items under their reorder point ---------- */
const purchase_list = [];
const pl = (o) => purchase_list.push(Object.assign({ sku: null, catalog_id: null, qty: 1, est_unit_cost: null, vendor_id: null, reason: null, note: null, wo_id: null,
  po_id: null, requested_by: null, requested_by_name: null, needed_by: null, sample: true, created_at: T(0), updated_at: T(0), updated_by: null }, o));
(D.rq || []).forEach((r) => pl({ id: r[0], inst: r[2], description: r[4] + ' requisition ' + r[0], est_unit_cost: r[5], reason: r[4], source: 'requisition',
  wo_id: r[1] && WOID.has(r[1]) ? r[1] : null, status: r[3] === 'pending' ? 'requested' : r[3], requested_by_name: 'BRP back office' }));
(D.treq || []).forEach((r) => {
  const p = parts.find((x) => x.name.toLowerCase().includes(String(r[1]).toLowerCase().replace(/^run /, '').split(' ')[1] || '~') && x.name.includes('45/5'));
  pl({ id: r[0], inst: 'STW', description: r[1], qty: r[2], sku: p ? p.sku : null, est_unit_cost: p ? p.cost : null, vendor_id: p ? p.vendor_id : null,
    reason: 'Technician part request', source: 'work_order', wo_id: WOID.has(r[4]) ? r[4] : null, status: /approved/i.test(r[3]) ? 'approved' : 'requested',
    created_at: T(r[5]), updated_at: T(r[5]), requested_by_name: 'D. Reyes' });
});
const onOrder = new Set();
purchase_orders.filter((p) => !['received', 'cancelled'].includes(p.status)).forEach((p) => po_lines.filter((l) => l.po_id === p.id).forEach((l) => onOrder.add(p.inst + ':' + l.sku)));
let n = 0;
stock.forEach((s) => {
  if (s.rop == null || s.qty >= s.rop || onOrder.has(s.inst + ':' + s.sku)) return;
  const p = PART[s.sku];
  if (p.design_only) return;
  pl({ id: 'PL-' + String(++n).padStart(4, '0'), inst: s.inst, sku: s.sku, catalog_id: p.catalog_id, description: p.name, qty: s.roq || Math.max(1, s.rop - s.qty),
    est_unit_cost: p.cost, vendor_id: p.vendor_id, reason: s.cabinet_id + ' has ' + s.qty + ', reorder point ' + s.rop, source: 'low_stock', status: 'requested',
    requested_by_name: 'Stock check' });
});

/* ---------- satisfaction ---------- */
const satisfaction = C.records.filter((r) => INST.has(r[2])).map((r) => ({
  id: r[0], at: T(r[1]), inst: r[2], bldg: r[3] || null, room: r[4] || null, wo_id: r[5] || null, channel: r[6], score: r[7], scale: String(r[8]),
  text: r[9] || null, anon: !!r[10], by_name: r[10] ? null : r[11] || null, by_id: null, sample: true
}));

/* ---------- sample alerts, fan-out and outbox (logged only, never sent) ---------- */
const alerts = [], alert_recipients = [], email_outbox = [];
const ACC = Object.fromEntries(ACCOUNTS.map((a) => [a[0], a]));
let arId = 0, obId = 0;
function alert(id, at, type, severity, title, body, inst, ref, emails) {
  alerts.push({ id, at, type, severity, title, body, inst, ref, tags: [ref, 'inst:' + inst], created_by: null, created_by_name: 'BRP automation', sample: true });
  emails.forEach((e) => {
    const a = ACC[e];
    alert_recipients.push({ id: ++arId, alert_id: id, profile_id: null, email: e, name: a[1], role: LABEL[a[2]], read_at: null, push_status: 'none' });
    email_outbox.push({ id: ++obId, alert_id: id, inst, to_email: e, to_name: a[1], to_role: LABEL[a[2]], subject: '[BRP ' + severity.toUpperCase() + '] ' + title,
      body: title + '\n\n' + body + '\n\nRecord: ' + ref + '\nInstallation: ' + inst + '\nRaised by: BRP automation\n\nSent by BRP One. Sample data.',
      status: 'logged', provider: 'none', provider_message_id: null, error: null, created_at: at, sent_at: null });
  });
}
alert('AL-0001', T(-21), 'wo.emergency', 'critical', 'Emergency: active leak, Fort Stewart Bldg 412 Rm 3F',
  'T-2107: water on the floor spreading toward the hallway. Respond within 1 hour.', 'STW', 'wo:T-2107',
  ['tech@brp.demo', 'manager@brp.demo', 'sitelead@brp.demo', 'pm@brp.demo']);
alert('AL-0002', T(-180), 'sensor.threshold', 'high', 'Humidity above 60%, Fort Stewart Bldg 412 Rm 2B',
  'Room sensor RS1-6893 reads 68.4% RH. Wall moisture 85. Check the dehumidifier.', 'STW', 'room:STW-412-2B',
  ['tech@brp.demo', 'manager@brp.demo', 'sitelead@brp.demo']);
alert('AL-0003', T(-2700), 'part.backorder', 'high', 'Backordered: PO BRP-STW-27-0433',
  'Coastal Mechanical Supply reports paint, ceiling tile and wall pack lights on backorder.', 'STW', 'po:BRP-STW-27-0433',
  ['buyer@brp.demo', 'sitelead@brp.demo']);

/* ---------- write seed.sql ---------- */
const TABLES = { installations, buildings, rooms, vendors, catalog_items, parts, cabinets, stock, work_orders, wo_events, purchase_orders, po_lines,
  purchase_list, satisfaction, alerts, alert_recipients, email_outbox, demo_accounts };
const json = (rows) => { const s = JSON.stringify(rows); if (s.includes('$brp$')) throw new Error('dollar tag in data'); return s; };
const sqlStr = (s) => (s == null ? 'null' : "'" + String(s).replace(/'/g, "''") + "'");

let sql = `-- BRP One demo seed. GENERATED by supabase/seed/build-seed.mjs from the BRP v1 sample files. Do not edit by hand.
-- Sample data only. Nothing here happened. Generated ${new Date().toISOString().slice(0, 10)}.
-- Run after the migrations, as the database owner (supabase db push --include-seed, or psql -f).
-- 1) loads brp_seed.*  2) creates or refreshes the nine demo accounts (password ${DEMO_PASSWORD})  3) copies brp_seed into the live tables.
begin;
select set_config('brp.bulk', 'on', true);
`;
Object.keys(TABLES).forEach((t) => {
  sql += `\ndelete from brp_seed.${t};\ninsert into brp_seed.${t} select * from jsonb_populate_recordset(null::brp_seed.${t}, $brp$${json(TABLES[t])}$brp$::jsonb);\n`;
});
sql += `
-- Demo accounts. Supabase Auth reads auth.users and auth.identities; the profile row is made by the brp_on_auth_user_created trigger.
-- If this project does not let the database owner write auth.users, the block only warns; then run
-- node supabase/seed/create-demo-users.mjs (Admin API, service key from your shell) and run this seed again.
do $$
declare a record; v_id uuid;
begin
  for a in select * from brp_seed.demo_accounts loop
   begin
    select id into v_id from auth.users where lower(email) = a.email;
    if v_id is null then
      v_id := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                              created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', a.email,
              extensions.crypt(${sqlStr(DEMO_PASSWORD)}, extensions.gen_salt('bf')), now(),
              jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'brp_role', a.role, 'brp_inst', a.inst,
                                 'brp_home_bldg', a.home_bldg, 'brp_home_room', a.home_room, 'brp_active', true, 'brp_demo', true),
              jsonb_build_object('full_name', a.full_name), now(), now(), '', '', '', '');
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', a.email, 'email_verified', true), 'email', now(), now(), now());
    else
      update auth.users set encrypted_password = extensions.crypt(${sqlStr(DEMO_PASSWORD)}, extensions.gen_salt('bf')),
             email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = v_id;
      insert into public.profiles (id, email, full_name, role, inst, active, demo) values (v_id, a.email, a.full_name, a.role, a.inst, true, true)
      on conflict (id) do nothing;
    end if;
   exception when insufficient_privilege then
     raise warning 'Could not write auth.users for %. Run supabase/seed/create-demo-users.mjs, then this seed again.', a.email;
   end;
  end loop;
end $$;

select brp.reset_demo_data();
commit;
`;
fs.writeFileSync(path.join(HERE, 'seed.sql'), sql);

/* ---------- write client/demo-data.js (local demo mode for the admin console) ---------- */
const profiles = ACCOUNTS.map((a, i) => ({ id: 'demo-' + (i + 1), email: a[0], full_name: a[1], role: a[2], inst: a[3], home_bldg: a[4], home_room: a[5], active: true, demo: true, created_at: T(-43200) }));
const link = (name, role) => { const p = profiles.find((x) => x.full_name === name && x.role === role); return p ? p.id : null; };
const woLocal = work_orders.map((w) => Object.assign({}, w, { tech_id: link(w.tech_name, 'technician'), soldier_id: link(w.soldier_name, 'soldier') }));
const demo = { generated: new Date().toISOString().slice(0, 10), note: 'Sample data. Nothing here happened.', anchor: T(0), password: DEMO_PASSWORD,
  tables: Object.assign({}, TABLES, { profiles, work_orders: woLocal, audit_log: [] }) };
delete demo.tables.demo_accounts;
fs.writeFileSync(path.join(ROOT, 'client', 'demo-data.js'),
  '/* BRP admin console, local demo data. GENERATED by supabase/seed/build-seed.mjs. Sample data only; nothing here happened. */\nwindow.BRP_ADMIN_DEMO=' + JSON.stringify(demo) + ';\n');

const counts = Object.fromEntries(Object.keys(TABLES).map((t) => [t, TABLES[t].length]));
console.log(JSON.stringify(counts));
