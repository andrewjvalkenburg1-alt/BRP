/* BRP Command (served at backend/hq/). One portal for the owner: Home, Tasks, Decisions, Agents, Purchasing, Rooms, Systems, Documents and Ask Claude.
   Two data layers with the same methods:
     local   no backend configured (brp-config.js empty). Demo mode. HQ rows from hq-seed.js, business rows and agent
             proposals from the admin console's own browser copy (localStorage 'brp-admin-demo-v1'), so a decision made here
             shows in the admin console and the other way round. Nothing leaves the browser.
     remote  BRPBackend (Supabase). Row-level security decides what each person sees (migration 20261015000100_brp_hq.sql).
             Ask Claude calls the hq-chat Edge Function. */
(function () {
'use strict';
var BE = window.BRPBackend, LOCAL = !(BE && BE.configured());
var SEED = window.BRP_HQ_SEED || { tasks: [], decisions: [], agents: [], systems: [], documents: [] };
var AS = window.BRP_AGENT_SAMPLES || { labels: {}, flags: {}, proposals: [], settings: [], hq_profiles: [] };
var PW = 'BRPdemo2026!';
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var OWNERS = ['Andrew', 'Claude', 'Rynoc', 'Attorney', 'CPA'];
var STATUS = { not_started: 'Not started', in_progress: 'In progress', waiting: 'Waiting', at_risk: 'At risk', done: 'Done' };
var STATUS_DOT = { not_started: '', in_progress: 'ok', waiting: 'watch', at_risk: 'act', done: 'ok' };
var ROLE_LABEL = { owner: 'Owner', partner: 'Partner', site_lead: 'Site lead' };
var HQ_MEMBERS = { 'partner@brp.demo': ['partner', 'Rynoc'], 'owner@brp.demo': ['owner', 'Andrew'] };
function todayIso() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function days(iso) { if (!iso) return null; return Math.round((Date.parse(iso + 'T12:00:00') - Date.parse(todayIso() + 'T12:00:00')) / 864e5); }
function fdate(iso) { if (!iso) return ''; var p = String(iso).slice(0, 10).split('-'); return MON[+p[1] - 1] + ' ' + (+p[2]); }
function ftime(t) {
  if (!t) return ''; var d = new Date(t); if (isNaN(d)) return '';
  var h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + ((h % 12) || 12) + ':' + m + (h < 12 ? ' am' : ' pm');
}
function money(n) { return n == null ? '' : '$' + (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function toast(m) { var t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4200); }
function loadScript(src) {
  return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('Could not load ' + src)); }; document.head.appendChild(s); });
}
function store(k, v) { try { if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; }
function sess(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; }
function proposalQuestion(p) { return (AS.labels[p.agent] || p.agent) + ' proposes ' + String(p.kind).replace(/_/g, ' ') + ' at ' + p.inst + ' (' + p.id + '). Do you agree?'; }
function proposalDecision(p) {
  return { id: 'HD-' + p.id, kind: 'agent_proposal', proposal_id: p.id, proposal: p, question: proposalQuestion(p), context: p.rationale, options: ['Approve', 'Reject'], recommended: null,
    owner: 'Andrew', inst: p.inst, sample: !!p.sample, sort_date: String(p.created_at || '').slice(0, 10),
    answer: p.status === 'approved' ? 'Approve' : p.status === 'rejected' ? 'Reject' : null, answer_index: p.status === 'approved' ? 0 : p.status === 'rejected' ? 1 : null,
    answer_note: p.decision_note || null, answered_at: p.decided_at || null, answered_by_email: p.decided_by_email || null };
}

/* =====================================================================
   Local demo data layer
   ===================================================================== */
var SAMPLE_CHAT = [
  { id: 's1', role: 'user', author: 'Andrew', content: 'What needs me this week?', created_at: '2026-10-13T13:02:00Z', sample: true },
  { id: 's2', role: 'assistant', author: 'Claude', sample: true, created_at: '2026-10-13T13:02:20Z',
    content: 'Three things need you this week.\n\n1. Answer the xTech question (d1). The white paper v1 is due Oct 19 and only a v0 draft exists.\n2. Get the Rynoc legal name, UEI and CAGE (t03). It is at risk and due Oct 17.\n3. Connect the Supabase connector (t01), due this week.\n\nI drafted a task for Rynoc to send the UEI and CAGE. Tap Save to keep it.',
    drafts: [{ _id: 'DRAFT-1', kind: 'task', owner: 'Rynoc', area: 'Company', item: 'Send Andrew the Rynoc legal name, UEI and CAGE', due: 'Oct 16', sort_date: '2026-10-16', next: 'Needed on the ERDC-CERL and xTech cover pages' }],
    checked: { changed: true, checked_sentences: 7, removed: [{ sentence: 'I have told Rynoc you need it by Thursday.', category: 'action_claim', reason: 'names no action record: nothing was sent to Rynoc' }] } }
];

function localApi() {
  /* One login with BRP One: the same tab session key BRP One writes ('brp-one:user' = the account email). */
  var HKEY = 'brp-hq-demo-v2', AKEY = 'brp-admin-demo-v1', SKEY = 'brp-one:user', ASKEY = 'brp-admin-session-v1';
  var A = null, H = null, me = null;
  function demo() { return window.BRP_ADMIN_DEMO ? Promise.resolve() : loadScript('../client/demo-data.js'); }
  function adb() {
    if (A) return A;
    var D = window.BRP_ADMIN_DEMO, s = store(AKEY);
    A = s && s.v === D.generated && s.t ? s.t : clone(D.tables);
    if (!A.agent_proposals) A.agent_proposals = clone(AS.proposals);
    if (!A.agent_settings) A.agent_settings = clone(AS.settings);
    if (!A.audit_log) A.audit_log = [];
    (AS.hq_profiles || []).forEach(function (p) { if (!A.profiles.some(function (x) { return x.email === p.email; })) A.profiles.push(clone(p)); });
    return A;
  }
  function saveA() { store(AKEY, { v: window.BRP_ADMIN_DEMO.generated, t: A }); }
  function hdb() {
    if (H) return H;
    var s = store(HKEY);
    if (s && s.v === SEED.generated && s.t) H = s.t;
    else H = { tasks: clone(SEED.tasks), decisions: clone(SEED.decisions), agents: clone(SEED.agents), systems: clone(SEED.systems), documents: clone(SEED.documents), messages: [], requests: [], saved: {} };
    return H;
  }
  function saveH() { store(HKEY, { v: SEED.generated, t: H }); }
  function nowIso() { return new Date().toISOString(); }
  function toMe(p) {
    var m = HQ_MEMBERS[p.email], r = p.role === 'admin' ? 'owner' : m ? m[0] : p.role === 'site_lead' ? 'site_lead' : null;
    return { id: p.id, email: p.email, name: p.full_name, role: p.role, inst: p.inst || null, demo: !!p.demo, hq_role: r, party: r === 'owner' ? 'Andrew' : m ? m[1] : null };
  }
  function sees(row) {
    if (!me || !me.hq_role) return false;
    if (me.hq_role === 'owner') return true;
    if (me.hq_role === 'partner') return row.owner === me.party || !!row.shared;
    return !!row.inst && row.inst === me.inst;
  }
  function audit(action, table, id, o, n) { adb().audit_log.unshift({ id: (A.audit_log.length ? A.audit_log[0].id : 0) + 1, at: nowIso(), actor_id: me.id, actor_email: me.email, actor_role: me.role, action: action, table_name: table, row_id: id, old_row: o, new_row: n }); }
  function demoTurn(text, note, asRequest) {
    var h = hdb(), t = nowIso(), r = null;
    var u = { id: 'L' + Date.now(), thread: 'main', thread_owner: me.id, role: 'user', author: me.name, content: text, created_at: t };
    var a = { id: 'L' + (Date.now() + 1), thread: 'main', thread_owner: me.id, role: 'system', author: 'Command', created_at: t, content: note };
    h.messages.push(u, a);
    if (asRequest) {
      r = { id: nextId(h.requests, 'RQ'), text: text, status: 'queued', result: null, links: [], message_id: u.id, requested_by: me.id, requested_by_name: me.name,
        fire_note: 'Demo mode: nothing was sent. Messages reach Claude once the portal is connected.', created_at: t, sample: true };
      h.requests.unshift(r);
    }
    saveH();
    return Promise.resolve({ demo: true, messages: [u, a], request: r, fired: false });
  }
  function nextId(list, prefix) {
    var n = list.reduce(function (m, r) { var x = new RegExp('^' + prefix + '-(\\d+)$').exec(r.id); return x ? Math.max(m, +x[1]) : m; }, 0) + 1;
    return prefix + '-' + String(n).padStart(4, '0');
  }
  return {
    mode: 'local',
    password: function () { return (window.BRP_ADMIN_DEMO && window.BRP_ADMIN_DEMO.password) || PW; },
    prepare: demo,
    signIn: function (email, pw) {
      return demo().then(function () {
        email = String(email || '').trim().toLowerCase();
        var p = adb().profiles.filter(function (x) { return x.email === email; })[0];
        if (!p || pw !== (window.BRP_ADMIN_DEMO.password || PW)) throw new Error('That email and password do not match a demo account.');
        if (!p.active) throw new Error('This account is turned off. Reset the demo data in the admin console to turn it back on.');
        var m = toMe(p);
        if (!m.hq_role) throw new Error('Refused. Command is for the owner, admins, the partner and site leads. ' + p.email + ' is not one of those.');
        me = m; sess(SKEY, p.email); if (p.role === 'admin') sess(ASKEY, p.email);
        return me;
      });
    },
    restore: function () {
      return demo().then(function () {
        var e = sess(SKEY), p = e ? adb().profiles.filter(function (x) { return x.email === e && x.active; })[0] : null;
        me = p ? toMe(p) : null; if (me && !me.hq_role) me = null;
        return me;
      });
    },
    signOut: function () { me = null; sess(SKEY, null); sess(ASKEY, null); return Promise.resolve(); },
    load: function () {
      A = null; adb();
      var h = hdb(), P = A.agent_proposals;
      var inst = me.hq_role === 'site_lead' ? me.inst : null;
      var mine = function (r) { return !inst || r.inst === inst; };
      var biz = me.hq_role !== 'partner';
      var dec = h.decisions.filter(sees).concat(P.map(proposalDecision).filter(sees));
      return Promise.resolve({
        tasks: h.tasks.filter(sees), decisions: dec, agents: h.agents.slice(), settings: A.agent_settings.slice(), systems: h.systems.slice(),
        documents: h.documents.filter(sees), requests: h.requests.filter(function (r) { return me.hq_role === 'owner' || r.requested_by === me.id; }),
        messages: SAMPLE_CHAT.concat(h.messages.filter(function (m) { return m.thread_owner === me.id; })), saved: h.saved || {},
        rooms: biz ? A.rooms.filter(mine) : [], work_orders: biz ? A.work_orders.filter(mine) : [], purchase_orders: biz ? A.purchase_orders.filter(mine) : [],
        purchase_list: biz ? A.purchase_list.filter(mine) : []
      });
    },
    setTask: function (id, patch) {
      var t = hdb().tasks.filter(function (x) { return x.id === id; })[0];
      if (!t || !sees(t)) return Promise.reject(new Error('You cannot change that task.'));
      if (me.hq_role !== 'owner' && Object.keys(patch).some(function (k) { return ['status', 'next', 'note'].indexOf(k) < 0; })) return Promise.reject(new Error('You can change status, next step and note.'));
      if (me.hq_role === 'partner' && t.owner !== me.party) return Promise.reject(new Error('You can change Rynoc tasks only.'));
      Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
      if (patch.status) t.done_at = patch.status === 'done' ? nowIso() : null;
      t.updated_at = nowIso(); saveH(); return Promise.resolve(clone(t));
    },
    addTask: function (row) {
      if (!(me.hq_role === 'owner' || (me.hq_role === 'partner' && row.owner === me.party))) return Promise.reject(new Error(me.hq_role === 'partner' ? 'You can add Rynoc tasks only.' : 'Only the owner adds tasks.'));
      var t = Object.assign({ id: nextId(H.tasks, 'HT'), desk: '', area: '', status: 'not_started', due: '', sort_date: null, next: '', note: '', inst: null, shared: false, source: 'hq', sample: true, created_at: nowIso() }, row);
      hdb().tasks.push(t); saveH(); return Promise.resolve(clone(t));
    },
    addDecision: function (row) {
      if (me.hq_role !== 'owner') return Promise.reject(new Error('Only the owner adds decisions.'));
      var d = Object.assign({ id: nextId(hdb().decisions, 'HD'), kind: 'question', context: '', recommended: null, owner: 'Andrew', answer: null, answer_index: null, answered_at: null, sort_date: todayIso(), shared: false, source: 'chat', sample: true }, row);
      H.decisions.push(d); saveH(); return Promise.resolve(clone(d));
    },
    addDocument: function (row) {
      if (me.hq_role !== 'owner') return Promise.reject(new Error('Only the owner adds documents.'));
      var d = Object.assign({ id: nextId(hdb().documents, 'DOC'), area: '', note: '', owner: 'Andrew', shared: false, inst: null, sort: 99, sample: true }, row);
      H.documents.push(d); saveH(); return Promise.resolve(clone(d));
    },
    decide: function (id, idx, note) {
      note = String(note || '').trim();
      if (/^HD-AP-/.test(id)) {
        var pid = id.slice(3), p = adb().agent_proposals.filter(function (x) { return x.id === pid; })[0];
        if (!p) return Promise.reject(new Error('No proposal ' + pid));
        if (me.role !== 'admin') return Promise.reject(new Error('Only an Admin decides agent proposals.'));
        if (me.demo && !p.sample) return Promise.reject(new Error('A demo account can decide sample proposals only.'));
        if (p.status !== 'proposed') return Promise.reject(new Error('Proposal ' + pid + ' was already ' + p.status + '.'));
        if (idx === 1 && !note) return Promise.reject(new Error('Say why you rejected it.'));
        var old = { status: p.status };
        p.status = idx === 0 ? 'approved' : 'rejected'; p.decided_by = me.id; p.decided_by_email = me.email; p.decided_at = nowIso(); p.decision_note = note || null;
        audit('update', 'agent_proposals', pid, old, { status: p.status, decided_by_email: me.email, decision_note: p.decision_note }); saveA();
        return Promise.resolve(proposalDecision(p));
      }
      var d = hdb().decisions.filter(function (x) { return x.id === id; })[0];
      if (!d || !sees(d)) return Promise.reject(new Error('No decision ' + id));
      if (!(me.hq_role === 'owner' || (me.hq_role === 'partner' && d.owner === me.party))) return Promise.reject(new Error('Only the owner answers this decision.'));
      if (!(idx >= 0 && idx < d.options.length)) return Promise.reject(new Error('Choose one of the options.'));
      d.answer = d.options[idx]; d.answer_index = idx; d.answer_note = note || null; d.answered_at = nowIso(); d.answered_by_email = me.email;
      saveH(); return Promise.resolve(clone(d));
    },
    chat: function (text) { return demoTurn(text, 'Demo mode: Claude replies once the portal is connected. Quick answers start then too. Your message is kept in this browser only.', false); },
    send: function (text) { return demoTurn(text, 'Demo mode: Claude replies once the portal is connected. Nothing was sent; your message is kept in this browser only.', true); },
    sendRequest: function (text) { return demoTurn(text, 'Demo mode: Claude replies once the portal is connected. Nothing was sent.', true); },
    markSaved: function (key) { hdb().saved = H.saved || {}; H.saved[key] = true; saveH(); }
  };
}

/* =====================================================================
   Server data layer (Supabase, row-level security)
   ===================================================================== */
function remoteApi() {
  var me = null, saved = {};
  function c() { return BE.client(); }
  function rows(q) { return q.then(function (r) { if (r.error) throw new Error(r.error.message); return r.data || []; }); }
  function rpc(name, args) { return c().then(function (k) { return k.rpc(name, args || {}); }).then(function (r) { if (r.error) throw new Error(r.error.message); return r.data; }); }
  function invoke(body) {
    return c().then(function (k) { return k.functions.invoke('hq-chat', { body: body }); }).then(function (r) {
      if (!r.error) return r.data;
      var ctx = r.error.context;
      return (ctx && ctx.json ? ctx.json().catch(function () { return {}; }) : Promise.resolve({})).then(function (j) { throw new Error((j && j.error) || r.error.message || 'Claude did not answer.'); });
    });
  }
  return {
    mode: 'remote',
    password: function () { return PW; },
    prepare: function () { return Promise.resolve(); },
    signIn: function (email, pw) {
      return BE.signIn(email, pw).then(function () { return rpc('hq_whoami'); }).then(function (m) {
        if (!m || !m.hq_role) return BE.signOut().then(function () { throw new Error('Refused. Command is for the owner, admins, the partner and site leads.'); });
        me = m; return me;
      });
    },
    restore: function () { return BE.session().then(function (s) { return s ? rpc('hq_whoami') : null; }).then(function (m) { me = m && m.active && m.hq_role ? m : null; return me; }); },
    signOut: function () { me = null; return BE.signOut(); },
    load: function () {
      var biz = me.hq_role !== 'partner', none = Promise.resolve([]);
      return Promise.all([
        rows(BE.from('hq_tasks').select('*').order('sort_date', { ascending: true, nullsFirst: false })),
        rows(BE.from('hq_decisions').select('*').order('sort_date', { ascending: true })),
        rows(BE.from('hq_agent_levels').select('*').order('sort')),
        rows(BE.from('agent_settings').select('*')).catch(function () { return []; }),
        rows(BE.from('hq_systems').select('*').order('sort')),
        rows(BE.from('hq_documents').select('*').order('sort')),
        rows(BE.from('hq_requests').select('*').order('created_at', { ascending: false }).limit(100)),
        rows(BE.from('hq_messages').select('*').eq('thread_owner', me.id).eq('thread', 'main').order('created_at', { ascending: true }).limit(300)),
        rows(BE.from('agent_proposals').select('*')).catch(function () { return []; }),
        biz ? rows(BE.from('rooms').select('id,inst,bldg,room,occupancy,status,offline_reason,sensor_rh,sensor_temp_f')) : none,
        biz ? rows(BE.from('work_orders').select('id,inst,status')) : none,
        biz ? rows(BE.from('purchase_orders').select('id,inst,status,total')) : none,
        biz ? rows(BE.from('purchase_list').select('id,inst,status')).catch(function () { return []; }) : none
      ]).then(function (r) {
        var P = {}; r[8].forEach(function (p) { P[p.id] = p; });
        r[1].forEach(function (d) { if (d.proposal_id) d.proposal = P[d.proposal_id] || null; });
        return { tasks: r[0], decisions: r[1], agents: r[2], settings: r[3], systems: r[4], documents: r[5], requests: r[6], messages: r[7], saved: saved,
          rooms: r[9], work_orders: r[10], purchase_orders: r[11], purchase_list: r[12] };
      });
    },
    setTask: function (id, patch) { return rows(BE.from('hq_tasks').update(patch).eq('id', id).select()).then(function (d) { if (!d.length) throw new Error('The server did not change that task. Your role may not allow it.'); return d[0]; }); },
    addTask: function (row) { return rows(BE.from('hq_tasks').insert(row).select()).then(function (d) { return d[0]; }); },
    addDecision: function (row) { return rows(BE.from('hq_decisions').insert(Object.assign({ source: 'chat' }, row)).select()).then(function (d) { return d[0]; }); },
    addDocument: function (row) { return rows(BE.from('hq_documents').insert(row).select()).then(function (d) { return d[0]; }); },
    decide: function (id, idx, note) { return rpc('hq_decide', { p_id: id, p_choice: idx, p_note: note || null }); },
    chat: function (text) { return invoke({ action: 'chat', thread: 'main', message: text }); },
    /* The default route: the message goes to Claude in the BRP Command thread. One hq_messages row (role user), one hq_requests
       row linked to it, then hq-chat starts the Claude Code routine when its secrets are set. Claude's reply comes back as an
       assistant row in hq_messages, written through the Supabase connector. */
    send: function (text) {
      return rows(BE.from('hq_messages').insert({ thread: 'main', role: 'user', content: text }).select('id')).then(function (m) {
        return rows(BE.from('hq_requests').insert({ text: text, thread: 'main', message_id: m[0].id }).select());
      }).then(function (d) {
        return invoke({ action: 'send_request', id: d[0].id }).catch(function (e) { return { request: Object.assign(d[0], { fire_note: e.message }), fired: false }; });
      });
    },
    sendRequest: function (text) { return this.send(text); },
    markSaved: function (key) { saved[key] = true; }
  };
}

var api = LOCAL ? localApi() : remoteApi();

/* =====================================================================
   Sign in
   ===================================================================== */
var ME = null, DATA = null;
var ACCTS = [['owner@brp.demo', 'Owner (Andrew)'], ['partner@brp.demo', 'Rynoc partner'], ['sitelead@brp.demo', 'Site lead, Fort Stewart'], ['admin@brp.demo', 'Admin (full access)']];
$('g-mode').innerHTML = LOCAL
  ? '<b>Demo mode.</b> No server is connected, so HQ runs on sample data kept in this browser. Claude replies once the portal is connected.'
  : '<b>Live.</b> Signed in against the BRP backend. Your role is checked on the server.';
$('g-chip').textContent = LOCAL ? 'Demo mode' : 'Live';
$('g-demo-pw').textContent = PW;
$('g-list').innerHTML = ACCTS.map(function (a) { return '<li><button type="button" data-email="' + a[0] + '"><code>' + a[0] + '</code><span>' + a[1] + '</span></button></li>'; }).join('');
$('g-list').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-email]'); if (!b) return;
  $('g-email').value = b.getAttribute('data-email'); $('g-pw').value = api.password(); $('g-form').requestSubmit();
});
$('g-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var em = $('g-email').value, pw = $('g-pw').value, err = $('g-err');
  err.textContent = '';
  if (!em || !pw) { err.textContent = 'Enter your email and password.'; return; }
  $('g-submit').disabled = true;
  api.signIn(em, pw).then(function (m) { ME = m; $('g-pw').value = ''; return openApp(); })
    .catch(function (x) { err.textContent = (x && x.message) || 'Sign in failed.'; })
    .then(function () { $('g-submit').disabled = false; });
});

