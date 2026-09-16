/* ==========================================================================
   DashView — Live Odoo view controller
   ==========================================================================
   Unlike js/odoo-service.js (mock, canned data), this file drives the
   "Live Odoo" nav item and talks to the real Odoo instance through
   server/src/routes/odoo.routes.js (js/dashview-api.js's AL_API.odoo*
   helpers). If the DashView API server isn't running or you're not signed
   into it, this view shows a clear banner instead of silently failing.
   ========================================================================== */
(function () {
  'use strict';
  if (!document.getElementById('view-odoo-live')) return;

  function byId(id) { return document.getElementById(id); }
  function loadJSON(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var CHAR_TYPES = { char: 1, text: 1, html: 1, selection: 1, many2one: 1 };
  var PAGE_SIZE = 25;

  var state = {
    modules: [], activeModule: null,
    models: [], activeModel: null,
    fields: {}, filters: [],
    page: 0, total: 0, records: [], columns: [],
    lastLatency: null, lastSynced: null,
    autoRefreshTimer: null
  };

  function getOdooCfg() {
    var raw = loadJSON('dashview_odoo_config', {});
    if (!raw.url || !raw.db || !raw.user || !raw.apiKey) return null;
    return { url: raw.url, db: raw.db, username: raw.user, apiKey: raw.apiKey };
  }

  function setStatus(mode, text) {
    var pill = byId('odooLiveStatus');
    var label = byId('odooLiveStatusText');
    if (!pill || !label) return;
    pill.classList.remove('is-live', 'is-error');
    if (mode === 'live') pill.classList.add('is-live');
    if (mode === 'error') pill.classList.add('is-error');
    label.textContent = text;
  }

  function renderBanner() {
    var banner = byId('odooLiveConnectBanner');
    var text = byId('odooLiveConnectBannerText');
    if (!banner || !text) return;
    var cfg = getOdooCfg();
    var backendOk = window.AL_API && window.AL_API.isConnected();

    if (!cfg) {
      banner.hidden = false;
      text.innerHTML = 'Add your Odoo URL, database, username and API key in <a href="#settings" data-view="settings">Settings</a>, then click <b>Connect to Odoo</b> — this view reads that same configuration to pull live data.';
      rewireBannerLinks();
      return false;
    }
    if (!backendOk) {
      banner.hidden = false;
      text.innerHTML = 'Odoo is configured, but this view needs the DashView API server running and you signed in to it (it proxies the real Odoo calls so your API key never reaches the browser\'s network tab). <span id="odooLiveInlineAuth"></span>';
      renderInlineAuthForm();
      return false;
    }
    banner.hidden = true;
    return true;
  }

  function rewireBannerLinks() {
    var link = byId('odooLiveConnectBanner').querySelector('a[data-view]');
    if (link) link.addEventListener('click', function (e) { e.preventDefault(); if (window.dashviewShowView) window.dashviewShowView('settings'); });
  }

  function renderInlineAuthForm() {
    var host = byId('odooLiveInlineAuth');
    if (!host) return;
    host.innerHTML = '<span style="display:inline-flex;gap:6px;align-items:center;margin-top:8px;">' +
      '<input type="email" id="odooLiveAuthEmail" placeholder="email" class="pro-select" style="width:150px;height:30px;">' +
      '<input type="password" id="odooLiveAuthPass" placeholder="password" class="pro-select" style="width:120px;height:30px;">' +
      '<button class="btn btn-outline btn-sm" id="odooLiveAuthSignInBtn">Sign in</button>' +
      '<button class="btn btn-outline btn-sm" id="odooLiveAuthRegisterBtn">Create account</button></span>';
    byId('odooLiveAuthSignInBtn').addEventListener('click', function () { runAuth('login'); });
    byId('odooLiveAuthRegisterBtn').addEventListener('click', function () { runAuth('register'); });
  }

  function runAuth(kind) {
    var email = byId('odooLiveAuthEmail').value.trim();
    var pass = byId('odooLiveAuthPass').value;
    if (!email || !pass) return;
    var p = kind === 'login'
      ? window.AL_API.login(email, pass)
      : window.AL_API.register('acme-corp', email.split('@')[0], email, pass);
    p.then(function () { refreshAll(); })
      .catch(function (e) { if (window.showToast) window.showToast(e.message || 'Sign-in failed.'); });
  }

  /* ── KPIs ─────────────────────────────────────────────────────────────── */
  function setKpis() {
    if (byId('odooLiveKpiModules')) byId('odooLiveKpiModules').textContent = state.modules.length ? String(state.modules.length) : '–';
    if (byId('odooLiveKpiRecords')) byId('odooLiveKpiRecords').textContent = state.records.length ? String(state.records.length) : '–';
    if (byId('odooLiveKpiRecordsSub')) byId('odooLiveKpiRecordsSub').textContent = state.total ? ('of ' + state.total.toLocaleString() + ' total') : 'of total in model';
    if (byId('odooLiveKpiLatency')) byId('odooLiveKpiLatency').textContent = state.lastLatency != null ? (state.lastLatency + ' ms') : '–';
    if (byId('odooLiveKpiSynced') && state.lastSynced) {
      byId('odooLiveKpiSynced').textContent = state.lastSynced.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      if (byId('odooLiveKpiSyncedSub')) byId('odooLiveKpiSyncedSub').textContent = state.activeModel || '—';
    }
  }

  /* ── Modules rail ─────────────────────────────────────────────────────── */
  function renderModulesRail() {
    var rail = byId('odooLiveModulesRail');
    if (!rail) return;
    var body = state.modules.map(function (m) {
      return '<button type="button" class="odoo-live-module-item' + (m.technicalName === state.activeModule ? ' active' : '') + '" data-mod="' + esc(m.technicalName) + '">' +
        '<span>' + esc(m.label) + '</span><span class="m-count">' + (m.isApp ? 'app' : 'mod') + '</span></button>';
    }).join('');
    rail.innerHTML = '<h4>Installed modules · ' + state.modules.length + '</h4>' + (body || '<div class="odoo-live-modules-empty">No installed modules returned.</div>');
    rail.querySelectorAll('.odoo-live-module-item').forEach(function (btn) {
      btn.addEventListener('click', function () { selectModule(btn.getAttribute('data-mod')); });
    });
  }

  function selectModule(technicalName) {
    state.activeModule = technicalName;
    renderModulesRail();
    var cfg = getOdooCfg();
    var select = byId('odooLiveModelSelect');
    select.innerHTML = '<option value="">Loading models…</option>';
    select.disabled = true;
    window.AL_API.odooModels(cfg, technicalName).then(function (models) {
      state.models = models || [];
      select.disabled = false;
      select.innerHTML = state.models.map(function (m) { return '<option value="' + esc(m.model) + '">' + esc(m.label) + ' (' + esc(m.model) + ')</option>'; }).join('') ||
        '<option value="">No models found</option>';
      if (state.models.length) selectModel(state.models[0].model);
    }).catch(function (e) { failTable(e); });
  }

  /* ── Model + fields + filters ────────────────────────────────────────── */
  function selectModel(model) {
    state.activeModel = model;
    state.filters = [];
    state.page = 0;
    byId('odooLiveModelSelect').value = model;
    var cfg = getOdooCfg();
    window.AL_API.odooFields(cfg, model).then(function (fields) {
      state.fields = fields || {};
      populateFilterFieldSelect();
      byId('odooLiveFilterValue').disabled = false;
      byId('odooLiveAddFilterBtn').disabled = false;
      byId('odooLiveQuickSearch').disabled = false;
      loadRecords();
    }).catch(function (e) { failTable(e); });
  }

  function populateFilterFieldSelect() {
    var select = byId('odooLiveFilterField');
    var names = Object.keys(state.fields).filter(function (k) { return CHAR_TYPES[state.fields[k].type]; }).sort();
    select.innerHTML = '<option value="">Filter field…</option>' +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(state.fields[n].string || n) + '</option>'; }).join('');
    populateExecControls();
  }

  /* ── Executive breakdown (read_group totals) ─────────────────────────── */
  var GROUPABLE_TYPES = { selection: 1, many2one: 1, boolean: 1 };
  var MEASURABLE_TYPES = { integer: 1, float: 1, monetary: 1 };

  function populateExecControls() {
    var groupSel = byId('odooLiveGroupBy');
    var measureSel = byId('odooLiveMeasure');
    if (!groupSel || !measureSel) return;

    var groupNames = Object.keys(state.fields).filter(function (k) { return GROUPABLE_TYPES[state.fields[k].type]; }).sort();
    groupSel.innerHTML = '<option value="">Group by…</option>' +
      groupNames.map(function (n) { return '<option value="' + esc(n) + '">' + esc(state.fields[n].string || n) + '</option>'; }).join('');

    var measureNames = Object.keys(state.fields).filter(function (k) { return MEASURABLE_TYPES[state.fields[k].type]; }).sort();
    measureSel.innerHTML = '<option value="__count">Count records</option>' +
      measureNames.map(function (n) { return '<option value="' + esc(n) + '">Sum of ' + esc(state.fields[n].string || n) + '</option>'; }).join('');

    var execBody = byId('odooLiveExecBody');
    if (execBody) execBody.innerHTML = '<p class="odoo-live-exec-empty">Pick a "Group by" field above to see live totals for ' + esc(state.activeModel || 'this model') + '.</p>';
  }

  function loadExecBreakdown() {
    var groupField = byId('odooLiveGroupBy') ? byId('odooLiveGroupBy').value : '';
    var measure = byId('odooLiveMeasure') ? byId('odooLiveMeasure').value : '__count';
    var execBody = byId('odooLiveExecBody');
    if (!execBody) return;
    if (!state.activeModel || !groupField) {
      execBody.innerHTML = '<p class="odoo-live-exec-empty">Pick a "Group by" field above to see live totals for ' + esc(state.activeModel || 'this model') + '.</p>';
      return;
    }
    var cfg = getOdooCfg();
    if (!cfg) return;
    execBody.innerHTML = '<p class="odoo-live-exec-empty">Loading live totals…</p>';
    var measureFields = measure === '__count' ? [] : [measure + ':sum'];
    window.AL_API.odooReadGroup(cfg, state.activeModel, { domain: buildDomain(), fields: measureFields, groupby: [groupField] })
      .then(function (groups) {
        groups = groups || [];
        var rows = groups.map(function (g) {
          var rawLabel = g[groupField];
          var label = Array.isArray(rawLabel) ? rawLabel[1] : (rawLabel === false || rawLabel == null ? '(none)' : String(rawLabel));
          var value = measure === '__count' ? (g.__count || g[groupField + '_count'] || 0) : (g[measure] || 0);
          return { label: label, value: value };
        }).sort(function (a, b) { return b.value - a.value; });
        var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0) || 1;
        if (!rows.length) { execBody.innerHTML = '<p class="odoo-live-exec-empty">No records to group.</p>'; return; }
        execBody.innerHTML = rows.slice(0, 12).map(function (r) {
          var pct = Math.max(4, Math.round((r.value / max) * 100));
          var displayVal = measure === '__count' ? r.value.toLocaleString() : r.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
          return '<div class="odoo-live-exec-row"><span class="exec-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
            '<span class="exec-bar-track"><span class="exec-bar-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="exec-value">' + displayVal + '</span></div>';
        }).join('');
      })
      .catch(function (e) { execBody.innerHTML = '<p class="odoo-live-exec-empty">' + esc((e && e.message) || 'Could not load totals.') + '</p>'; });
  }

  function searchableFields() {
    return Object.keys(state.fields).filter(function (k) { return state.fields[k].type === 'char' || state.fields[k].type === 'text'; }).slice(0, 4);
  }

  function buildDomain() {
    var parts = state.filters.map(function (f) { return [f.field, 'ilike', f.value]; });
    var q = byId('odooLiveQuickSearch').value.trim();
    if (q) {
      var sf = searchableFields();
      if (sf.length) {
        var orBlock = sf.map(function (f) { return [f, 'ilike', q]; });
        var prefix = new Array(sf.length - 1).fill('|');
        parts = parts.concat(prefix, orBlock);
      }
    }
    return parts;
  }

  function renderChips() {
    var wrap = byId('odooLiveChips');
    wrap.innerHTML = state.filters.map(function (f, i) {
      return '<span class="odoo-live-chip">' + esc(f.field) + ' ~ "' + esc(f.value) + '"<button type="button" data-i="' + i + '">✕</button></span>';
    }).join('');
    wrap.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () { state.filters.splice(Number(btn.getAttribute('data-i')), 1); state.page = 0; renderChips(); loadRecords(); });
    });
  }

  /* ── Records + table ─────────────────────────────────────────────────── */
  function failTable(e) {
    setStatus('error', 'Error');
    var tbody = byId('odooLiveTable').querySelector('tbody');
    byId('odooLiveTable').querySelector('thead').innerHTML = '';
    tbody.innerHTML = '<tr><td class="odoo-live-table-state is-error">' + esc((e && e.message) || 'Live Odoo request failed.') + '</td></tr>';
  }

  function loadRecords() {
    if (!state.activeModel) return;
    var cfg = getOdooCfg();
    if (!cfg) { renderBanner(); return; }
    var displayFields = Object.keys(state.fields).filter(function (k) {
      var t = state.fields[k].type;
      return ['char', 'text', 'selection', 'many2one', 'integer', 'float', 'monetary', 'boolean', 'date', 'datetime'].indexOf(t) > -1;
    }).slice(0, 7);
    if (displayFields.indexOf('display_name') === -1 && state.fields.display_name) displayFields.unshift('display_name');

    var tbody = byId('odooLiveTable').querySelector('tbody');
    var thead = byId('odooLiveTable').querySelector('thead');
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="odoo-live-table-state">Fetching live records…</td></tr>';
    setStatus('connecting', 'Syncing…');

    var started = Date.now();
    window.AL_API.odooRecords(cfg, state.activeModel, {
      domain: buildDomain(), fields: displayFields, limit: PAGE_SIZE, offset: state.page * PAGE_SIZE, order: 'id desc'
    }).then(function (res) {
      state.lastLatency = Date.now() - started;
      state.lastSynced = new Date();
      state.total = res.total || 0;
      state.records = res.rows || [];
      state.columns = displayFields;
      setStatus('live', 'Live — connected');
      renderTable();
      setKpis();
      renderPagination();
      loadExecBreakdown();
    }).catch(function (e) { state.lastLatency = null; failTable(e); });
  }

  function renderTable() {
    var thead = byId('odooLiveTable').querySelector('thead');
    var tbody = byId('odooLiveTable').querySelector('tbody');
    if (!state.records.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td class="odoo-live-table-state">No matching live records.</td></tr>';
      return;
    }
    thead.innerHTML = '<tr>' + state.columns.map(function (c) { return '<th>' + esc((state.fields[c] && state.fields[c].string) || c) + '</th>'; }).join('') + '</tr>';
    tbody.innerHTML = state.records.map(function (row) {
      return '<tr>' + state.columns.map(function (c) {
        var v = row[c];
        if (Array.isArray(v)) v = v[1]; // many2one → [id, display_name]
        if (typeof v === 'boolean') v = v ? '✓' : '—';
        return '<td>' + esc(v == null || v === false ? '—' : v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
  }

  function renderPagination() {
    var from = state.total ? state.page * PAGE_SIZE + 1 : 0;
    var to = Math.min(state.total, state.page * PAGE_SIZE + state.records.length);
    byId('odooLivePageInfo').textContent = state.total ? (from + '–' + to + ' of ' + state.total.toLocaleString()) : '0 of 0';
    byId('odooLivePrevBtn').disabled = state.page === 0;
    byId('odooLiveNextBtn').disabled = to >= state.total;
  }

  /* ── Bootstrapping / refresh ─────────────────────────────────────────── */
  function loadModules() {
    var cfg = getOdooCfg();
    if (!cfg) return;
    var rail = byId('odooLiveModulesRail');
    rail.innerHTML = '<h4>Installed modules</h4><div class="odoo-live-modules-loading">Loading live modules…</div>';
    setStatus('connecting', 'Syncing…');
    var started = Date.now();
    window.AL_API.odooModules(cfg).then(function (modules) {
      state.lastLatency = Date.now() - started;
      state.modules = modules || [];
      setStatus('live', 'Live — connected');
      renderModulesRail();
      setKpis();
      if (state.modules.length) selectModule(state.activeModule && state.modules.some(function (m) { return m.technicalName === state.activeModule; }) ? state.activeModule : state.modules[0].technicalName);
    }).catch(function (e) {
      setStatus('error', 'Connection error');
      rail.innerHTML = '<h4>Installed modules</h4><div class="odoo-live-modules-empty">' + esc((e && e.message) || 'Could not reach Odoo.') + '</div>';
    });
  }

  function refreshAll() {
    if (!renderBanner()) return;
    if (!state.modules.length) loadModules();
    else if (state.activeModel) loadRecords();
    else loadModules();
  }

  function setupAutoRefresh() {
    var sel = byId('odooLiveAutoRefresh');
    function apply() {
      if (state.autoRefreshTimer) { clearInterval(state.autoRefreshTimer); state.autoRefreshTimer = null; }
      var ms = Number(sel.value);
      if (ms > 0) state.autoRefreshTimer = setInterval(function () { if (renderBanner()) loadRecords(); }, ms);
    }
    sel.addEventListener('change', apply);
    apply();
  }

  function init() {
    renderBanner();

    byId('odooLiveRefreshBtn').addEventListener('click', function () {
      var btn = this;
      btn.classList.add('is-spinning');
      refreshAll();
      setTimeout(function () { btn.classList.remove('is-spinning'); }, 700);
    });

    byId('odooLiveModelSelect').addEventListener('change', function () { if (this.value) selectModel(this.value); });

    if (byId('odooLiveGroupBy')) byId('odooLiveGroupBy').addEventListener('change', loadExecBreakdown);
    if (byId('odooLiveMeasure')) byId('odooLiveMeasure').addEventListener('change', loadExecBreakdown);

    byId('odooLiveAddFilterBtn').addEventListener('click', function () {
      var field = byId('odooLiveFilterField').value;
      var value = byId('odooLiveFilterValue').value.trim();
      if (!field || !value) return;
      state.filters.push({ field: field, value: value });
      byId('odooLiveFilterValue').value = '';
      state.page = 0;
      renderChips();
      loadRecords();
    });

    byId('odooLiveQuickSearch').addEventListener('input', debounce(function () { state.page = 0; loadRecords(); }, 400));

    byId('odooLivePrevBtn').addEventListener('click', function () { if (state.page > 0) { state.page--; loadRecords(); } });
    byId('odooLiveNextBtn').addEventListener('click', function () { state.page++; loadRecords(); });

    setupAutoRefresh();

    // Re-check whenever the Odoo connection or DashView sign-in state changes elsewhere.
    document.addEventListener('dv:session-changed', refreshAll);
    window.addEventListener('storage', function (e) {
      if (e.key === 'dashview_odoo_config' || e.key === 'dashview_odoo_connected' || e.key === 'al_api_token') refreshAll();
    });

    // Load immediately if the view is already active on page load (e.g. #odoo-live deep link).
    if (byId('view-odoo-live').classList.contains('active')) refreshAll();
    document.querySelectorAll('[data-view="odoo-live"]').forEach(function (link) {
      link.addEventListener('click', function () { setTimeout(refreshAll, 0); });
    });
  }

  function debounce(fn, ms) { var t; return function () { var a = arguments, ctx = this; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, a); }, ms); }; }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(init);
})();
