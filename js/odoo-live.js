/* ==========================================================================
   DashView — Odoo Live  (v3)
   Pick an installed Odoo app → the model dropdown lists only that app's own
   models → Insights shows KPIs + charts built for that app (js/odoo-profiles.js),
   Records is the full explorer (filters, columns, saved views, export).
   All calls go through DVOdooClient (Cloudflare Worker proxy).
   ========================================================================== */
(function () {
  'use strict';
  if (!document.getElementById('view-odoo-live')) return;

  var C = window.DVOdooClient, F = window.DVFmt, PR = window.DVOdooProfiles;
  var esc = F.esc;
  function byId(id) { return document.getElementById(id); }
  function loadJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }

  var GROUPABLE = { selection: 1, many2one: 1, boolean: 1 };
  var DATEABLE = { date: 1, datetime: 1 };
  var MEASURABLE = { integer: 1, float: 1, monetary: 1 };
  var DISPLAYABLE = { char: 1, text: 1, selection: 1, many2one: 1, integer: 1, float: 1, monetary: 1, boolean: 1, date: 1, datetime: 1 };
  var FILTERABLE = { char: 1, text: 1, html: 1, selection: 1, many2one: 1 };
  var NOISE = /^(message_|activity_|website_|access_|__|write_|create_uid|create_date|x_studio|has_|is_|display_name$|id$)/;
  var PREFER = ['display_name', 'name', 'partner_id', 'user_id', 'state', 'stage_id', 'amount_total', 'amount_untaxed', 'expected_revenue', 'date_order', 'invoice_date', 'email', 'phone', 'company_id'];
  var COMPACT = function (v) { return Math.abs(v) >= 1000 ? (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k') : String(v); };
  var PAGE_SIZE = 25, COLUMNS_KEY = 'dashview_odoo_columns', VIEWS_KEY = 'dashview_odoo_saved_views';
  var FIRST_APPS = ['sale', 'crm', 'account', 'purchase', 'stock', 'hr', 'project', 'mrp', 'point_of_sale'];

  var state = {
    modules: [], activeModule: null, models: [], activeModel: null, fields: {}, filters: [],
    page: 0, total: 0, records: [], columns: [], tab: 'insights', dirty: { insights: true, records: true },
    lastSynced: null, version: null, timer: null, seq: 0,
    columnPrefs: loadJSON(COLUMNS_KEY, {}), savedViews: loadJSON(VIEWS_KEY, [])
  };

  /* -- Status / banner / connection strip --------------------------------- */
  function setStatus(mode, text) {
    var pill = byId('odooLiveStatus'), label = byId('odooLiveStatusText');
    if (!pill || !label) return;
    pill.classList.remove('is-live', 'is-error', 'is-connecting', 'is-disconnected');
    if (mode === 'live') pill.classList.add('is-live');
    if (mode === 'error') pill.classList.add('is-error');
    if (mode === 'connecting' || mode === 'testing') pill.classList.add('is-connecting');
    if (mode === 'disconnected') pill.classList.add('is-disconnected');
    pill.setAttribute('data-state', mode);
    label.textContent = text;
  }
  function safeError(e) {
    var message = String(e && e.message || 'Odoo request failed.');
    var cfg = C.cfg();
    [cfg.apiKey, cfg.username].forEach(function (secret) {
      if (secret) message = message.split(String(secret)).join('[redacted]');
    });
    if (/401|403|auth|credential|login|uid/i.test(message)) return 'Authentication was refused. Verify the database name, username and Odoo API key.';
    if (/429|rate.?limit/i.test(message)) return 'Odoo is receiving too many requests. Wait a moment, then retry.';
    if (/access.?denied|access rights|permission|forbidden/i.test(message)) return 'This Odoo user cannot read the selected app or model. Ask an Odoo administrator to grant read access.';
    if (/cannot reach|failed to fetch|networkerror|load failed/i.test(message)) return 'Could not reach the configured proxy. Check its URL, deployment and allowed site origins.';
    return message;
  }
  function showLiveError(e) {
    var banner = byId('odooLiveConnectBanner'), text = byId('odooLiveConnectBannerText'), retry = byId('odooLiveRetryBtn');
    if (banner && text) {
      text.innerHTML = '<strong>Connection issue.</strong> ' + esc(safeError(e));
      banner.hidden = false;
    }
    if (retry) retry.hidden = false;
    setStatus('error', 'Connection error');
  }
  function renderBanner() {
    var s = C.state(), banner = byId('odooLiveConnectBanner'), text = byId('odooLiveConnectBannerText'), retry = byId('odooLiveRetryBtn');
    var connected = window.DVOdoo && window.DVOdoo.isConnected && window.DVOdoo.isConnected();
    if (s === 'ok' && connected) {
      banner.hidden = true;
      if (retry) retry.hidden = true;
      return true;
    }
    banner.hidden = false;
    var message = s === 'ok'
      ? 'Connect from Settings before browsing live records. Your saved credentials remain in this browser.'
      : C.message(s);
    text.innerHTML = '<strong>' + (s === 'locked' ? 'Workspace locked.' : s === 'noproxy' ? 'Proxy URL missing.' : s === 'ok' ? 'Odoo is disconnected.' : 'Odoo is not configured.') + '</strong> ' + esc(message);
    if (retry) retry.hidden = true;
    setStatus('disconnected', s === 'locked' ? 'Locked' : 'Not connected');
    byId('odooLiveConn').innerHTML = '';
    return false;
  }
  function renderConn() {
    var c = C.cfg(), host = ''; try { host = new URL(c.url).host; } catch (e) { host = c.url || ''; }
    var chips = [['Instance', host], ['Database', c.db], ['User', c.username]];
    if (state.version) chips.push(['Odoo', state.version]);
    if (C.lastLatency != null) chips.push(['Latency', C.lastLatency + ' ms']);
    if (state.lastSynced) chips.push(['Synced', state.lastSynced.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })]);
    byId('odooLiveConn').innerHTML = chips.map(function (x) { return '<span class="olx-chip"><em>' + esc(x[0]) + '</em>' + esc(x[1]) + '</span>'; }).join('');
  }

  /* -- Module select (filter, same pattern as the Model select) ------------- */
  function fillModuleSelect() {
    var sel = byId('odooLiveModuleSelect');
    var opt = function (m) { return '<option value="' + esc(m.technicalName) + '">' + esc(m.label) + (PR.has(m.technicalName) ? ' \u2605' : '') + '</option>'; };
    var apps = state.modules.filter(function (m) { return m.isApp; }).sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    var mods = state.modules.filter(function (m) { return !m.isApp; }).sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    var html = '';
    if (apps.length) html += '<optgroup label="Apps">' + apps.map(opt).join('') + '</optgroup>';
    if (mods.length) html += '<optgroup label="Modules">' + mods.map(opt).join('') + '</optgroup>';
    sel.innerHTML = html || '<option value="">No modules found</option>';
    sel.disabled = !state.modules.length;
    if (state.activeModule) sel.value = state.activeModule;
    byId('odooLiveModCount').textContent = state.modules.length ? state.modules.length + ' installed' : '';
  }
  function defaultModule() {
    var names = state.modules.map(function (m) { return m.technicalName; });
    for (var i = 0; i < FIRST_APPS.length; i++) if (names.indexOf(FIRST_APPS[i]) > -1) return FIRST_APPS[i];
    var app = state.modules.filter(function (m) { return m.isApp; })[0];
    return (app || state.modules[0] || {}).technicalName;
  }

  /* -- Module → its own models -------------------------------------------- */
  function modelRows(where) {
    return C.records('ir.model', { domain: where, fields: ['model', 'name', 'transient'], limit: 300 })
      .then(function (r) { return (r.rows || []).filter(function (x) { return !x.transient; }); });
  }
  function discover(mod) {
    return C.records('ir.model.data', { domain: [['module', '=', mod], ['model', '=', 'ir.model']], fields: ['res_id'], limit: 300 })
      .then(function (r) { var ids = (r.rows || []).map(function (x) { return x.res_id; }); return ids.length ? modelRows([['id', 'in', ids]]) : []; })
      .catch(function () { return []; })
      .then(function (rows) {
        if (rows.length) return rows;
        var prefix = mod.replace(/_/g, '.').split('.')[0];
        return modelRows([['model', '=like', prefix + '.%']]).catch(function () { return []; });
      });
  }
  function resolveModels(mod) {
    var prof = PR.get(mod), curated = prof ? prof.models : [];
    return discover(mod).then(function (found) {
      var byName = {}; found.forEach(function (m) { byName[m.model] = m; });
      var need = curated.filter(function (n) { return !byName[n]; });
      return (need.length ? modelRows([['model', 'in', need]]).catch(function () { return []; }) : Promise.resolve([])).then(function (extra) {
        extra.forEach(function (m) { byName[m.model] = m; });
        var primary = curated.filter(function (n) { return byName[n]; }).map(function (n) { return { model: n, label: byName[n].name, group: 'Main' }; });
        var seen = {}; primary.forEach(function (p) { seen[p.model] = 1; });
        var rest = Object.keys(byName).filter(function (n) { return !seen[n]; }).map(function (n) { return { model: n, label: byName[n].name, group: 'More' }; })
          .sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
        return primary.concat(rest);
      });
    });
  }
  function fillModelSelect() {
    var sel = byId('odooLiveModelSelect');
    var opt = function (m) { return '<option value="' + esc(m.model) + '">' + esc(m.label) + ' — ' + esc(m.model) + '</option>'; };
    var main = state.models.filter(function (m) { return m.group === 'Main'; }), more = state.models.filter(function (m) { return m.group === 'More'; });
    var html = '';
    if (main.length) html += '<optgroup label="Main models">' + main.map(opt).join('') + '</optgroup>';
    if (more.length) html += '<optgroup label="Other models in this app">' + more.map(opt).join('') + '</optgroup>';
    sel.innerHTML = html || '<option value="">No readable models</option>';
    sel.disabled = !state.models.length;
    byId('odooLiveModelCount').textContent = state.models.length ? state.models.length + ' models' : '';
  }
  function selectModule(name) {
    var mod = state.modules.filter(function (m) { return m.technicalName === name; })[0];
    state.activeModule = name;
    var msel = byId('odooLiveModuleSelect'); if (msel.value !== name) msel.value = name;
    byId('odooLiveCrumb').innerHTML = '<b>' + esc(mod ? mod.label : name) + '</b><span>' + esc(name) + '</span>';
    byId('odooLiveModelSelect').disabled = true;
    byId('odooLiveModelSelect').innerHTML = '<option>Loading models…</option>';
    var seq = ++state.seq;
    resolveModels(name).then(function (models) {
      if (seq !== state.seq) return;
      state.models = models; fillModelSelect();
      if (models.length) selectModel(models[0].model); else showEmpty('This module has no readable data models.');
    }).catch(function (e) { showEmpty(safeError(e)); });
  }

  /* -- Model + fields ------------------------------------------------------- */
  function selectModel(model) {
    state.activeModel = model; state.filters = []; state.page = 0; state.dirty = { insights: true, records: true };
    byId('odooLiveModelSelect').value = model;
    closePops(); renderChips();
    C.fields(model).then(function (f) {
      if (state.activeModel !== model) return;
      state.fields = f; populateControls(); refreshTab();
    }).catch(function (e) { showEmpty(safeError(e)); });
  }
  function showEmpty(msg) {
    setStatus('error', 'Error');
    byId('odooLiveKpis').innerHTML = ''; byId('odooLiveCharts').innerHTML = '<div class="olx-empty" role="alert">' + esc(safeError({ message: msg })) + '</div>';
  }
  function populateControls() {
    var f = state.fields, names = Object.keys(f);
    var label = function (n) { return esc(f[n].string || n); };
    byId('odooLiveFilterField').innerHTML = '<option value="">Filter field…</option>' + names.filter(function (n) { return FILTERABLE[f[n].type]; }).sort().map(function (n) { return '<option value="' + esc(n) + '">' + label(n) + '</option>'; }).join('');
    var groups = names.filter(function (n) { return GROUPABLE[f[n].type]; }).sort().map(function (n) { return '<option value="' + esc(n) + '">' + label(n) + '</option>'; });
    var dates = names.filter(function (n) { return DATEABLE[f[n].type]; }).sort().map(function (n) { return '<option value="' + esc(n) + ':month">' + label(n) + ' (by month)</option>'; });
    byId('odooLiveGroupBy').innerHTML = '<option value="">Group by…</option>' + groups.concat(dates).join('');
    byId('odooLiveMeasure').innerHTML = '<option value="__count">Count records</option>' + names.filter(function (n) { return MEASURABLE[f[n].type]; }).sort().map(function (n) { return '<option value="' + esc(n) + '">Sum of ' + label(n) + '</option>'; }).join('');
    ['odooLiveFilterValue', 'odooLiveAddFilterBtn', 'odooLiveQuickSearch', 'odooLiveColumnsBtn', 'odooLiveViewsBtn', 'odooLiveExportBtn'].forEach(function (id) { if (byId(id)) byId(id).disabled = false; });
    byId('odooLiveBuilderBody').innerHTML = '<div class="olx-empty-s">Pick a “Group by” field to build your own chart for ' + esc(state.activeModel) + '.</div>';
  }

  /* -- Tabs ----------------------------------------------------------------- */
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#odooLiveTabs [role="tab"]').forEach(function (b) {
      var selected = b.getAttribute('data-tab') === tab;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = selected ? 0 : -1;
    });
    byId('odooLiveInsights').hidden = tab !== 'insights'; byId('odooLiveRecords').hidden = tab !== 'records';
    refreshTab();
  }
  function refreshTab() {
    if (!state.activeModel || !renderBanner()) return;
    if (state.tab === 'insights') { if (state.dirty.insights) loadInsights(); }
    else if (state.dirty.records) loadRecords();
  }

  /* -- Insights ------------------------------------------------------------- */
  function profileFor() {
    var p = PR.get(state.activeModule), m = state.activeModel;
    if (p && p.models[0] === m) return p;
    if (p) {
      var k = p.kpis.filter(function (x) { return x.model === m; }), c = p.charts.filter(function (x) { return x.model === m; });
      if (k.length || c.length) return { title: p.title, kpis: k, charts: c, models: p.models };
    }
    return PR.build(m, state.fields);
  }
  function shortLabel(l) { var m = String(l).match(/^(.+?)\s+(\d{4})$/); return m ? m[1].slice(0, 3) + ' \u2019' + m[2].slice(2) : String(l); }
  function rowsFrom(groups, gb, meas, fields, spec) {
    var base = gb.split(':')[0], f = fields[base] || {}, sel = {};
    (f.selection || []).forEach(function (x) { sel[x[0]] = x[1]; });
    var rows = groups.map(function (g) {
      var raw = g[gb], label = Array.isArray(raw) ? raw[1] : (raw === false || raw == null ? '(none)' : (sel[raw] || String(raw)));
      var v = meas ? Number(g[meas]) || 0 : (g.__count || g[base + '_count'] || 0);
      return { label: String(label), value: v };
    });
    if (gb.indexOf(':') > -1) return rows.map(function (r) { return { label: shortLabel(r.label), value: r.value }; }).slice(-(spec.last || 12));
    rows.sort(function (a, b) { return b.value - a.value; });
    return rows.slice(0, spec.limit || 8);
  }
  function chartConfig(spec, rows, isMoney) {
    var t = F.theme(), labels = rows.map(function (r) { return r.label; }), data = rows.map(function (r) { return r.value; });
    var fmt = function (v) { return isMoney ? F.money(v) : F.num(v, 2); };
    var tip = { callbacks: { label: function (c) { var v = c.parsed && c.parsed.y != null && spec.type !== 'hbar' ? c.parsed.y : (c.parsed && c.parsed.x != null && spec.type === 'hbar' ? c.parsed.x : c.raw); return ' ' + fmt(v); } } };
    if (spec.type === 'doughnut') {
      return { type: 'doughnut', data: { labels: labels, datasets: [{ data: data, backgroundColor: F.PALETTE, borderColor: t.light ? '#fff' : 'rgba(0,0,0,0)', borderWidth: 3, hoverOffset: 6 }] }, options: { cutout: '68%', plugins: { tooltip: tip } } };
    }
    var horiz = spec.type === 'hbar', line = spec.type === 'line';
    var ds = { data: data, borderRadius: 6, maxBarThickness: 34, backgroundColor: F.PALETTE[0] + 'cc', borderColor: F.PALETTE[0] };
    if (line) Object.assign(ds, { fill: true, tension: 0.35, borderWidth: 2.5, pointRadius: 3, backgroundColor: F.PALETTE[0] + '22' });
    var val = { grid: { color: t.grid }, ticks: { color: t.text, callback: COMPACT }, beginAtZero: true };
    var cat = { grid: { display: false }, ticks: { color: t.text, maxRotation: 0, autoSkip: true } };
    return { type: line ? 'line' : 'bar', data: { labels: labels, datasets: [ds] }, options: { indexAxis: horiz ? 'y' : 'x', scales: horiz ? { x: val, y: cat } : { x: cat, y: val }, plugins: { tooltip: tip } } };
  }
  function legend(rows, isMoney) {
    var total = rows.reduce(function (s, r) { return s + r.value; }, 0) || 1;
    return rows.map(function (r, i) {
      return '<div class="olx-leg"><i style="background:' + F.PALETTE[i % F.PALETTE.length] + '"></i><span title="' + esc(r.label) + '">' + esc(r.label) + '</span><b>' + (isMoney ? F.money(r.value, true) : F.num(r.value)) + '</b><em>' + Math.round(r.value / total * 100) + '%</em></div>';
    }).join('');
  }
  function drawChartCard(id, spec) {
    var body = byId('olxb-' + id), leg = byId('olxl-' + id), sub = byId('olxs-' + id);
    if (!body) return Promise.resolve();
    return C.fields(spec.model).catch(function () { return {}; }).then(function (fields) {
      var meas = spec.measure || null, mf = meas ? fields[meas] : null, isMoney = !!(mf && mf.type === 'monetary');
      if (sub) sub.textContent = (meas ? 'Sum of ' + ((mf && mf.string) || meas) : 'Record count') + ' · by ' + ((fields[spec.groupby.split(':')[0]] || {}).string || spec.groupby.split(':')[0]) + (spec.groupby.indexOf(':') > -1 ? ' (monthly)' : '');
      return C.readGroup(spec.model, { domain: PR.tokens(spec.domain), fields: meas ? [meas + ':sum'] : [], groupby: [spec.groupby] }).then(function (groups) {
        var rows = rowsFrom(groups, spec.groupby, meas, fields, spec);
        if (!rows.length || rows.every(function (r) { return !r.value; })) { body.innerHTML = '<div class="olx-empty-s">No data to chart yet.</div>'; if (leg) leg.innerHTML = ''; return; }
        body.innerHTML = '<canvas id="olxc-' + id + '"></canvas>';
        F.chart('olxc-' + id, chartConfig(spec, rows, isMoney));
        if (leg) leg.innerHTML = spec.type === 'doughnut' ? legend(rows, isMoney) : '';
      });
    }).catch(function (e) { body.innerHTML = '<div class="olx-empty-s is-error" role="alert">Not available: ' + esc(safeError(e)) + '</div>'; if (leg) leg.innerHTML = ''; });
  }
  function fillKpi(i, spec) {
    var el = byId('olxk-' + i); if (!el) return;
    var run = spec.measure ? C.sum(spec.model, PR.tokens(spec.domain), spec.measure) : C.count(spec.model, PR.tokens(spec.domain)).then(function (n) { return { count: n, sum: 0 }; });
    run.then(function (r) {
      var main, sub = spec.sub || '';
      if (spec.kind === 'count') { main = F.num(r.count || 0); if (spec.measure) sub = F.money(r.sum, true) + ' · ' + sub; }
      else main = spec.kind === 'money' ? F.money(r.sum, r.sum >= 1e5) : F.num(r.sum, 1);
      el.querySelector('.olx-k-val').textContent = main; el.querySelector('.olx-k-sub').textContent = sub; el.classList.remove('is-loading');
    }).catch(function (e) { el.classList.remove('is-loading'); el.classList.add('is-error');     el.querySelector('.olx-k-val').textContent = 'n/a'; el.querySelector('.olx-k-sub').textContent = safeError(e); });
  }
  function loadInsights() {
    state.dirty.insights = false;
    var prof = profileFor(), started = Date.now();
    setStatus('connecting', 'Syncing…');
    byId('odooLiveKpis').innerHTML = prof.kpis.map(function (k, i) {
      return '<div class="olx-kpi is-loading" id="olxk-' + i + '"><p class="olx-k-label">' + esc(k.label) + '</p><p class="olx-k-val">…</p><p class="olx-k-sub">' + esc(k.sub || '') + '</p></div>';
    }).join('');
    byId('odooLiveCharts').innerHTML = prof.charts.map(function (c, i) {
      return '<div class="panel olx-chart"><div class="chart-header"><div><h3>' + esc(c.title) + '</h3><p class="chart-subtitle" id="olxs-c' + i + '">Loading…</p></div></div>' +
        '<div class="olx-chart-body" id="olxb-c' + i + '"><div class="olx-skel"></div></div><div class="olx-legend" id="olxl-c' + i + '"></div></div>';
    }).join('') || '<div class="olx-empty">Nothing to chart for this model — open Records to browse it.</div>';
    prof.kpis.forEach(function (k, i) { fillKpi(i, k); });
    Promise.all(prof.charts.map(function (c, i) { return drawChartCard('c' + i, c); })).then(function () {
      state.lastSynced = new Date(); setStatus('live', 'Live · ' + (Date.now() - started) + ' ms'); renderConn();
    });
  }
  function runBuilder() {
    var gb = byId('odooLiveGroupBy').value, meas = byId('odooLiveMeasure').value, type = byId('odooLiveChartType').value, box = byId('odooLiveBuilderBody');
    if (!gb) { box.innerHTML = '<div class="olx-empty-s">Pick a “Group by” field to build your own chart for ' + esc(state.activeModel) + '.</div>'; return; }
    box.innerHTML = '<div class="olx-chart-body" id="olxb-b"><div class="olx-skel"></div></div><div class="olx-legend" id="olxl-b"></div><p class="chart-subtitle" id="olxs-b"></p>';
    var spec = { model: state.activeModel, domain: [], groupby: gb, measure: meas === '__count' ? null : meas, type: gb.indexOf(':') > -1 && type === 'doughnut' ? 'bar' : type, limit: 12, last: 12 };
    drawChartCard('b', spec);
  }

  /* -- Records explorer ------------------------------------------------------- */
  function closePops() {
    [['odooLiveColumnsPop', 'odooLiveColumnsBtn'], ['odooLiveViewsPop', 'odooLiveViewsBtn']].forEach(function (pair) {
      if (byId(pair[0])) byId(pair[0]).hidden = true;
      if (byId(pair[1])) byId(pair[1]).setAttribute('aria-expanded', 'false');
    });
  }
  function eligible() { return Object.keys(state.fields).filter(function (k) { return DISPLAYABLE[state.fields[k].type]; }); }
  function defaultColumns() {
    var el = eligible(), out = PREFER.filter(function (n) { return el.indexOf(n) > -1; });
    el.filter(function (n) { return !NOISE.test(n) && out.indexOf(n) < 0; }).forEach(function (n) { if (out.length < 7) out.push(n); });
    return out.slice(0, 7);
  }
  function displayFields() {
    var pref = state.columnPrefs[state.activeModel];
    if (pref && pref.length) { var kept = pref.filter(function (f) { return eligible().indexOf(f) > -1; }); if (kept.length) return kept; }
    return defaultColumns();
  }
  function searchable() { return Object.keys(state.fields).filter(function (k) { var t = state.fields[k].type; return (t === 'char' || t === 'text') && !NOISE.test(k); }).slice(0, 4); }
  function buildDomain() {
    var parts = state.filters.map(function (f) { return [f.field, 'ilike', f.value]; });
    var q = byId('odooLiveQuickSearch').value.trim(), sf = searchable();
    if (q && sf.length) parts = parts.concat(new Array(sf.length - 1).fill('|'), sf.map(function (f) { return [f, 'ilike', q]; }));
    return parts;
  }
  function renderChips() {
    var wrap = byId('odooLiveChips');
    wrap.innerHTML = state.filters.map(function (f, i) { return '<span class="odoo-live-chip">' + esc(f.field) + ' contains “' + esc(f.value) + '”<button type="button" data-i="' + i + '" aria-label="Remove filter">×</button></span>'; }).join('');
    wrap.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { state.filters.splice(+b.getAttribute('data-i'), 1); state.page = 0; renderChips(); loadRecords(); }); });
  }
  function cell(v, f) {
    if (v === false || v == null) return '<span class="olx-nil">–</span>';
    if (Array.isArray(v)) return esc(v[1]);
    var t = f && f.type;
    if (t === 'boolean') return v ? '✓' : '–';
    if (t === 'monetary') return '<span class="olx-num">' + esc(F.money(v)) + '</span>';
    if (t === 'float' || t === 'integer') return '<span class="olx-num">' + esc(F.num(v, t === 'float' ? 2 : 0)) + '</span>';
    if (t === 'datetime') return esc(F.when(v));
    if (t === 'selection') { var m = (f.selection || []).filter(function (x) { return x[0] === v; })[0]; return '<span class="olx-tag">' + esc(m ? m[1] : v) + '</span>'; }
    var s = String(v); return esc(s.length > 80 ? s.slice(0, 80) + '…' : s);
  }
  function failTable(e) {
    showLiveError(e);
    byId('odooLiveTable').querySelector('thead').innerHTML = '';
    byId('odooLiveTable').setAttribute('aria-busy', 'false');
    byId('odooLiveTable').querySelector('tbody').innerHTML = '<tr><td class="odoo-live-table-state is-error" role="alert">' + esc(safeError(e)) + '</td></tr>';
  }
  function loadRecords() {
    if (!state.activeModel || !renderBanner()) return;
    state.dirty.records = false;
    var cols = displayFields(), t0 = Date.now();
    byId('odooLiveTable').querySelector('thead').innerHTML = '';
    byId('odooLiveTable').querySelector('tbody').innerHTML = '<tr><td class="odoo-live-table-state">Fetching live records…</td></tr>';
    byId('odooLiveTable').setAttribute('aria-busy', 'true');
    setStatus('connecting', 'Syncing…');
    C.records(state.activeModel, { domain: buildDomain(), fields: cols, limit: PAGE_SIZE, offset: state.page * PAGE_SIZE, order: 'id desc' }).then(function (res) {
      state.total = res.total || 0; state.records = res.rows || []; state.columns = cols; state.lastSynced = new Date();
      byId('odooLiveTable').setAttribute('aria-busy', 'false');
      setStatus('live', 'Live · ' + (Date.now() - t0) + ' ms'); renderTable(); renderPagination(); renderConn();
    }).catch(failTable);
  }
  function renderTable() {
    var thead = byId('odooLiveTable').querySelector('thead'), tbody = byId('odooLiveTable').querySelector('tbody');
    byId('odooLiveTable').setAttribute('aria-busy', 'false');
    if (!state.records.length) { thead.innerHTML = ''; tbody.innerHTML = '<tr><td class="odoo-live-table-state">No matching records.</td></tr>'; return; }
    thead.innerHTML = '<tr>' + state.columns.map(function (c) { return '<th>' + esc((state.fields[c] && state.fields[c].string) || c) + '</th>'; }).join('') + '</tr>';
    tbody.innerHTML = state.records.map(function (r) { return '<tr>' + state.columns.map(function (c) { return '<td>' + cell(r[c], state.fields[c]) + '</td>'; }).join('') + '</tr>'; }).join('');
  }
  function renderPagination() {
    var from = state.total ? state.page * PAGE_SIZE + 1 : 0, to = Math.min(state.total, state.page * PAGE_SIZE + state.records.length);
    byId('odooLivePageInfo').textContent = state.total ? from + '–' + to + ' of ' + state.total.toLocaleString() : '0 of 0';
    byId('odooLivePrevBtn').disabled = state.page === 0; byId('odooLiveNextBtn').disabled = to >= state.total;
  }
  function exportCsv() {
    if (!state.records.length) return;
    var head = state.columns.map(function (c) { return (state.fields[c] && state.fields[c].string) || c; });
    var rows = state.records.map(function (r) { return state.columns.map(function (c) { var v = r[c]; return Array.isArray(v) ? v[1] : (v === false || v == null ? '' : v); }); });
    F.download(state.activeModel + '-' + new Date().toISOString().slice(0, 10) + '.csv', F.csv([head].concat(rows)));
    if (window.DVSec) window.DVSec.log('Exported Odoo records', state.activeModel + ' · ' + rows.length + ' rows');
  }

  /* -- Columns & saved views ---------------------------------------------------- */
  function renderColumnsPop() {
    var list = byId('odooLiveColumnsList'), active = state.columns.length ? state.columns : displayFields();
    var el = eligible().sort(function (a, b) { return (state.fields[a].string || a).localeCompare(state.fields[b].string || b); });
    list.innerHTML = el.map(function (f) { return '<label class="odoo-live-col-row"><input type="checkbox" data-col="' + esc(f) + '"' + (active.indexOf(f) > -1 ? ' checked' : '') + '/><span title="' + esc(f) + '">' + esc(state.fields[f].string || f) + '</span></label>'; }).join('') || '<div class="odoo-live-pop-empty">No fields.</div>';
    list.querySelectorAll('input').forEach(function (b) { b.addEventListener('change', function () {
      var chosen = [].slice.call(list.querySelectorAll('input:checked')).map(function (x) { return x.getAttribute('data-col'); });
      if (!chosen.length) return; state.columnPrefs[state.activeModel] = chosen; saveJSON(COLUMNS_KEY, state.columnPrefs); loadRecords();
    }); });
  }
  function renderViewsPop() {
    var list = byId('odooLiveViewsList');
    list.innerHTML = state.savedViews.length ? state.savedViews.map(function (v) {
      return '<div class="odoo-live-view-row"><button type="button" class="apply" data-id="' + esc(v.id) + '">' + esc(v.name) + '</button><span class="model-tag">' + esc(v.model) + '</span><button type="button" class="remove" data-rm="' + esc(v.id) + '" aria-label="Delete saved view">×</button></div>';
    }).join('') : '<div class="odoo-live-pop-empty">No saved views yet — set filters, then “Save current”.</div>';
    list.querySelectorAll('[data-id]').forEach(function (b) { b.addEventListener('click', function () { applyView(b.getAttribute('data-id')); }); });
    list.querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); state.savedViews = state.savedViews.filter(function (v) { return v.id !== b.getAttribute('data-rm'); }); saveJSON(VIEWS_KEY, state.savedViews); renderViewsPop(); }); });
  }
  function applyView(id) {
    var v = state.savedViews.filter(function (x) { return x.id === id; })[0]; if (!v) return; closePops();
    var go = function () { state.filters = (v.filters || []).slice(); state.page = 0; renderChips(); showTab('records'); loadRecords(); };
    if (state.activeModel === v.model) return go();
    state.activeModel = v.model; state.filters = []; state.dirty = { insights: true, records: true };
    if (!state.models.some(function (m) { return m.model === v.model; })) byId('odooLiveModelSelect').insertAdjacentHTML('beforeend', '<option value="' + esc(v.model) + '">' + esc(v.model) + '</option>');
    byId('odooLiveModelSelect').value = v.model;
    C.fields(v.model).then(function (f) { state.fields = f; populateControls(); go(); }).catch(failTable);
  }

  /* -- Bootstrap -------------------------------------------------------------- */
  function loadModules(force) {
    if (!renderBanner()) return;
    if (force) C.reset();
    byId('odooLiveConnectBanner').hidden = true;
    if (byId('odooLiveRetryBtn')) byId('odooLiveRetryBtn').hidden = true;
    byId('odooLiveModuleSelect').disabled = true;
    byId('odooLiveModuleSelect').innerHTML = '<option>Loading modules…</option>';
    setStatus('connecting', 'Syncing…');
    C.test().then(function (d) { var v = d.version && (d.version.server_version || d.version.server_serie); if (v) { state.version = v; renderConn(); } }).catch(function () {});
    C.modules().then(function (mods) {
      state.modules = mods; setStatus('live', 'Live'); fillModuleSelect(); renderConn();
      var keep = state.activeModule && mods.some(function (m) { return m.technicalName === state.activeModule; }) ? state.activeModule : defaultModule();
      if (keep) selectModule(keep);
    }).catch(function (e) {
      setStatus('error', 'Connection error');
      byId('odooLiveModuleSelect').innerHTML = '<option value="">Could not load apps</option>';
      showLiveError(e);
    });
  }
  function refresh(force) {
    if (!renderBanner()) return;
    if (!state.modules.length || force === 'all') return loadModules(true);
    state.dirty = { insights: true, records: true }; refreshTab();
  }
  function resetAndRefresh() { state.modules = []; state.models = []; state.activeModel = null; C.reset(); refresh(); }

  function init() {
    renderBanner();
    byId('odooLiveRefreshBtn').addEventListener('click', function () { var b = this; b.classList.add('is-spinning'); refresh(); setTimeout(function () { b.classList.remove('is-spinning'); }, 700); });
    if (byId('odooLiveRetryBtn')) byId('odooLiveRetryBtn').addEventListener('click', function () { this.disabled = true; refresh('all'); var b = this; setTimeout(function () { b.disabled = false; }, 1500); });
    byId('odooLiveModuleSelect').addEventListener('change', function () { if (this.value) selectModule(this.value); });
    byId('odooLiveModelSelect').addEventListener('change', function () { if (this.value) selectModel(this.value); });
    document.querySelectorAll('#odooLiveTabs button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
      b.addEventListener('keydown', function (e) {
        var tabs = [].slice.call(document.querySelectorAll('#odooLiveTabs [role="tab"]')), i = tabs.indexOf(b), next = null;
        if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = tabs.length - 1;
        if (next !== null) { e.preventDefault(); tabs[next].focus(); tabs[next].click(); }
      });
    });
    ['odooLiveGroupBy', 'odooLiveMeasure', 'odooLiveChartType'].forEach(function (id) { byId(id).addEventListener('change', runBuilder); });
    byId('odooLiveAddFilterBtn').addEventListener('click', function () {
      var field = byId('odooLiveFilterField').value, value = byId('odooLiveFilterValue').value.trim(); if (!field || !value) return;
      state.filters.push({ field: field, value: value }); byId('odooLiveFilterValue').value = ''; state.page = 0; renderChips(); loadRecords();
    });
    byId('odooLiveFilterValue').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !byId('odooLiveAddFilterBtn').disabled) { e.preventDefault(); byId('odooLiveAddFilterBtn').click(); }
    });
    byId('odooLiveQuickSearch').addEventListener('input', debounce(function () { state.page = 0; loadRecords(); }, 400));
    byId('odooLiveColumnsBtn').addEventListener('click', function (e) { e.stopPropagation(); var p = byId('odooLiveColumnsPop'), was = p.hidden; closePops(); if (was && !this.disabled) { renderColumnsPop(); p.hidden = false; this.setAttribute('aria-expanded', 'true'); } });
    byId('odooLiveColumnsReset').addEventListener('click', function () { delete state.columnPrefs[state.activeModel]; saveJSON(COLUMNS_KEY, state.columnPrefs); renderColumnsPop(); loadRecords(); });
    byId('odooLiveViewsBtn').addEventListener('click', function (e) { e.stopPropagation(); var p = byId('odooLiveViewsPop'), was = p.hidden; closePops(); if (was && !this.disabled) { renderViewsPop(); p.hidden = false; this.setAttribute('aria-expanded', 'true'); } });
    byId('odooLiveViewSaveBtn').addEventListener('click', function () {
      if (!state.activeModel) return; var inp = byId('odooLiveViewName');
      var v = { id: 'v' + Date.now().toString(36), name: (inp.value.trim() || state.activeModel + ' view'), model: state.activeModel, filters: state.filters.slice() };
      state.savedViews.unshift(v); saveJSON(VIEWS_KEY, state.savedViews); inp.value = ''; renderViewsPop(); if (window.showToast) window.showToast('Saved view “' + v.name + '”.');
    });
    byId('odooLiveExportBtn').addEventListener('click', exportCsv);
    document.querySelectorAll('.odoo-live-pop').forEach(function (p) { p.addEventListener('click', function (e) { e.stopPropagation(); }); });
    document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.odoo-live-pop-wrap')) closePops(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePops(); });
    byId('odooLivePrevBtn').addEventListener('click', function () { if (state.page > 0) { state.page--; loadRecords(); } });
    byId('odooLiveNextBtn').addEventListener('click', function () { state.page++; loadRecords(); });

    var auto = byId('odooLiveAutoRefresh');
    function applyAuto() { clearInterval(state.timer); var ms = +auto.value; if (ms > 0) state.timer = setInterval(function () { if (byId('view-odoo-live').classList.contains('active') && !document.hidden) refresh(); }, ms); }
    auto.addEventListener('change', applyAuto); applyAuto();

    window.addEventListener('storage', function (e) { if (e.key === 'dashview_odoo_config' || e.key === 'dashview_odoo_connected') resetAndRefresh(); });
    ['dv:odoo-config-saved', 'dv:unlocked'].forEach(function (ev) { document.addEventListener(ev, resetAndRefresh); });
    document.addEventListener('dv:locked', function () { state.modules = []; renderBanner(); });
    document.addEventListener('dv:odoo-disconnected', function () { state.modules = []; state.models = []; state.activeModel = null; C.reset(); renderBanner(); });
    document.addEventListener('dv:session-changed', renderBanner);
    document.addEventListener('dv:theme', function () { state.dirty.insights = true; if (byId('view-odoo-live').classList.contains('active')) refreshTab(); });
    if (byId('view-odoo-live').classList.contains('active')) refresh();
    document.querySelectorAll('[data-view="odoo-live"]').forEach(function (l) { l.addEventListener('click', function () { setTimeout(function () { refresh(); F.resizeCharts(byId('view-odoo-live')); }, 0); }); });
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