/* =====================================================================
   Shell: navigation, theme, sheets
   ===================================================================== */
var ICON = {
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>', tasks: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>',
  decisions: '<path d="M12 3v18M5 8l7-5 7 5M5 8v4h14V8"/>', agents: '<rect x="5" y="7" width="14" height="11"/><path d="M9 12h.01M15 12h.01M12 3v4"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>', link: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>'
};
var SECTIONS = [['home', 'Home'], ['tasks', 'Tasks'], ['decisions', 'Decisions'], ['agents', 'Agents'], ['erp', 'Purchasing'], ['rooms', 'Rooms'], ['systems', 'Systems'], ['docs', 'Documents'], ['ask', 'Claude']];
function allowed(id) {
  if (!ME) return false;
  if (ME.hq_role === 'partner') return ['erp', 'rooms'].indexOf(id) < 0;
  if (ME.hq_role === 'site_lead') return id !== 'erp';
  return true;
}
var ROUTE = 'home', VIEW = { owner: 'Andrew', showDone: false, open: {}, reopen: {} };
function svg(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>'; }
function counts() {
  var d = DATA || { decisions: [] };
  var open = d.decisions.filter(function (x) { return !x.answered_at && x.kind !== 'agent_proposal'; }).length;
  var props = d.decisions.filter(function (x) { return !x.answered_at && x.kind === 'agent_proposal'; }).length;
  return { decisions: open, agents: props };
}
function navHtml() {
  var n = counts();
  var badge = function (id) { return n[id] ? '<span class="badge" aria-label="' + n[id] + ' waiting">' + n[id] + '</span>' : ''; };
  $('side').innerHTML = SECTIONS.filter(function (s) { return allowed(s[0]); }).map(function (s, i) {
    return (s[0] === 'ask' ? '<div class="sep" role="presentation"></div>' : '') + '<button type="button" data-go="' + s[0] + '"' + (ROUTE === s[0] ? ' aria-current="page"' : '') + '><span>' + s[1] + '</span>' + badge(s[0]) + '</button>';
  }).join('');
  var inMore = ['erp', 'rooms', 'systems', 'docs', 'ask'].indexOf(ROUTE) >= 0;
  $('bnav').innerHTML = [['home', 'Home'], ['tasks', 'Tasks'], ['decisions', 'Decide'], ['agents', 'Agents'], ['more', 'More']].map(function (s) {
    var cur = s[0] === 'more' ? inMore : ROUTE === s[0];
    return '<button type="button" ' + (s[0] === 'more' ? 'id="more-btn" aria-haspopup="dialog" aria-controls="more-sheet"' : 'data-go="' + s[0] + '"') + (cur ? ' aria-current="page"' : '') + '>' + svg(s[0]) + s[1] + badge(s[0]) + '</button>';
  }).join('');
  $('more-list').innerHTML = SECTIONS.filter(function (s) { return ['erp', 'rooms', 'systems', 'docs', 'ask'].indexOf(s[0]) >= 0 && allowed(s[0]); }).map(function (s) {
    return '<button type="button" data-go="' + s[0] + '"><span>' + s[1] + '</span><span aria-hidden="true">›</span></button>';
  }).join('') + '<button type="button" id="more-theme"><span>Theme</span><span id="more-theme-v">' + themeLabel() + '</span></button><button type="button" id="more-out"><span>Sign out</span></button>';
}
function go(r) {
  if (!allowed(r)) r = 'home';
  ROUTE = r; closeSheets();
  if (location.hash.slice(1) !== r) { try { history.replaceState(null, '', '#' + r); } catch (e) { location.hash = r; } }
  render(); window.scrollTo(0, 0); $('main').focus({ preventScroll: true });
}
function themeLabel() { var t = document.documentElement.getAttribute('data-theme'); return t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Auto'; }
function cycleTheme() {
  var t = document.documentElement.getAttribute('data-theme'), n = !t ? 'light' : t === 'light' ? 'dark' : null;
  if (n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme');
  try { if (n) localStorage.setItem('brp-hq-theme', n); else localStorage.removeItem('brp-hq-theme'); } catch (e) { /* ok */ }
  $('theme').textContent = themeLabel(); $('theme').setAttribute('aria-label', 'Theme: ' + themeLabel().toLowerCase() + '. Change theme');
  var v = $('more-theme-v'); if (v) v.textContent = themeLabel();
}
var lastFocus = null;
function openSheet(id) {
  lastFocus = document.activeElement;
  $('scrim').hidden = false; $(id).hidden = false;
  if (id === 'chat-sheet') { mountChat($('chat-dock')); setTimeout(function () { $('chat-in').focus(); scrollChat(); }, 30); }
  else { var b = $(id).querySelector('button'); if (b) b.focus(); }
}
function closeSheets() {
  var was = !$('scrim').hidden;
  $('scrim').hidden = true; $('more-sheet').hidden = true; $('chat-sheet').hidden = true;
  if (was && lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('scrim').hidden) closeSheets(); });
$('scrim').addEventListener('click', closeSheets);
document.addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  if (b.hasAttribute('data-close')) return closeSheets();
  if (b.hasAttribute('data-go') && (b.closest('#side') || b.closest('#bnav') || b.closest('#more-list') || b.closest('#main'))) { e.preventDefault(); return go(b.getAttribute('data-go')); }
  if (b.id === 'more-btn') return openSheet('more-sheet');
  if (b.id === 'more-theme') return cycleTheme();
  if (b.id === 'more-out' || b.id === 'signout') return signOut();
  if (b.id === 'theme') return cycleTheme();
  if (b.id === 'fab') return openSheet('chat-sheet');
});
window.addEventListener('hashchange', function () { var r = location.hash.slice(1); if (ME && r && r !== ROUTE && SECTIONS.some(function (s) { return s[0] === r; })) go(r); });
function signOut() { return api.signOut().then(function () { ME = null; DATA = null; closeSheets(); $('app').hidden = true; $('gate').hidden = false; $('g-err').textContent = ''; $('g-email').focus(); }); }

