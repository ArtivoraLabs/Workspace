/* ==========================================================================
   DashView — Odoo integration service
   ==========================================================================
   DO mode (Cloudflare Worker / any proxy URL set):
     → Real Odoo calls through the proxy. No Node.js server needed.
     → Set proxyUrl in settings (e.g. https://dashview-proxy.you.workers.dev)

   No sample data: a Worker URL is required. Until it is set, nothing is shown.

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

  /* ── Icons ─────────────────────────────────────────────────────────────── */
  var ICON_PATHS = {
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
    'box':       '<path d="m21 8-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    'users':     '<path d="M17 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    'target':    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
  };

  /* -- Model catalogue (labels used by the Widget Builder) -- */
  var MODELS = {
    'sale.order':       { label: 'Sales Orders', icon: 'file-text', fields: ['Reference','Customer','Total','Stage','Date'] },
    'product.template': { label: 'Products',     icon: 'box',       fields: ['Name','SKU','Sales Price','On Hand','Category'] },
    'res.partner':      { label: 'Customers',    icon: 'users',     fields: ['Name','Company','Email','City','Orders'] },
    'crm.lead':         { label: 'CRM Leads',    icon: 'target',    fields: ['Title','Contact','Stage','Expected Revenue','Salesperson'] }
  };

  /* ── Config helpers ─────────────────────────────────────────────────────── */
  function isConnected() { return !!loadJSON(CONNECTED_KEY, false); }
  function getConfig()   { return window.DVSec ? window.DVSec.cfg() : loadJSON(CONFIG_KEY, {}); }
  function storeConfig(c) { return window.DVSec ? window.DVSec.saveCfg(c) : (saveJSON(CONFIG_KEY, c), Promise.resolve()); }

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
      .then(function (r) {
        return r.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) {}
          if (!d) throw new Error('Proxy returned HTTP ' + r.status + ' (not JSON) — check the Proxy URL is your Worker URL.');
          if (!d.ok) throw new Error((d.error || 'Proxy error') + ' [HTTP ' + r.status + ']');
          return d;
        });
      })
      .catch(function (err) {
        if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(err.message || '')) {
          throw new Error('Cannot reach the Proxy URL. It must be your Worker URL (…workers.dev), and ALLOWED_ORIGINS on the Worker must include ' + (typeof location !== 'undefined' ? location.origin : 'this site') + '.');
        }
        throw err;
      });
  }

  /* Pasted URLs often include /web, /odoo or a #hash (e.g. https://x.odoo.com/odoo/action-123).
     The JSON-RPC endpoint lives at the site root, so reduce the URL to its base. */
  function cleanOdooUrl(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      var p = new URL(u);
      var path = /^\/(web|odoo|jsonrpc)(\/|$)/i.test(p.pathname) ? '' : p.pathname.replace(/\/+$/, '');
      return p.origin + path;
    } catch (e) { return u; }
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */

  function connect(cfg) {
    cfg = cfg || {};
    /* Merge with what is already saved. A blank field must NOT wipe a saved value:
       the API-key box is never pre-filled (it's a password field), so re-clicking
       "Connect" used to overwrite the saved key with '' and the Worker answered 400. */
    var merged = Object.assign({}, getConfig());
    ['url', 'db', 'user', 'apiKey'].forEach(function (k) {
      var v = cfg[k] == null ? '' : String(cfg[k]).trim();
      if (v) merged[k] = v;
    });
    merged.url      = cleanOdooUrl(merged.url);
    merged.proxyUrl = String(cfg.proxyUrl || '').trim();
    if (!merged.proxyUrl) return Promise.resolve({ ok: false, error: 'Worker URL is required. DashView no longer ships sample data — deploy cloudflare-worker.js and paste its URL.' });

    {
      var missing = [];
      if (!merged.url)    missing.push('Odoo URL');
      if (!merged.db)     missing.push('Database');
      if (!merged.user)   missing.push('Username / email');
      if (!merged.apiKey) missing.push('API key');
      if (missing.length) return Promise.resolve({ ok: false, error: 'Missing: ' + missing.join(', ') + '.' });
      if (!/^https?:\/\//i.test(merged.proxyUrl)) {
        return Promise.resolve({ ok: false, error: 'Proxy URL must start with https:// (your Worker URL).' });
      }
      var proxyHost = '';
      try { proxyHost = new URL(merged.proxyUrl).hostname.toLowerCase(); }
      catch (e) { return Promise.resolve({ ok: false, error: 'Proxy URL is not a valid URL.' }); }
      if (/(^|\.)cloudflare\.com$/.test(proxyHost)) {
        return Promise.resolve({ ok: false, error: 'That is the Cloudflare website, not your Worker. Your Worker URL ends in .workers.dev.' });
      }
      /* Real Odoo via proxy (credentials are saved encrypted when a passcode is set) */
      return storeConfig(merged).then(function () { return proxyPost(merged.proxyUrl, 'test', {}); })
        .then(function (res) {
          saveJSON(CONNECTED_KEY, true);
          if (window.DVSec) window.DVSec.log('Odoo connected', merged.url);
          return { ok: true, uid: res.uid, user: merged.user || 'admin', db: merged.db, live: true };
        })
        .catch(function (err) { return { ok: false, error: err.message }; });
    }
  }

  function disconnect() { saveJSON(CONNECTED_KEY, false); if (window.DVSec) window.DVSec.log('Odoo disconnected', '', 'review'); }

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
    return Promise.resolve({ ok: false, error: 'Worker URL is missing. Add it in Settings → Odoo.' });
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
    return Promise.reject(new Error('Odoo is not connected. Add your Worker URL in Settings → Odoo.'));
  }

  /* Aggregate totals via Odoo's read_group — for reporting/analytics-style
     questions ("sales by stage", "revenue by salesperson this month") without
     pulling every raw row. Routes through the same Worker as fetchModel. */
  function fetchReadGroup(modelName, opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (!cfg.proxyUrl) return Promise.reject(new Error('Odoo is not connected. Add your Worker URL in Settings → Odoo.'));
    return proxyPost(cfg.proxyUrl, 'read-group', {
      model: modelName,
      domain: opts.domain || [],
      fields: opts.fields || ['__count'],
      groupby: opts.groupby || [],
      orderby: opts.orderby,
      limit: opts.limit
    }).then(function (res) {
      return { ok: true, model: modelName, groups: res.groups || [], live: true };
    });
  }

  /* -- Expose globally ────────────────────────────────────────────────────── */
  window.DVOdoo = {
    MODELS: MODELS,
    isConnected: isConnected, getConfig: getConfig,
    connect: connect, disconnect: disconnect,
    testConnection: testConnection, fetchModel: fetchModel, fetchReadGroup: fetchReadGroup
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
      else if (connected)     { tag.textContent = 'Worker URL missing'; tag.classList.add('is-configured'); }
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
  }

  function initSettingsPanel() {
    var cfg = getConfig();
    if (byId('odooUrl'))      byId('odooUrl').value      = cfg.url      || '';
    if (byId('odooDb'))       byId('odooDb').value       = cfg.db       || '';
    if (byId('odooUser'))     byId('odooUser').value     = cfg.user     || '';
    if (byId('odooProxyUrl')) byId('odooProxyUrl').value = cfg.proxyUrl || '';
    if (byId('odooKey') && cfg.apiKey) byId('odooKey').placeholder = 'Saved — leave blank to keep';
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
          toast('✓ Live Odoo connected (UID ' + res.uid + ')');
          /* Tell the Live Odoo view to reload with the new config */
          try { document.dispatchEvent(new CustomEvent('dv:odoo-config-saved')); } catch(e) {}
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
            ? '✓ Live Odoo reachable — ' + res.latencyMs + ' ms'
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

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(initSettingsPanel);
  document.addEventListener('dv:session-changed', function () { refreshStatusTag(); });

})();
