/* ==========================================================================
   DashView — Odoo integration service
   ==========================================================================
   DO mode (Cloudflare Worker / any proxy URL set):
     → Real Odoo calls through the proxy. No Node.js server needed.
     → Set proxyUrl in settings (e.g. https://dashview-proxy.you.workers.dev)

   DEMO mode (no proxyUrl set):
     → Simulates Odoo with canned data so the UI works offline.
     → UI behaves exactly like real: loading states, latency, errors.

   PRODUCTION PATH (optional Node.js backend):
     → Leave proxyUrl pointing to http://localhost:4000 (or your server).
     → The server/src/routes/odoo.routes.js handles auth + JWT session.
   ========================================================================== */
(function () {
  'use strict';

  var CONFIG_KEY       = 'dashview_odoo_config';
  var CONNECTED_KEY    = 'dashview_odoo_connected';
  var LAST_TESTED_KEY  = 'dashview_odoo_last_tested';

  function loadJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function delay(ms)          { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── Icons ─────────────────────────────────────────────────────────────── */
  var ICON_PATHS = {
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
    'box':       '<path d="m21 8-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    'users':     '<path d="M17 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    'target':    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
  };
  function modelIconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || ICON_PATHS.box) + '</svg>';
  }

  /* ── Model & demo data ──────────────────────────────────────────────────── */
  var MODELS = {
    'sale.order':       { label: 'Sales Orders', icon: 'file-text', fields: ['Reference','Customer','Total','Stage','Date'] },
    'product.template': { label: 'Products',     icon: 'box',       fields: ['Name','SKU','Sales Price','On Hand','Category'] },
    'res.partner':      { label: 'Customers',    icon: 'users',     fields: ['Name','Company','Email','City','Orders'] },
    'crm.lead':         { label: 'CRM Leads',    icon: 'target',    fields: ['Title','Contact','Stage','Expected Revenue','Salesperson'] }
  };
  var DEMO_DATA = {
    'sale.order':       [['S00142','Northwind Traders','$4,820.00','Sales Order','2025-09-10'],['S00141','Blue Harbor','$1,240.50','Quotation','2025-09-10'],['S00140','Ferra Mfg','$18,900.00','Sales Order','2025-09-09'],['S00139','Cobalt & Vine','$690.00','Invoiced','2025-09-08'],['S00138','Northwind','$2,310.00','Sales Order','2025-09-07']],
    'product.template': [['Oak Executive Desk','FRN-0142','$629.00','48','Furniture'],['Wireless Router X6','NET-0087','$149.00','212','Networking'],['Pour-Over Set','HOM-0033','$42.50','340','Home'],['Trail Backpack','ACC-0219','$89.00','95','Accessories']],
    'res.partner':      [['Amara Khan','Northwind Traders','amara@northwind.co','Austin','14'],['Devon Ruiz','Blue Harbor','devon@blueharbor.com','Seattle','5'],['Priya Nair','Ferra Mfg','priya@ferra-mfg.com','Chicago','22']],
    'crm.lead':         [['Enterprise rollout — Northwind','Amara Khan','Proposal','$24,000','Jonah Price'],['Q4 restock — Blue Harbor','Devon Ruiz','Qualified','$6,200','Sasha Lee']]
  };

  /* ── Config helpers ─────────────────────────────────────────────────────── */
  function isConnected() { return !!loadJSON(CONNECTED_KEY, false); }
  function getConfig()   { return loadJSON(CONFIG_KEY, {}); }

  /* ── Proxy (real Odoo) call ──────────────────────────────────────────────
     Used when cfg.proxyUrl is set.
     Works with:
       • cloudflare-worker.js (workers.cloudflare.com — free, recommended)
       • server/src/index.js  (local Node.js — needs JWT session via AL_API)
  ──────────────────────────────────────────────────────────────────────── */
  function proxyPost(proxyUrl, endpointPath, body) {
    var base = String(proxyUrl).replace(/\/+$/, '');
    /* Cloudflare Worker uses a single endpoint + body.endpoint field.
       Local Node.js server uses /api/odoo/<path> + JWT header.           */
    var isWorker = !/localhost|127\.0\.0\.1/.test(base);
    var url = isWorker
      ? base                         // one URL, body.endpoint selects action
      : base + '/api/odoo/' + endpointPath.replace(/^\/+/,'');

    var cfg = getConfig();
    var payload = Object.assign({}, body, {
      url: cfg.url, db: cfg.db, username: cfg.user || cfg.username, apiKey: cfg.apiKey
    });
    if (isWorker) payload.endpoint = endpointPath;

    var headers = { 'Content-Type': 'application/json' };
    /* Attach JWT if present (local backend path) */
    try { var tok = localStorage.getItem('al_api_token'); if (tok && !isWorker) headers['Authorization'] = 'Bearer ' + tok; } catch(e) {}

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error || 'Proxy error'); return d; });
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */

  function connect(cfg) {
    var hasProxy = !!(cfg && cfg.proxyUrl);
    if (hasProxy) {
      /* Real Odoo via proxy */
      var tempCfg = getConfig();
      Object.assign(tempCfg, cfg);
      saveJSON(CONFIG_KEY, tempCfg);
      return proxyPost(cfg.proxyUrl, 'test', {})
        .then(function (res) {
          saveJSON(CONNECTED_KEY, true);
          return { ok: true, uid: res.uid, user: cfg.user || 'admin', db: cfg.db, live: true };
        })
        .catch(function (err) { return { ok: false, error: err.message }; });
    }
    /* Demo / mock path */
    return delay(900 + Math.random() * 500).then(function () {
      if (!cfg.url || !cfg.db) return { ok: false, error: 'URL and database are required.' };
      saveJSON(CONFIG_KEY, cfg);
      saveJSON(CONNECTED_KEY, true);
      return { ok: true, uid: 2, user: cfg.user || 'admin', db: cfg.db, live: false };
    });
  }

  function disconnect() { saveJSON(CONNECTED_KEY, false); }

  function testConnection() {
    var cfg = getConfig();
    if (cfg.proxyUrl) {
      var t0 = Date.now();
      return proxyPost(cfg.proxyUrl, 'test', {})
        .then(function (res) {
          saveJSON(LAST_TESTED_KEY, Date.now());
          return { ok: true, latencyMs: res.latencyMs || (Date.now() - t0), live: true };
        })
        .catch(function (err) { return { ok: false, error: err.message }; });
    }
    /* Demo */
    return delay(700 + Math.random() * 400).then(function () {
      if (!cfg.url) return { ok: false, error: 'No Odoo URL configured yet.' };
      saveJSON(LAST_TESTED_KEY, Date.now());
      return { ok: true, latencyMs: Math.round(120 + Math.random() * 180), live: false };
    });
  }

  function fetchModel(modelName, opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (cfg.proxyUrl) {
      /* Real Odoo */
      return proxyPost(cfg.proxyUrl, 'records', {
        model: modelName, limit: opts.limit || 50,
        domain: opts.domain || [], fields: opts.fields || null
      }).then(function (res) {
        /* Normalize: real Odoo rows are objects; map to array-of-arrays
           so existing table renderer works unchanged.                    */
        var rows    = res.rows || [];
        var fields  = rows.length ? Object.keys(rows[0]).slice(0, 8) : (MODELS[modelName] ? MODELS[modelName].fields : []);
        var arrRows = rows.map(function (r) { return fields.map(function (f) { var v = r[f]; return (v === false || v == null) ? '—' : (Array.isArray(v) ? v[1] || v[0] : String(v)).slice(0, 60); }); });
        if (opts.search) {
          var q = opts.search.toLowerCase();
          arrRows = arrRows.filter(function (r) { return r.join(' ').toLowerCase().indexOf(q) > -1; });
        }
        return { ok: true, model: modelName, fields: fields, rows: arrRows, total: res.total, live: true };
      });
    }
    /* Demo / mock */
    var rows = DEMO_DATA[modelName] || [];
    return delay(350 + Math.random() * 350).then(function () {
      var filtered = rows;
      if (opts.search) { var q = opts.search.toLowerCase(); filtered = rows.filter(function (r) { return r.join(' ').toLowerCase().indexOf(q) > -1; }); }
      if (opts.limit) filtered = filtered.slice(0, opts.limit);
      return { ok: true, model: modelName, fields: MODELS[modelName] ? MODELS[modelName].fields : [], rows: filtered, total: rows.length, live: false };
    });
  }

  /* ── Expose globally ────────────────────────────────────────────────────── */
  window.DVOdoo = {
    MODELS: MODELS,
    isConnected: isConnected, getConfig: getConfig,
    connect: connect, disconnect: disconnect,
    testConnection: testConnection, fetchModel: fetchModel
  };

  /* ── Wire existing Settings panel ──────────────────────────────────────── */
  function byId(id) { return document.getElementById(id); }
  function toast(msg) { if (window.showToast) window.showToast(msg); }

  function formatTestedAt(ts) {
    if (!ts) return '—';
    var diff = Math.round((Date.now() - ts) / 60000);
    if (diff < 1) return 'just now';
    if (diff < 60) return diff + 'm ago';
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function refreshStatusTag() {
    var tag = byId('odooStatusTag');
    var connected = isConnected();
    var cfg = getConfig();
    var live = !!(cfg.proxyUrl);
    if (tag) {
      tag.classList.remove('is-configured', 'is-live', 'is-connecting');
      if (connected && live)  { tag.textContent = '● Live — connected to ' + (cfg.url || 'Odoo'); tag.classList.add('is-live'); }
      else if (connected)     { tag.textContent = 'Demo data only — add Proxy URL for live data'; tag.classList.add('is-configured'); }
      else if (cfg.url)       { tag.textContent = 'Configured, not connected'; tag.classList.add('is-configured'); }
      else                    { tag.textContent = 'Not connected'; }
    }
    var meta = byId('odooConnMeta');
    var disBtn = byId('odooDisconnectBtn');
    if (meta) {
      meta.hidden = !connected;
      if (connected) {
        if (byId('odooMetaUrl'))    byId('odooMetaUrl').textContent    = cfg.url || '—';
        if (byId('odooMetaDb'))     byId('odooMetaDb').textContent     = cfg.db || '—';
        if (byId('odooMetaUser'))   byId('odooMetaUser').textContent   = cfg.user || 'admin';
        if (byId('odooMetaTested')) byId('odooMetaTested').textContent = formatTestedAt(loadJSON(LAST_TESTED_KEY, null));
      }
    }
    if (disBtn) disBtn.style.display = connected ? '' : 'none';
    var banner = byId('odooDemoBanner');
    if (banner) banner.classList.toggle('is-hidden', live);
    var viewPill = byId('odooViewStatusPill');
    if (viewPill) {
      viewPill.classList.remove('is-configured', 'is-live');
      if (live) { viewPill.classList.add('is-live'); viewPill.textContent = '● Live — Cloudflare Worker proxy active'; }
      else       { viewPill.textContent = 'Sample dataset — add Proxy URL in Settings for live data'; }
    }
  }

  function initSettingsPanel() {
    var cfg = getConfig();
    if (byId('odooUrl'))      byId('odooUrl').value      = cfg.url      || '';
    if (byId('odooDb'))       byId('odooDb').value       = cfg.db       || '';
    if (byId('odooUser'))     byId('odooUser').value     = cfg.user     || '';
    if (byId('odooProxyUrl')) byId('odooProxyUrl').value = cfg.proxyUrl || '';
    refreshStatusTag();

    if (byId('odooConnectBtn')) {
      byId('odooConnectBtn').addEventListener('click', function () {
        if (window.DVAuth && !window.DVAuth.can('manageOdoo')) { toast('Only Admins can connect Odoo.'); return; }
        var newCfg = {
          url:      (byId('odooUrl')      ? byId('odooUrl').value.trim()      : ''),
          db:       (byId('odooDb')       ? byId('odooDb').value.trim()       : ''),
          user:     (byId('odooUser')     ? byId('odooUser').value.trim()     : ''),
          apiKey:   (byId('odooKey')      ? byId('odooKey').value.trim()      : ''),
          proxyUrl: (byId('odooProxyUrl') ? byId('odooProxyUrl').value.trim() : '')
        };
        if (!newCfg.url || !newCfg.db) { toast('Add at least the Odoo URL and database name.'); return; }
        var btn = byId('odooConnectBtn'); var prev = btn.textContent;
        btn.textContent = 'Connecting…'; btn.disabled = true;
        var tag = byId('odooStatusTag');
        if (tag) { tag.textContent = 'Connecting…'; tag.classList.add('is-connecting'); }
        connect(newCfg).then(function (res) {
          btn.textContent = prev; btn.disabled = false;
          if (!res.ok) { toast('❌ ' + res.error); refreshStatusTag(); return; }
          saveJSON(LAST_TESTED_KEY, Date.now());
          refreshStatusTag();
          if (res.live) {
            toast('✅ Live Odoo connected (UID ' + res.uid + ')');
          } else {
            toast('Settings saved (demo mode). Add a Proxy URL for live Odoo data.');
          }
        });
      });
    }

    if (byId('odooTestBtn')) {
      byId('odooTestBtn').addEventListener('click', function () {
        var btn = byId('odooTestBtn'); var prev = btn.textContent;
        btn.textContent = 'Testing…'; btn.disabled = true;
        testConnection().then(function (res) {
          btn.textContent = prev; btn.disabled = false;
          refreshStatusTag();
          toast(res.ok
            ? (res.live ? '✅ Live Odoo reachable — ' + res.latencyMs + 'ms' : '✅ Reachable (simulated ~' + res.latencyMs + 'ms)')
            : '❌ ' + res.error);
        });
      });
    }

    if (byId('odooDisconnectBtn')) {
      byId('odooDisconnectBtn').addEventListener('click', function () {
        disconnect(); refreshStatusTag(); toast('Disconnected from Odoo.');
      });
    }
  }

  /* ── Odoo data-browser view (#view-odoo) ──────────────────────────────── */
  var activeModel = 'sale.order';

  function renderModelTabs() {
    var wrap = byId('odooModelTabs');
    if (!wrap) return;
    wrap.innerHTML = Object.keys(MODELS).map(function (key) {
      return '<button type="button" class="board-tab odoo-model-tab' + (key === activeModel ? ' active' : '') + '" data-model="' + key + '">' +
        modelIconSvg(MODELS[key].icon) + '<span>' + MODELS[key].label + '</span></button>';
    }).join('');
    wrap.querySelectorAll('.board-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { activeModel = btn.getAttribute('data-model'); renderModelTabs(); renderTable(); });
    });
  }

  function renderTable() {
    var table = byId('odooRecordsTable');
    if (!table) return;
    var search = byId('odooRecordsSearch') ? byId('odooRecordsSearch').value : '';
    var thead = table.querySelector('thead');
    var tbody = table.querySelector('tbody');
    fetchModel(activeModel, { search: search }).then(function (res) {
      thead.innerHTML = '<tr>' + res.fields.map(function (f) { return '<th>' + f + '</th>'; }).join('') + '<th></th></tr>';
      if (!res.rows.length) {
        tbody.innerHTML = '<tr><td colspan="' + (res.fields.length + 1) + '" style="text-align:center;color:var(--ink-30);padding:2rem 0;">No matching records.</td></tr>';
        return;
      }
      tbody.innerHTML = res.rows.map(function (row) {
        return '<tr>' + row.map(function (cell) { return '<td>' + String(cell == null ? '—' : cell).replace(/[&<>"]/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}) + '</td>'; }).join('') +
          '<td class="actions-cell"><button type="button" class="btn btn-outline btn-sm dv-use-in-widget" data-model="' + activeModel + '">Use in widget</button></td></tr>';
      }).join('');
      tbody.querySelectorAll('.dv-use-in-widget').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (window.DVWidgets) window.DVWidgets.openBuilderWithSource({ kind: 'odoo', model: btn.getAttribute('data-model') });
        });
      });
    });
  }

  function initOdooView() {
    if (!byId('view-odoo')) return;
    renderModelTabs(); renderTable();
    if (byId('odooRecordsSearch')) byId('odooRecordsSearch').addEventListener('input', function () { renderTable(); });
    refreshStatusTag();
  }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () { initSettingsPanel(); initOdooView(); });
  document.addEventListener('dv:session-changed', function () { refreshStatusTag(); });

})();