function openApp() {
  $('gate').hidden = true; $('app').hidden = false;
  $('who').textContent = ME.name + ' · ' + (ROLE_LABEL[ME.hq_role] || '') + (ME.hq_role === 'site_lead' && ME.inst ? ' ' + ME.inst : '');
  $('mode-chip').textContent = LOCAL ? 'Demo mode' : 'Live'; $('mode-chip').className = 'mode' + (LOCAL ? '' : ' live');
  $('theme').textContent = themeLabel();
  var r = location.hash.slice(1);
  ROUTE = SECTIONS.some(function (s) { return s[0] === r; }) && allowed(r) ? r : 'home';
  VIEW.owner = ME.hq_role === 'partner' ? 'Rynoc' : ME.hq_role === 'site_lead' ? 'all' : 'Andrew';
  return reload();
}
function reload() {
  return api.load().then(function (d) { DATA = d; render(); }).catch(function (e) { $('main').innerHTML = head('Could not load', esc((e && e.message) || 'The server refused the request.')); });
}

/* =====================================================================
   Views
   ===================================================================== */
function head(title, text, label) {
  return '<div class="head"><div class="rule" aria-hidden="true"></div><span class="lbl">' + esc(label || ('Command' + (LOCAL ? ' · Demo mode' : ''))) + '</span><h1>' + esc(title) + '</h1>' + (text ? '<p>' + text + '</p>' : '') + '</div>';
}
function demoBanner() { return LOCAL ? '<p class="banner" role="note"><b>Demo mode</b>Sample data in this browser. Tasks, decisions, agents and systems are copied from the Command Center as of Oct 13. Changes stay on this device.</p>' : ''; }
function sampleTag(r) { return r && r.sample && !LOCAL ? ' <span class="tag sample">Sample</span>' : ''; }
function dueText(t) {
  var d = days(t.sort_date), lab = t.due || (t.sort_date ? fdate(t.sort_date) : '');
  if (t.status === 'done') return t.done_at ? 'Done ' + fdate(String(t.done_at).slice(0, 10)) : 'Done';
  if (d != null && d < 0 && /^[A-Z][a-z]{2} \d/.test(lab)) return lab + ' (overdue)';
  return lab;
}
function statusDot(s) { return '<span class="dot ' + (STATUS_DOT[s] || '') + '">' + esc(STATUS[s] || s) + '</span>'; }
function canEditTask(t) { return ME.hq_role === 'owner' || (ME.hq_role === 'partner' && t.owner === ME.party) || (ME.hq_role === 'site_lead' && t.inst === ME.inst); }
function taskCard(t) {
  var open = !!VIEW.open[t.id], ed = canEditTask(t), done = t.status === 'done';
  return '<article class="task' + (done ? ' done' : '') + '" data-task="' + esc(t.id) + '">' +
    (ed ? '<button class="t-check" type="button" data-act="done" data-id="' + esc(t.id) + '" aria-pressed="' + done + '" aria-label="' + (done ? 'Mark not done: ' : 'Mark done: ') + esc(t.item) + '"><span></span></button>' : '<span class="t-check" aria-hidden="true"><span></span></span>') +
    '<div class="t-body"><span class="t-item">' + esc(t.item) + sampleTag(t) + '</span>' +
    '<span class="row small">' + statusDot(t.status) + (t.area ? '<span class="muted">' + esc(t.area) + '</span>' : '') + (dueText(t) ? '<span class="muted">Due ' + esc(dueText(t)) + '</span>' : '') +
    (VIEW.owner === 'all' || ROUTE === 'home' ? '<span class="tag">' + esc(t.owner) + '</span>' : '') + (t.inst ? '<span class="tag">' + esc(t.inst) + '</span>' : '') + '</span>' +
    (t.next ? '<span class="t-next">Next: ' + esc(t.next) + '</span>' : '') + (t.note && !open ? '<span class="t-next">Note: ' + esc(t.note) + '</span>' : '') +
    (ed ? '<button class="t-toggle" type="button" data-act="open" data-id="' + esc(t.id) + '" aria-expanded="' + open + '">' + (open ? 'Close' : 'Status and notes') + '</button>' : '') + '</div>' +
    (open && ed ? '<form class="t-more" data-taskform="' + esc(t.id) + '">' +
      '<div class="field"><label class="lbl" for="ts-' + esc(t.id) + '">Status</label><select class="in" id="ts-' + esc(t.id) + '" name="status">' +
        Object.keys(STATUS).map(function (s) { return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + STATUS[s] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label class="lbl" for="tn-' + esc(t.id) + '">Next step</label><input class="in" id="tn-' + esc(t.id) + '" name="next" value="' + esc(t.next) + '"></div>' +
      '<div class="field"><label class="lbl" for="tt-' + esc(t.id) + '">Note</label><textarea class="in" id="tt-' + esc(t.id) + '" name="note" rows="3">' + esc(t.note || '') + '</textarea></div>' +
      '<div class="row"><button class="btn pri" type="submit">Save</button><button class="btn quiet" type="button" data-act="open" data-id="' + esc(t.id) + '">Cancel</button></div></form>' : '') +
    '</article>';
}
function canAnswer(d) {
  if (d.kind === 'agent_proposal') return ME.role === 'admin';
  return ME.hq_role === 'owner' || (ME.hq_role === 'partner' && d.owner === ME.party);
}
function decisionCard(d) {
  var p = d.kind === 'agent_proposal' ? d.proposal : null, answered = !!d.answered_at && !VIEW.reopen[d.id];
  var h = '<article class="card' + (answered ? '' : ' need') + '" data-decision="' + esc(d.id) + '">';
  if (p) {
    h += '<div class="meta"><span class="lbl">' + esc(AS.labels[p.agent] || p.agent) + '</span><span>' + esc(p.inst) + '</span><span>' + esc(String(p.kind).replace(/_/g, ' ')) + '</span><span>' + esc(p.id) + '</span>' +
      (p.sample ? '<span class="tag sample">Sample</span>' : '') + (p.flags || []).map(function (f) { return '<span class="tag crit">' + esc(AS.flags[f] || f) + '</span>'; }).join('') +
      (p.approver_required ? '<span class="tag">Needs ' + (p.approver_required === 'site_lead' ? 'site lead' : 'program manager') + '</span>' : '') + '</div>' +
      '<p class="ctx">' + esc(p.rationale) + '</p>' + ((p.cited_ids || []).length ? '<p class="small muted">Cites ' + esc(p.cited_ids.join(', ')) + '</p>' : '') +
      (p.payload && p.payload.total != null ? '<p class="small">Order total ' + esc(money(p.payload.total)) + '</p>' : '');
  } else {
    h += '<p class="q">' + esc(d.question) + sampleTag(d) + '</p>' + (d.context ? '<p class="ctx">' + esc(d.context) + '</p>' : '') +
      '<div class="meta">' + (d.sort_date ? '<span>By ' + esc(fdate(d.sort_date)) + '</span>' : '') + (d.owner !== 'Andrew' ? '<span class="tag">' + esc(d.owner) + '</span>' : '') + '</div>';
  }
  if (answered) {
    h += '<p class="answered">' + (p ? (d.answer_index === 0 ? 'Approved' : 'Rejected') : 'Answered: ' + esc(d.answer)) + (d.answered_by_email ? ' · ' + esc(d.answered_by_email) : '') + (d.answered_at ? ' · ' + esc(ftime(d.answered_at)) : '') + '</p>' +
      (d.answer_note ? '<p class="small muted">' + esc(d.answer_note) + '</p>' : '') +
      (!p && canAnswer(d) ? '<div class="row"><button class="btn quiet" type="button" data-act="reopen" data-id="' + esc(d.id) + '">Change answer</button></div>' : '');
  } else if (canAnswer(d)) {
    h += '<div class="opts" role="group" aria-label="Answers">' + d.options.map(function (o, i) {
      return '<button class="btn' + (d.recommended === i ? ' rec' : '') + (p && i === 0 ? ' pri' : '') + '" type="button" data-act="answer" data-id="' + esc(d.id) + '" data-i="' + i + '">' + esc(o) + (d.recommended === i ? '<small>Recommended</small>' : '') + '</button>';
    }).join('') + '</div>' + (p ? '<p class="small muted">Approve means you agree. Nothing is executed.' + (p.approver_required ? ' The order still needs the ' + (p.approver_required === 'site_lead' ? 'site lead' : 'program manager') + '\'s approval task.' : '') + '</p>' : '');
  } else {
    h += '<p class="small muted">' + (p ? 'Waiting for an Admin.' : 'Waiting for ' + esc(d.owner) + '.') + '</p>';
  }
  return h + '</article>';
}
function list(items, fn, empty) { return items.length ? '<div class="cards">' + items.map(fn).join('') + '</div>' : '<p class="empty">' + esc(empty) + '</p>'; }
function sortDue(a, b) { return String(a.sort_date || '9999').localeCompare(String(b.sort_date || '9999')); }
function numbers() {
  var d = DATA, mineTasks = d.tasks.filter(function (t) { return t.owner === (ME.party || 'Andrew') && t.status !== 'done'; });
  return {
    decisions: d.decisions.filter(function (x) { return !x.answered_at && x.kind !== 'agent_proposal'; }).length,
    proposals: d.decisions.filter(function (x) { return !x.answered_at && x.kind === 'agent_proposal'; }).length,
    myTasks: mineTasks.length,
    atRisk: d.tasks.filter(function (t) { return t.status === 'at_risk'; }).length,
    wo: d.work_orders.filter(function (w) { return w.status !== 'closed'; }).length,
    roomsDown: d.rooms.filter(function (r) { return r.status === 'offline' || r.status === 'action'; }).length,
    po: d.purchase_orders.filter(function (p) { return ['requested', 'issued', 'shipped', 'backordered'].indexOf(p.status) >= 0; }).length,
    requests: d.requests.filter(function (r) { return r.status !== 'done'; }).length
  };
}
function stat(go, n, label, hot) { return '<button class="stat' + (hot && n ? ' hot' : '') + '" type="button" data-go="' + go + '"><b>' + n + '</b><small>' + esc(label) + '</small></button>'; }

var VIEWS = {
  home: function () {
    var d = DATA, n = numbers(), party = ME.party || 'Andrew';
    var open = d.decisions.filter(function (x) { return !x.answered_at && x.kind !== 'agent_proposal'; }).sort(sortDue);
    var props = d.decisions.filter(function (x) { return !x.answered_at && x.kind === 'agent_proposal'; });
    var soon = d.tasks.filter(function (t) {
      if (t.status === 'done') return false;
      if (ME.hq_role === 'site_lead') return true;
      if (t.owner !== party) return false;
      var k = days(t.sort_date); return t.status === 'at_risk' || (k != null && k <= 7);
    }).sort(sortDue);
    var biz = ME.hq_role !== 'partner';
    return head('Needs you', ME.hq_role === 'owner' ? 'Open decisions, agent proposals and your tasks due in the next 7 days.' : ME.hq_role === 'partner' ? 'Your Rynoc tasks and anything shared with you.' : 'Fort Stewart items for you.', 'Command · ' + (ROLE_LABEL[ME.hq_role] || '')) + demoBanner() +
      '<div class="stats" aria-label="Key numbers">' + stat('decisions', n.decisions, 'Open decisions', 1) + stat('agents', n.proposals, 'Agent proposals waiting', 1) + stat('tasks', n.myTasks, (ME.hq_role === 'site_lead' ? 'Open tasks' : party + ' tasks open')) + stat('tasks', n.atRisk, 'Tasks at risk', 1) +
        (biz ? stat(ME.hq_role === 'owner' ? 'erp' : 'rooms', n.wo, 'Open work orders') + stat('rooms', n.roomsDown, 'Rooms offline or action', 1) + (ME.hq_role === 'owner' ? stat('erp', n.po, 'Purchase orders open') : '') : '') +
        stat('ask', n.requests, 'Waiting on Claude') + '</div>' +
      (open.length || ME.hq_role === 'owner' ? '<section class="sec" aria-labelledby="h-dec"><div class="sec-h"><h2 id="h-dec">Decisions</h2>' + (open.length > 3 ? '<button class="btn quiet" type="button" data-go="decisions">All ' + open.length + '</button>' : '') + '</div>' + list(open.slice(0, 3), decisionCard, 'No open decisions.') + '</section>' : '') +
      (props.length || ME.hq_role === 'owner' ? '<section class="sec" aria-labelledby="h-prop"><div class="sec-h"><h2 id="h-prop">Agent proposals</h2>' + (props.length > 2 ? '<button class="btn quiet" type="button" data-go="agents">All ' + props.length + '</button>' : '') + '</div>' + list(props.slice(0, 2), decisionCard, 'Nothing waiting from the agents.') + '</section>' : '') +
      '<section class="sec" aria-labelledby="h-soon"><div class="sec-h"><h2 id="h-soon">' + (ME.hq_role === 'site_lead' ? 'Your tasks' : 'Due soon') + '</h2><button class="btn quiet" type="button" data-go="tasks">All tasks</button></div>' + list(soon.slice(0, 8), taskCard, 'Nothing due in the next 7 days.') + '</section>' +
      (d.requests.filter(function (r) { return r.status !== 'done'; }).length ? '<section class="sec" aria-labelledby="h-rq"><div class="sec-h"><h2 id="h-rq">Waiting on Claude</h2></div>' + reqList(d.requests.filter(function (r) { return r.status !== 'done'; }).slice(0, 3)) + '</section>' : '') +
      '<p class="foot">' + (LOCAL ? 'Demo mode. Sample data in this browser only.' : 'Live. Every change is checked by row-level security.') + '</p>';
  },
  tasks: function () {
    var d = DATA, owners = ['all'].concat(OWNERS.filter(function (o) { return d.tasks.some(function (t) { return t.owner === o; }); }));
    if (owners.indexOf(VIEW.owner) < 0) VIEW.owner = 'all';
    var shown = d.tasks.filter(function (t) { return (VIEW.owner === 'all' || t.owner === VIEW.owner) && (VIEW.showDone || t.status !== 'done'); });
    var groups = VIEW.owner === 'all' ? OWNERS.filter(function (o) { return shown.some(function (t) { return t.owner === o; }); }) : [VIEW.owner];
    var cnt = function (o) { return d.tasks.filter(function (t) { return (o === 'all' || t.owner === o) && t.status !== 'done'; }).length; };
    var canAdd = ME.hq_role === 'owner' || ME.hq_role === 'partner';
    return head('Tasks', 'By owner. Tap the box to mark a task done. Open Status and notes to change the status or add a note.') + demoBanner() +
      '<div class="chips" role="group" aria-label="Owner">' + owners.map(function (o) { return '<button class="chip" type="button" data-owner="' + o + '" aria-pressed="' + (VIEW.owner === o) + '">' + (o === 'all' ? 'All' : esc(o)) + ' <span class="n">' + cnt(o) + '</span></button>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:10px"><button class="btn quiet" type="button" data-act="showdone" aria-pressed="' + VIEW.showDone + '">' + (VIEW.showDone ? 'Hide done' : 'Show done') + '</button>' + (canAdd ? '<button class="btn pri" type="button" data-act="addtask">Add task</button>' : '') + '</div>' +
      (groups.length ? groups.map(function (o) {
        var ts = shown.filter(function (t) { return t.owner === o; }).sort(sortDue);
        return '<section class="sec" aria-label="' + esc(o) + ' tasks"><div class="owner-h"><h3>' + esc(o) + '</h3><span class="small muted">' + ts.length + '</span></div>' + list(ts, taskCard, 'No tasks.') + '</section>';
      }).join('') : '<p class="empty" style="margin-top:16px">No open tasks here.</p>');
  },
  decisions: function () {
    var d = DATA.decisions.filter(function (x) { return x.kind !== 'agent_proposal'; });
    var open = d.filter(function (x) { return !x.answered_at || VIEW.reopen[x.id]; }).sort(sortDue), done = d.filter(function (x) { return x.answered_at && !VIEW.reopen[x.id]; });
    return head('Decisions', 'One tap answers. The recommended answer is marked. You can change an answer later.') + demoBanner() +
      (ME.hq_role === 'owner' ? '<div class="row"><button class="btn pri" type="button" data-act="adddec">Add decision</button></div>' : '') +
      '<section class="sec" aria-labelledby="h-open"><div class="sec-h"><h2 id="h-open">Open</h2><span class="small muted">' + open.length + '</span></div>' + list(open, decisionCard, 'No open decisions.') + '</section>' +
      '<section class="sec" aria-labelledby="h-done"><div class="sec-h"><h2 id="h-done">Answered</h2><span class="small muted">' + done.length + '</span></div>' + list(done, decisionCard, 'Nothing answered yet.') + '</section>';
  },
  agents: function () {
    var props = DATA.decisions.filter(function (x) { return x.kind === 'agent_proposal'; });
    var wait = props.filter(function (x) { return !x.answered_at; }), past = props.filter(function (x) { return x.answered_at; });
    var yes = past.filter(function (x) { return x.answer_index === 0; }).length;
    var MODE = { off: 'Off', shadow: 'Shadow (proposes only)', supervised: 'Supervised', live: 'Live' };
    return head('Agents', 'The readiness ladder runs from level 0 (idea) to level 6 (live). The operations agents run in shadow mode: they propose, you decide. <b>Approve means you agree. Nothing is executed.</b>') + demoBanner() +
      '<section class="sec" aria-labelledby="h-wait"><div class="sec-h"><h2 id="h-wait">Proposals waiting</h2><span class="small muted">Agreement rate ' + (past.length ? Math.round(100 * yes / past.length) + '%' : 'none yet') + '</span></div>' +
        list(wait, decisionCard, 'Nothing waiting.') + '</section>' +
      '<section class="sec" aria-labelledby="h-lad"><div class="sec-h"><h2 id="h-lad">Readiness ladder</h2></div><div class="cards two">' + DATA.agents.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); }).map(function (a) {
        var lv = ''; for (var i = 1; i <= 6; i++) lv += '<i class="' + (i <= a.level ? 'on' + (i === a.level ? ' top' : '') : '') + '"></i>';
        var s = DATA.settings.filter(function (x) { return x.agent === a.agent && x.inst === '*'; })[0];
        return '<article class="card"><div class="sec-h"><p class="q">' + esc(a.name) + '</p><span class="lbl">Level ' + a.level + ' of 6</span></div><div class="ladder" role="img" aria-label="Level ' + a.level + ' of 6">' + lv + '</div>' +
          '<p class="small"><b>Mode:</b> ' + esc(a.mode) + (s ? ' · Server setting: ' + esc(MODE[s.mode] || s.mode) : '') + '</p><p class="small muted"><b>Evidence:</b> ' + esc(a.evidence) + '</p><p class="small"><b>Next:</b> ' + esc(a.next) + '</p></article>';
      }).join('') + '</div></section>' +
      '<section class="sec" aria-labelledby="h-past"><div class="sec-h"><h2 id="h-past">Decided</h2><span class="small muted">' + past.length + '</span></div>' + list(past, decisionCard, 'No decisions yet.') + '</section>' +
      (ME.role === 'admin' ? '<p class="foot">Change an agent\'s mode in the <a href="../client/admin.html" target="_blank" rel="noopener">admin console</a>, Agent proposals tab.</p>' : '');
  },
  erp: function () {
    var n = numbers();
    return head('Purchasing', 'Purchase orders, the purchase list, stock, parts and work orders. This is the admin console\'s own view, inside HQ.') + demoBanner() +
      '<div class="stats" aria-label="Purchasing numbers">' + stat('erp', n.po, 'Purchase orders open') + stat('erp', DATA.purchase_list.filter(function (p) { return ['requested', 'approved', 'not_ordered'].indexOf(p.status) >= 0; }).length, 'Purchase list open') +
        stat('erp', n.wo, 'Open work orders') + stat('agents', n.proposals, 'Agent proposals waiting', 1) + '</div>' +
      '<section class="sec"><iframe class="frame" title="Purchasing, from the admin console" src="../client/admin.html?embed=1&amp;tabs=po,plist,stock,parts,wo"></iframe>' +
      '<p class="small muted"><a href="../client/admin.html" target="_blank" rel="noopener">Open the full admin console</a></p></section>';
  },
  rooms: function () {
    if (ME.hq_role === 'owner') {
      return head('Rooms', 'Every room BRP tracks, with sensor readings. Edit a room to take it offline or bring it back.') + demoBanner() +
        '<section class="sec"><iframe class="frame" title="Rooms, from the admin console" src="../client/admin.html?embed=1&amp;tabs=rooms,sites"></iframe>' +
        '<p class="small muted"><a href="../client/admin.html" target="_blank" rel="noopener">Open the full admin console</a></p></section>';
    }
    var R = DATA.rooms.slice().sort(function (a, b) { var o = { action: 0, offline: 1, watch: 2, ok: 3 }; return (o[a.status] - o[b.status]) || a.id.localeCompare(b.id); });
    var dot = { ok: 'ok', watch: 'watch', action: 'act', offline: '' };
    return head('Rooms', (ME.inst ? esc(ME.inst) + ' rooms. ' : '') + 'Rooms that need action first.') + demoBanner() +
      '<div class="tw"><table><thead><tr><th scope="col">Room</th><th scope="col">Status</th><th scope="col">Humidity</th><th scope="col">Note</th></tr></thead><tbody>' +
      (R.length ? R.map(function (r) { return '<tr><td>' + esc(r.bldg + ' Rm ' + r.room) + '</td><td><span class="dot ' + (dot[r.status] || '') + '">' + esc(r.status) + '</span></td><td>' + (r.sensor_rh == null ? '' : esc(r.sensor_rh + '%')) + '</td><td>' + esc(r.offline_reason || r.note || '') + '</td></tr>'; }).join('') : '<tr><td colspan="4">No rooms.</td></tr>') +
      '</tbody></table></div>';
  },
  systems: function () {
    var S = DATA.systems.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    var dot = { live: 'ok', building: 'watch', blocked: 'act' }, lab = { live: 'Live', building: 'Building', blocked: 'Blocked' };
    return head('Systems', 'What is live, what is being built and what is blocked.') + demoBanner() +
      '<div class="cards two" style="margin-top:8px">' + S.map(function (s) {
        return '<article class="card sys"><div class="sec-h"><p class="q">' + esc(s.name) + '</p><span class="dot ' + dot[s.state] + '">' + lab[s.state] + '</span></div><p class="small"><b>' + esc(s.status) + '.</b> ' + esc(s.note) + '</p>' +
          (s.url ? '<p class="small"><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url.replace(/^https:\/\//, '')) + '</a></p>' : '') + '</article>';
      }).join('') + '</div>';
  },
  docs: function () {
    var D = DATA.documents.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    var links = DATA.systems.filter(function (s) { return s.url; });
    return head('Documents', 'Links to the documents and pages BRP runs on. They open in a new tab.') + demoBanner() +
      (ME.hq_role === 'owner' ? '<div class="row"><button class="btn pri" type="button" data-act="adddoc">Add a link</button></div>' : '') +
      '<section class="sec"><div class="cards">' + (D.length ? D.map(docLink).join('') : '<p class="empty">No documents yet.</p>') + '</div></section>' +
      (links.length ? '<section class="sec" aria-labelledby="h-sl"><div class="sec-h"><h2 id="h-sl">System pages</h2></div><div class="cards">' + links.map(function (s) { return docLink({ title: s.name, url: s.url, note: s.status }); }).join('') + '</div></section>' : '');
  },
  ask: function () {
    return head('Claude', 'Your messages go to Claude in the BRP Command thread, which can read the records, write code and documents, and answer here. Quick answer gives a short reply from the records right away. Nothing Claude drafts is saved until you tap Save.') +
      '<div id="ask-host"></div><section class="sec" aria-labelledby="h-req"><div class="sec-h"><h2 id="h-req">Sent to Claude</h2><span class="small muted">' + DATA.requests.length + '</span></div>' + reqList(DATA.requests) + '</section>';
  }
};
function docLink(d) {
  return '<a class="doc" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(d.title) + '</b><span>' + esc([d.area, d.note].filter(Boolean).join(' · ')) + '</span>' + svg('link') + '</a>';
}
function reqList(R) {
  if (!R.length) return '<p class="empty">Nothing sent yet. Write a message and tap Send to Claude.</p>';
  var dot = { queued: 'watch', working: 'sig', done: 'ok' }, lab = { queued: 'Queued', working: 'Working', done: 'Done' };
  return '<div class="reqs">' + R.map(function (r) {
    return '<article class="card"><div class="meta"><span class="lbl">' + esc(r.id) + '</span><span class="dot ' + dot[r.status] + '">' + lab[r.status] + '</span><span>' + esc(ftime(r.created_at)) + '</span>' + (r.sample && LOCAL ? '<span class="tag sample">Demo</span>' : '') + '</div>' +
      '<p>' + esc(r.text) + '</p>' + (r.result ? '<p class="small"><b>Result:</b> ' + esc(r.result) + '</p>' : '') +
      ((r.links || []).length ? '<p class="small">' + r.links.map(function (l) { return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.title || l.url) + '</a>'; }).join(' · ') + '</p>' : '') +
      (r.routine_session_url ? '<p class="small"><a href="' + esc(r.routine_session_url) + '" target="_blank" rel="noopener">Watch the session</a></p>' : '') +
      (r.fire_note && r.status === 'queued' ? '<p class="small muted">' + esc(r.fire_note) + '</p>' : '') + '</article>';
  }).join('') + '</div>';
}

function render() {
  if (!DATA) return;
  navHtml();
  $('main').innerHTML = VIEWS[ROUTE]();
  $('fab').hidden = ROUTE === 'ask';
  if (ROUTE === 'ask') mountChat($('ask-host')); else drawChat();
  document.title = (SECTIONS.filter(function (s) { return s[0] === ROUTE; })[0] || ['', 'Command'])[1] + ' · BRP Command';
}

/* ---------- main events ---------- */
$('main').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
  if (b.hasAttribute('data-owner')) { VIEW.owner = b.getAttribute('data-owner'); return render(); }
  if (act === 'showdone') { VIEW.showDone = !VIEW.showDone; return render(); }
  if (act === 'open') { VIEW.open[id] = !VIEW.open[id]; render(); var f = document.querySelector('[data-taskform="' + id + '"] select'); if (f) f.focus(); return; }
  if (act === 'done') {
    var t = DATA.tasks.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var to = t.status === 'done' ? 'not_started' : 'done';
    b.disabled = true;
    return api.setTask(id, { status: to }).then(function () { toast(to === 'done' ? 'Done: ' + t.item : 'Back on the list: ' + t.item); return reload(); }).catch(function (x) { b.disabled = false; toast(x.message); });
  }
  if (act === 'reopen') { VIEW.reopen[id] = true; return render(); }
  if (act === 'answer') return answer(id, +b.getAttribute('data-i'), b);
  if (act === 'addtask') return addTask();
  if (act === 'adddec') return addDecision();
  if (act === 'adddoc') return addDoc();
});
$('main').addEventListener('submit', function (e) {
  var f = e.target.closest('[data-taskform]'); if (!f) return;
  e.preventDefault();
  var id = f.getAttribute('data-taskform');
  api.setTask(id, { status: f.status.value, next: f.next.value.trim(), note: f.note.value.trim() })
    .then(function () { VIEW.open[id] = false; toast('Saved.'); return reload(); }).catch(function (x) { toast(x.message); });
});
function answer(id, i, btn) {
  var d = DATA.decisions.filter(function (x) { return x.id === id; })[0]; if (!d) return;
  if (d.kind === 'agent_proposal' && i === 1) {
    return dialog('Reject ' + d.proposal_id, '<p class="small muted">' + esc(d.question) + '</p><div class="field"><label class="lbl" for="f-why">Why? (required)</label><textarea class="in" id="f-why" rows="3"></textarea></div>', function () {
      var why = $('f-why').value.trim(); if (!why) throw new Error('Say why you rejected it.');
      return api.decide(id, 1, why).then(function () { delete VIEW.reopen[id]; toast(d.proposal_id + ' rejected.'); return reload(); });
    }, 'Reject');
  }
  btn.disabled = true;
  api.decide(id, i, null).then(function () {
    delete VIEW.reopen[id];
    toast(d.kind === 'agent_proposal' ? d.proposal_id + ' approved. Nothing was executed.' : 'Answered: ' + d.options[i]);
    return reload();
  }).catch(function (x) { btn.disabled = false; toast(x.message); });
}

