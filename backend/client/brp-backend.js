/* BRP One backend adapter, v1. Defines window.BRPBackend.
   Talks to the BRP Supabase project (Postgres with row-level security, Auth, Edge Functions) using the anon key only.
   When it is not configured, every method resolves null (from()/table() resolve { data: null, error: null }),
   so the apps keep their local demo mode.

   Load order:  <script src="brp-config.js"></script>  <script src="brp-backend.js"></script>
   supabase-js is loaded on first use from a pinned jsDelivr URL (below).

   Shell host mapping (ecosystem/HOST-API.md):
     host.data      -> await BRPBackend.data()          (BRP_ENT tuple subset: insts, sites, vend, part, cab, wo, tab, dt, po)
     host.notify(a) -> await BRPBackend.notify(a)       (Edge Function "notify": fan-out + outbox, push when keys are set)
     host.store.*() -> await BRPBackend.store.workOrders() and the rest, same shapes as the host getters
   Getters are async here (they read the server). Errors from a configured server reject with an Error. */
(function () {
  'use strict';
  if (window.BRPBackend) return;

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  var ROLE_LABEL = { soldier: 'Soldier', technician: 'Technician', barracks_manager: 'Barracks manager', site_lead: 'Site lead',
    program_manager: 'Program manager', buyer: 'Buyer', cor: 'Government COR', commander: 'Garrison commander', admin: 'Admin' };
  var ANCHOR = Date.UTC(2026, 9, 7, 12, 0, 0);   // demo clock: Oct 7, 2026 8:00 AM Eastern
  var LOADED_AT = Date.now();
  var MIN = 60000, DAY = 864e5;
  var WINDOW = { Emergency: DAY, Urgent: 7 * DAY, Routine: 30 * DAY };

  var cfg = null, client = null, loading = null, me = null, demoClock = true;

  /* ---------- setup ---------- */
  function jwtRole(key) {
    try { var p = key.split('.')[1]; return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).role || null; } catch (e) { return null; }
  }
  function configure(c) {
    c = c || {};
    var url = String(c.url || '').trim().replace(/\/+$/, ''), key = String(c.anonKey || '').trim();
    client = null; me = null;
    if (!url || !key) { cfg = null; return false; }
    if (/^sb_secret_/.test(key) || jwtRole(key) === 'service_role') {
      cfg = null;
      console.error('BRPBackend: that is a SERVICE key. Only the anon (public) key belongs in the browser. Backend left off.');
      return false;
    }
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
      cfg = null; console.error('BRPBackend: the URL must start with https://'); return false;
    }
    cfg = { url: url, anonKey: key };
    return true;
  }
  function configured() { return !!cfg; }

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SDK_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () { loading = null; reject(new Error('Could not load supabase-js from ' + SDK_URL)); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function db() {
    if (!cfg) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    return loadSdk().then(function () {
      client = client || window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'brp-backend-auth' } });
      return client;
    });
  }
  /* Run fn(client) when configured; resolve null otherwise. Supabase { data, error } results are unwrapped. */
  function run(fn) {
    return db().then(function (c) {
      if (!c) return null;
      return Promise.resolve(fn(c)).then(function (r) {
        if (r && r.error) throw new Error(r.error.message || String(r.error));
        return r && 'data' in r ? r.data : r;
      });
    });
  }

  /* ---------- auth ---------- */
  function whoami(force) {
    if (me && !force) return Promise.resolve(me);
    return run(function (c) {
      return c.auth.getSession().then(function (s) {
        if (!s.data || !s.data.session) return { data: null };
        return c.rpc('whoami');
      });
    }).then(function (p) { me = p || null; return me; });
  }
  function signIn(email, password) {
    return run(function (c) {
      return c.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
    }).then(function (r) {
      if (r === null) return null;
      return whoami(true).then(function (p) {
        if (!p || !p.active) {
          return signOut().then(function () { throw new Error('This account is not active yet. Ask a BRP admin to set your role.'); });
        }
        return { user: r.user, session: r.session, profile: p };
      });
    });
  }
  function signOut() { me = null; return run(function (c) { return c.auth.signOut(); }).then(function () { return null; }); }
  function session() { return run(function (c) { return c.auth.getSession(); }).then(function (d) { return d && d.session ? d.session : null; }); }
  function role() { return whoami().then(function (p) { return p && p.active ? ROLE_LABEL[p.role] || p.role : null; }); }
  function roleKey() { return whoami().then(function (p) { return p && p.active ? p.role : null; }); }
  function user() {
    return whoami().then(function (p) { return p ? { name: p.name, role: ROLE_LABEL[p.role] || p.role, email: p.email, inst: p.inst || null, active: p.active, demo: p.demo } : null; });
  }
  function onAuthChange(fn) {
    if (!cfg) return function () {};
    var sub = null, off = false;
    db().then(function (c) { if (!c || off) return; sub = c.auth.onAuthStateChange(function (ev, s) { me = null; fn(ev, s); }).data.subscription; });
    return function () { off = true; if (sub) sub.unsubscribe(); };
  }

  /* ---------- clock ---------- */
  function now() { return demoClock ? ANCHOR + (Date.now() - LOADED_AT) : Date.now(); }
  function setDemoClock(on) { demoClock = !!on; }
  var ms = function (t) { return t ? Date.parse(t) : null; };
  var mins = function (t) { return t ? Math.round((Date.parse(t) - ANCHOR) / MIN) : null; };

  /* ---------- table access (supabase-js style, lazy) ---------- */
  var CHAIN = ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike',
    'match', 'not', 'or', 'filter', 'order', 'limit', 'range', 'single', 'maybeSingle', 'returns'];
  function from(table) {
    var ops = [], q = {};
    CHAIN.forEach(function (m) { q[m] = function () { ops.push([m, Array.prototype.slice.call(arguments)]); return q; }; });
    q.then = function (ok, bad) {
      return db().then(function (c) {
        if (!c) return { data: null, error: null };
        var b = c.from(table);
        ops.forEach(function (o) { b = b[o[0]].apply(b, o[1]); });
        return b;
      }).then(ok, bad);
    };
    return q;
  }

  /* ---------- store getters, in the BRP One host shapes ---------- */
  function rows(table, cols, order) {
    return run(function (c) { var b = c.from(table).select(cols || '*'); if (order) b = b.order(order[0], { ascending: order[1] !== false }); return b.limit(5000); });
  }
  function clockOf(w, t) {
    if (w.status === 'closed') return 'met';
    if (t > w.dueAt) return 'missed';
    return w.dueAt - t < (WINDOW[w.prio] || WINDOW.Routine) * 0.25 ? 'risk' : 'ok';
  }
  function dewF(tF, rh) {
    if (tF == null || rh == null) return null;
    var tc = (tF - 32) * 5 / 9, a = 17.625, b = 243.04, g = Math.log(rh / 100) + a * tc / (b + tc);
    return Math.round(((b * g / (a - g)) * 9 / 5 + 32) * 10) / 10;
  }
  var store = {
    installations: function () {
      return Promise.all([rows('installations', '*', ['id']), rows('buildings', 'inst,bldg')]).then(function (r) {
        if (!r[0]) return null;
        return r[0].filter(function (i) { return i.pilot; }).map(function (i) {
          return { id: i.id, name: i.name, state: i.state, climate: i.climate, lead: i.lead_name, manager: i.manager_name, techs: i.tech_names || [],
            bldgs: (r[1] || []).filter(function (b) { return b.inst === i.id; }).map(function (b) { return b.bldg; }) };
        });
      });
    },
    buildings: function () {
      return Promise.all([rows('buildings', '*', ['id']), rows('rooms', 'building_id')]).then(function (r) {
        if (!r[0]) return null;
        var n = {}; (r[1] || []).forEach(function (x) { n[x.building_id] = (n[x.building_id] || 0) + 1; });
        return r[0].map(function (b) { return { id: b.id, inst: b.inst, bldg: b.bldg, type: b.type, built: b.built, rooms: n[b.id] || null }; });
      });
    },
    rooms: function () {
      return rows('rooms', '*', ['id']).then(function (r) {
        return r && r.map(function (x) {
          return { id: x.id, inst: x.inst, bldg: x.bldg, room: x.room, status: x.status, note: x.offline_reason || x.note || '', occupied: x.occupancy === 'occupied',
            sensor: x.sensor_id ? { id: x.sensor_id, rh: +x.sensor_rh, tempF: +x.sensor_temp_f, wallRH: x.sensor_wall_rh == null ? null : +x.sensor_wall_rh,
              dewF: dewF(+x.sensor_temp_f, +x.sensor_rh), state: x.sensor_state } : null };
        });
      });
    },
    workOrders: function () {
      return rows('work_orders', '*', ['created_at', false]).then(function (r) {
        if (!r) return null;
        var t = now();
        return r.map(function (w) {
          var o = { id: w.id, ticket: w.ticket || '', inst: w.inst, bldg: w.bldg, room: w.room, title: w.title, desc: w.descr || w.title, prio: w.prio,
            status: w.status, step: w.step, source: w.source, origin: w.origin, createdAt: ms(w.created_at), dueAt: ms(w.due_at), closedAt: ms(w.closed_at),
            tech: w.tech_name || '', soldier: w.soldier_name || '', parts: w.parts || [], poIds: w.po_ids || [], down: !!w.room_down, sample: !!w.sample };
          o.clock = clockOf(o, t);
          return o;
        });
      });
    },
    parts: function () {
      return rows('parts', '*', ['sku']).then(function (r) {
        return r && r.map(function (p) { return { sku: p.sku, name: p.name, cat: p.cat, cost: p.cost == null ? null : +p.cost, vendor: p.vendor_id, leadDays: p.lead_days, rop: p.rop, catalogId: p.catalog_id, designOnly: p.design_only }; });
      });
    },
    stock: function () {
      return rows('stock', '*', ['cabinet_id']).then(function (r) { return r && r.map(function (s) { return { inst: s.inst, cab: s.cabinet_id, sku: s.sku, qty: s.qty, rop: s.rop }; }); });
    },
    purchaseOrders: function () {
      return rows('purchase_orders', '*, po_lines(sku, qty)', ['issued_at', false]).then(function (r) {
        return r && r.map(function (p) {
          return { id: p.id, wo: p.wo_id || null, inst: p.inst, vendor: p.vendor_id, status: p.status, total: +p.total, issuedAt: ms(p.issued_at), eta: ms(p.eta),
            lines: (p.po_lines || []).map(function (l) { return { sku: l.sku, qty: l.qty }; }), sample: !!p.sample };
        });
      });
    },
    vendors: function () {
      return rows('vendors', '*', ['id']).then(function (r) { return r && r.map(function (v) { return { id: v.id, name: v.name, city: v.city, cat: v.cat }; }); });
    },
    satisfaction: function () {
      return rows('satisfaction', '*', ['at', false]).then(function (r) {
        return r && r.map(function (s) {
          return { id: s.id, at: ms(s.at), inst: s.inst, bldg: s.bldg, room: s.room, wo: s.wo_id || null, channel: s.channel, score: s.score, scale: s.scale, text: s.text || '', anon: s.anon, by: s.by_name || null };
        });
      });
    },
    alerts: function () {
      return rows('alerts', '*, alert_recipients(email, name, role, read_at)', ['at', false]).then(function (r) {
        return r && r.map(alertShape);
      });
    },
    get: function (kind, id) {
      if (kind === 'stock') {
        var p = String(id).split(':');
        return store.stock().then(function (r) { return r ? r.filter(function (s) { return s.cab === p[0] && s.sku === p[1]; })[0] || null : null; });
      }
      var L = { wo: 'workOrders', po: 'purchaseOrders', part: 'parts', vendor: 'vendors', inst: 'installations', bldg: 'buildings', room: 'rooms' }[kind];
      if (!L) return Promise.resolve(null);
      return store[L]().then(function (r) { return r ? r.filter(function (x) { return (x.id || x.sku) === id; })[0] || null : null; });
    },
    tags: function (r) {
      if (!cfg || !r) return Promise.resolve(cfg ? [] : null);
      var t = [];
      if (r.id && (r.prio || r.step)) {
        t.push('wo:' + r.id, 'inst:' + r.inst, 'bldg:' + r.inst + '-' + r.bldg, 'room:' + r.inst + '-' + r.bldg + '-' + r.room, 'prio:' + r.prio, 'status:' + r.status);
        (r.parts || []).forEach(function (p) { t.push('part:' + p.sku); }); (r.poIds || []).forEach(function (p) { t.push('po:' + p); });
      } else if (r.lines && r.vendor) {
        t.push('po:' + r.id, 'inst:' + r.inst, 'vendor:' + r.vendor); if (r.wo) t.push('wo:' + r.wo);
        r.lines.forEach(function (l) { t.push('part:' + l.sku); });
      } else if (r.sku) {
        t.push('part:' + r.sku); if (r.cab) t.push('stock:' + r.cab + ':' + r.sku, 'inst:' + r.inst); if (r.vendor) t.push('vendor:' + r.vendor);
      }
      return Promise.resolve(t);
    }
  };
  function alertShape(a) {
    var rec = a.alert_recipients || a.tagged || [];
    return { id: a.id, at: ms(a.at), type: a.type, severity: a.severity, title: a.title, body: a.body || '', inst: a.inst, ref: a.ref,
      tagged: rec.map(function (x) { return { role: x.role, name: x.name, email: x.email }; }),
      readBy: rec.filter(function (x) { return x.read_at; }).map(function (x) { return x.email; }) };
  }

  /* ---------- host.data: the BRP_ENT tuple subset, rebuilt from the server ---------- */
  function data() {
    if (!cfg) return Promise.resolve(null);
    return Promise.all([rows('installations', '*'), rows('vendors', '*'), rows('parts', '*'), rows('cabinets', '*'), rows('stock', '*'),
      rows('work_orders', '*', ['created_at', false]), rows('purchase_orders', '*, po_lines(sku, qty)', ['issued_at', false]), rows('buildings', 'inst,bldg')]).then(function (r) {
      var I = r[0] || [], V = r[1] || [], P = r[2] || [], CB = r[3] || [], S = r[4] || [], W = r[5] || [], PO = r[6] || [], B = r[7] || [];
      var out = { v: 1, note: 'Sample data. Served by the BRP backend.', source: 'backend', insts: [], sites: {}, vend: {}, part: {}, cab: {}, wo: [], tab: [], dt: [], po: [] };
      I.forEach(function (i) {
        out.insts.push([i.name, i.pilot ? i.id : '', i.climate]);
        if (i.pilot) {
          var cab = CB.filter(function (c) { return c.inst === i.id && c.kind === 'cage'; })[0];
          out.sites[i.id] = [i.state, i.lead_name, i.manager_name, i.tech_names || [], B.filter(function (b) { return b.inst === i.id; }).map(function (b) { return b.bldg; }), cab ? cab.id : null];
        }
      });
      V.forEach(function (v) { out.vend[v.id] = [v.name, v.city, v.cat]; });
      P.forEach(function (p) { if (!p.design_only) out.part[p.sku] = [p.name, p.cost == null ? null : +p.cost, p.vendor_id, p.lead_days]; });
      CB.forEach(function (c) {
        out.cab[c.id] = [c.inst, c.name, S.filter(function (s) { return s.cabinet_id === c.id; }).map(function (s) { return s.sku + ':' + s.qty; }).join(' ')];
      });
      W.forEach(function (w) {
        if (w.origin === 'field') { out.tab.push([w.id, w.bldg, w.room, w.title, w.prio, w.step, w.tech_name || '', mins(w.created_at), w.source, w.descr || '']); return; }
        if (w.origin === 'dashboard') { out.dt.push([w.id, w.alias || '', w.bldg, w.room, w.title, w.prio, w.source, w.step, mins(w.created_at), w.contractor || '', w.inst, mins(w.closed_at)]); return; }
        out.wo.push([w.id, w.ticket || '', w.inst, w.bldg, w.room, w.title, w.prio, w.step || 'request', w.room_down ? 1 : 0, w.soldier_name || '', w.tech_name || '',
          mins(w.created_at), (w.po_ids || []).join(' '), (w.parts || []).map(function (l) { return l.sku + '*' + l.qty; }).join(' '),
          mins(w.sched_at), w.interim || '', [w.closed_at ? mins(w.closed_at) : mins(w.updated_at || w.created_at)]]);
      });
      PO.forEach(function (p) {
        out.po.push([p.id, p.wo_id || '', p.inst, p.vendor_id, p.status, +p.total, mins(p.issued_at), mins(p.eta), p.flag || 0, p.carrier || '', p.tracking || '',
          mins(p.received_at), (p.po_lines || []).map(function (l) { return l.sku + '*' + l.qty; }).join(' ')]);
      });
      return out;
    });
  }

  /* ---------- writes ---------- */
  function invoke(name, body) {
    return run(function (c) { return c.functions.invoke(name, { body: body || {} }); });
  }
  function notify(alert) {
    if (!cfg) return Promise.resolve(null);
    return invoke('notify', alert).then(function (r) { return r && r.alert ? alertShape(r.alert) : null; }, function () {
      // Edge Function not deployed yet: the database still does the fan-out and the outbox.
      return run(function (c) { return c.rpc('raise_alert', { p_alert: alert }); }).then(function (r) { return r && r.alert ? alertShape(r.alert) : null; });
    });
  }
  function addSatisfaction(rec) {
    rec = rec || {};
    return run(function (c) {
      return c.from('satisfaction').insert({ inst: rec.inst, bldg: rec.bldg || null, room: rec.room || null, wo_id: rec.wo || null, channel: rec.channel || 'app',
        score: rec.score, scale: String(rec.scale || '3'), text: rec.text || null, anon: rec.anon !== false }).select().single();
    });
  }
  function createWorkOrder(w) {
    w = w || {};
    return run(function (c) {
      return c.from('work_orders').insert({ id: w.id || null, inst: w.inst, bldg: w.bldg, room: w.room, title: w.title, descr: w.desc || null, prio: w.prio || 'Routine',
        source: w.source || 'Office', step: w.step || 'request', tech_name: w.tech || null, parts: w.parts || [], soldier_id: w.soldierId || null }).select().single();
    });
  }
  function updateWorkOrder(id, patch) { return run(function (c) { return c.from('work_orders').update(patch).eq('id', id).select().maybeSingle(); }); }
  function addWorkOrderNote(id, body) {
    return whoami().then(function (p) { return run(function (c) { return c.from('wo_events').insert({ wo_id: id, body: body, actor_id: p ? p.id : null }).select().single(); }); });
  }
  function markAlertRead(id) { return run(function (c) { return c.rpc('mark_alert_read', { p_alert_id: id }); }).then(function (r) { return cfg ? true : r; }); }
  function registerPushToken(token, platform, environment, deviceName, appVersion) {
    return run(function (c) { return c.rpc('register_push_token', { p_token: token, p_platform: platform, p_environment: environment || 'production', p_device_name: deviceName || null, p_app_version: appVersion || null }); });
  }
  function unregisterPushToken(token) { return run(function (c) { return c.rpc('unregister_push_token', { p_token: token }); }).then(function (r) { return cfg ? true : r; }); }

  /* ---------- admin ---------- */
  var admin = {
    users: function () { return rows('profiles', '*', ['email']); },
    setRole: function (userId, roleKeyOrLabel, inst, active) {
      return run(function (c) { return c.rpc('admin_set_role', { p_user: userId, p_role: roleKeyOrLabel, p_inst: inst || null, p_active: active !== false }); });
    },
    resetDemo: function () {
      if (!cfg) return Promise.resolve(null);
      return invoke('admin-reset', {}).then(function (r) { return r; }, function (e) {
        if (/403|Admin only|turned off/i.test(String(e && e.message))) throw e;
        return run(function (c) { return c.rpc('admin_reset_demo'); }).then(function (counts) { return { ok: true, counts: counts }; });
      });
    },
    outbox: function () { return rows('email_outbox', '*', ['created_at', false]); },
    auditLog: function () { return run(function (c) { return c.from('audit_log').select('*').order('at', { ascending: false }).limit(500); }); },
    purchaseList: function () { return rows('purchase_list', '*', ['id']); },
    upsertPurchaseList: function (r) { return run(function (c) { return c.from('purchase_list').upsert(r).select(); }); },
    settings: function () { return rows('settings', '*', ['key']); },
    table: function (name, order) { return rows(name, '*', order); }
  };

  window.BRPBackend = {
    version: '1.0',
    sdkUrl: SDK_URL,
    roleLabels: ROLE_LABEL,
    configure: configure,
    configured: configured,
    isConfigured: configured,
    signIn: signIn,
    signOut: signOut,
    session: session,
    whoami: whoami,
    user: user,
    role: role,
    roleKey: roleKey,
    onAuthChange: onAuthChange,
    now: now,
    setDemoClock: setDemoClock,
    data: data,
    store: store,
    notify: notify,
    raiseAlert: notify,
    addSatisfaction: addSatisfaction,
    createWorkOrder: createWorkOrder,
    updateWorkOrder: updateWorkOrder,
    addWorkOrderNote: addWorkOrderNote,
    markAlertRead: markAlertRead,
    registerPushToken: registerPushToken,
    unregisterPushToken: unregisterPushToken,
    admin: admin,
    from: from,
    table: from,
    client: db
  };

  if (window.BRP_BACKEND_CONFIG) configure(window.BRP_BACKEND_CONFIG);
})();