/* ---------- dialogs ---------- */
var dlg = $('dlg'), dform = $('dlg-form');
function dialog(title, body, onSave, saveLabel) {
  dform.innerHTML = '<h2 id="dlg-h">' + esc(title) + '</h2>' + body + '<p class="err" id="dlg-err" role="alert"></p><div class="row" style="justify-content:flex-end"><button class="btn quiet" type="button" id="dlg-cancel">Cancel</button><button class="btn pri" type="submit" id="dlg-save">' + esc(saveLabel || 'Save') + '</button></div>';
  $('dlg-cancel').onclick = function () { dlg.close(); };
  dform.onsubmit = function (e) {
    e.preventDefault(); $('dlg-save').disabled = true;
    Promise.resolve().then(onSave).then(function () { dlg.close(); }).catch(function (x) { $('dlg-err').textContent = (x && x.message) || 'Not saved.'; $('dlg-save').disabled = false; });
  };
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  var f = dform.querySelector('select,input,textarea'); if (f) f.focus();
}
var fld = function (id, label, val, type) { return '<div class="field"><label class="lbl" for="' + id + '">' + esc(label) + '</label><input class="in" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '"></div>'; };
function addTask(pre) {
  pre = pre || {};
  var owners = ME.hq_role === 'partner' ? [ME.party] : OWNERS;
  dialog('Add task', '<div class="field"><label class="lbl" for="f-owner">Owner</label><select class="in" id="f-owner">' + owners.map(function (o) { return '<option' + (o === (pre.owner || VIEW.owner) ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select></div>' +
    fld('f-item', 'What needs doing', pre.item) + fld('f-due', 'Due (for example Oct 24 or This week)', pre.due) + fld('f-date', 'Due date', pre.sort_date, 'date') + fld('f-next', 'Next step', pre.next),
  function () {
    var item = $('f-item').value.trim(); if (!item) throw new Error('Say what needs doing.');
    return api.addTask({ owner: $('f-owner').value, item: item, due: $('f-due').value.trim(), sort_date: $('f-date').value || null, next: $('f-next').value.trim(), area: pre.area || '' })
      .then(function () { toast('Task added.'); return reload(); });
  }, 'Add task');
}
function addDecision(pre) {
  pre = pre || {};
  dialog('Add decision', fld('f-q', 'Question', pre.question) + fld('f-ctx', 'Context', pre.context) +
    '<div class="field"><label class="lbl" for="f-opts">Answers, one per line</label><textarea class="in" id="f-opts" rows="3">' + esc((pre.options || []).join('\n')) + '</textarea></div>' + fld('f-rec', 'Recommended answer number (optional)', pre.recommended != null ? pre.recommended + 1 : '', 'number'),
  function () {
    var q = $('f-q').value.trim(), opts = $('f-opts').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean), r = parseInt($('f-rec').value, 10);
    if (!q) throw new Error('Write the question.'); if (opts.length < 2) throw new Error('Give at least two answers.');
    return api.addDecision({ question: q, context: $('f-ctx').value.trim(), options: opts, recommended: r >= 1 && r <= opts.length ? r - 1 : null, sort_date: todayIso() })
      .then(function () { toast('Decision added.'); return reload(); });
  }, 'Add decision');
}
function addDoc() {
  dialog('Add a link', fld('f-t', 'Title') + fld('f-u', 'Link (https://...)', '', 'url') + fld('f-a', 'Area'), function () {
    var t = $('f-t').value.trim(), u = $('f-u').value.trim();
    if (!t) throw new Error('Give it a title.'); if (!/^https:\/\//.test(u)) throw new Error('The link must start with https://');
    return api.addDocument({ title: t, url: u, area: $('f-a').value.trim() }).then(function () { toast('Link added.'); return reload(); });
  }, 'Add link');
}

/* =====================================================================
   Ask Claude
   ===================================================================== */
var chatEl = null, pending = false, pendingQuick = false;
function mountChat(host) {
  if (!chatEl) {
    chatEl = $('chat-tpl').content.firstElementChild.cloneNode(true);
    chatEl.querySelector('#chat-form').addEventListener('submit', function (e) { e.preventDefault(); sendThread(); });
    chatEl.querySelector('#chat-quick').addEventListener('click', sendChat);
    chatEl.querySelector('#chat-in').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendThread(); } });
    chatEl.addEventListener('click', function (e) { var b = e.target.closest('button[data-draft]'); if (b) saveDraft(b); });
  }
  if (chatEl.parentNode !== host) host.appendChild(chatEl);
  drawChat();
}
function drawChat() {
  if (!chatEl || !DATA) return;
  var mode = chatEl.querySelector('#chat-mode');
  mode.hidden = !LOCAL;
  mode.innerHTML = '<b>Demo mode</b>Claude replies once the portal is connected. The first two messages are a SAMPLE of what a reply looks like.';
  poll();
  chatEl.querySelector('#chat-log').innerHTML = DATA.messages.length ? DATA.messages.map(msgHtml).join('') + (pendingQuick ? '<div class="msg system" aria-busy="true">Claude is reading the records.</div>' : waiting() ? '<div class="msg system pending" aria-busy="true">Sent to Claude. Replies appear here.</div>' : '')
    : '<p class="empty">Ask about tasks, decisions, rooms, orders or agents. Claude answers from the records you can see.</p>';
  scrollChat();
}
function scrollChat() { var l = chatEl && chatEl.querySelector('#chat-log'); if (l) l.scrollTop = l.scrollHeight; }
function msgHtml(m) {
  var who = m.role === 'user' ? (m.author || 'You') : m.role === 'assistant' ? 'Claude' : (m.author || 'Command');
  var drafts = (m.drafts || []).map(function (d) {
    var key = m.id + ':' + d._id, done = DATA.saved && DATA.saved[key];
    var body = d.kind === 'task' ? '<span class="lbl">Draft task · ' + esc(d.owner) + '</span><b>' + esc(d.item) + '</b>' + (d.due ? '<span class="small">Due ' + esc(d.due) + '</span>' : '') + (d.next ? '<span class="small muted">Next: ' + esc(d.next) + '</span>' : '')
      : d.kind === 'decision' ? '<span class="lbl">Draft decision</span><b>' + esc(d.question) + '</b><span class="small muted">' + esc((d.options || []).join(' / ')) + '</span>'
      : '<span class="lbl">Draft message to the Claude thread</span><span>' + esc(d.text) + '</span>';
    var can = d.kind === 'request' || (d.kind === 'task' ? (ME.hq_role === 'owner' || (ME.hq_role === 'partner' && d.owner === ME.party)) : ME.hq_role === 'owner');
    return '<div class="draft">' + body + (done ? '<span class="answered">Saved</span>' : can ? '<div class="row"><button class="btn pri" type="button" data-draft="' + esc(key) + '">' + (d.kind === 'request' ? 'Send' : 'Save') + '</button></div>' : '<span class="small muted">Only the owner can save this.</span>') + '</div>';
  }).join('');
  var chk = m.checked && m.checked.changed ? '<details class="checked"><summary>The checker removed ' + m.checked.removed.length + ' sentence' + (m.checked.removed.length === 1 ? '' : 's') + ' the records do not back.</summary><ul>' +
    m.checked.removed.map(function (r) { return '<li>"' + esc(r.sentence) + '" (' + esc(String(r.category).replace('_', ' ')) + ')</li>'; }).join('') + '</ul></details>' : '';
  return '<div class="msg ' + esc(m.role) + (m.sample ? ' sample' : '') + '"><span class="who">' + esc(who) + (m.sample ? ' · SAMPLE' : '') + (m.created_at ? ' · ' + esc(ftime(m.created_at)) : '') + '</span>' +
    '<div class="txt">' + esc(m.content) + '</div>' + drafts + chk + '</div>';
}
function chatText() { var t = chatEl.querySelector('#chat-in').value.trim(); chatEl.querySelector('#chat-err').textContent = t ? '' : 'Type a message first.'; return t; }
function busy(on) { pending = on; chatEl.querySelector('#chat-send').disabled = on; chatEl.querySelector('#chat-quick').disabled = on; }
/* Send to Claude: the default. The message goes to the BRP Command thread; the reply arrives later as a new message. */
function sendThread() {
  if (pending) return;
  var text = chatText(); if (!text) return;
  busy(true);
  api.send(text).then(function (r) {
    chatEl.querySelector('#chat-in').value = '';
    var q = r.request || {};
    toast(LOCAL ? 'Demo mode: saved as ' + q.id + '. Nothing was sent.' : r.fired ? 'Sent to Claude (' + q.id + '). Replies appear here.' : 'Saved as ' + q.id + '. ' + (q.fire_note || ''));
    return reload();
  }).catch(function (x) { chatEl.querySelector('#chat-err').textContent = x.message; }).then(function () { busy(false); drawChat(); poll(); });
}
/* Quick answer: an immediate reply from the records through the Messages API (hq-chat), when the portal is connected. */
function sendChat() {
  if (pending) return;
  var text = chatText(); if (!text) return;
  busy(true); pendingQuick = true;
  if (!LOCAL) { DATA.messages.push({ id: 'tmp', role: 'user', author: ME.name, content: text, created_at: new Date().toISOString() }); drawChat(); }
  api.chat(text).then(function (r) {
    chatEl.querySelector('#chat-in').value = '';
    if (r && r.demo) { DATA.messages = DATA.messages.concat(r.messages); return; }
    return api.load().then(function (d) { DATA = d; });
  }).catch(function (x) {
    chatEl.querySelector('#chat-err').textContent = x.message;
    DATA.messages = DATA.messages.filter(function (m) { return m.id !== 'tmp'; });
  }).then(function () { pendingQuick = false; busy(false); drawChat(); });
}
/* Waiting for the thread: a request of mine that is not done and has no Claude reply after its message. */
function waiting() {
  if (!DATA || LOCAL) return false;
  var mine = DATA.requests.filter(function (r) { return r.requested_by === ME.id && r.status !== 'done' && r.message_id; });
  if (!mine.length) return false;
  var last = DATA.messages[DATA.messages.length - 1];
  return !!last && last.role === 'user';
}
var pollT = null;
function poll() {
  clearTimeout(pollT);
  if (!waiting()) return;
  pollT = setTimeout(function () { if (!ME) return; api.load().then(function (d) { DATA = d; if (ROUTE === 'home') render(); else drawChat(); poll(); }).catch(poll); }, 15000);
}
function saveDraft(b) {
  var key = b.getAttribute('data-draft'), mid = key.split(':')[0], did = key.split(':')[1];
  var m = DATA.messages.filter(function (x) { return String(x.id) === mid; })[0], d = m && (m.drafts || []).filter(function (x) { return x._id === did; })[0];
  if (!d) return;
  b.disabled = true;
  var p = d.kind === 'task' ? api.addTask({ owner: d.owner, area: d.area || '', item: d.item, due: d.due || '', sort_date: d.sort_date || null, next: d.next || '', source: 'chat' })
    : d.kind === 'decision' ? api.addDecision({ question: d.question, context: d.context || '', options: d.options, recommended: d.recommended })
    : api.sendRequest(d.text);
  p.then(function () { api.markSaved(key); toast(d.kind === 'request' ? 'Request saved.' : 'Saved.'); return reload(); }).catch(function (x) { b.disabled = false; toast(x.message); });
}

/* ---------- start ---------- */
if ('serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search)) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* not fatal: HQ works without it */ }); });
}
api.prepare().then(function () { return api.restore(); }).then(function (m) { if (m) { ME = m; return openApp(); } })
  .catch(function () { /* stay on the sign in screen */ });
})();
