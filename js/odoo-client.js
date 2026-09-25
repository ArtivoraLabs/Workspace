/* ==========================================================================
   DashView — Odoo client (window.DVOdooClient) + formatters (window.DVFmt)
   One place that knows how to talk to the Worker proxy, so Overview, Odoo
   Live and the Audit log all read the same credentials and fail the same way.
   ========================================================================== */
(function () {
  'use strict';

  var memo = {};
  var MSG = {
    none: 'Odoo is not connected yet. Add your URL, database, username, API key and Worker URL in Settings → Odoo.',
    noproxy: 'Worker URL is missing. Deploy cloudflare-worker.js and paste its URL in Settings → Odoo → Proxy URL.',
    locked: 'Workspace is locked. Unlock it to use your saved Odoo credentials.'
  };

  function cfg() {
    var c;
    if (window.DVSec) c = window.DVSec.cfg();
    else { try { c = JSON.parse(localStorage.getItem('dashview_odoo_config')) || {}; } catch (e) { c = {}; } }
    return { url: c.url, db: c.db, username: c.username || c.user, apiKey: c.apiKey, proxyUrl: c.proxyUrl || '' };
  }
  function state() {
    var c = cfg();
    if (window.DVSec && window.DVSec.isLocked()) return 'locked';
    if (!c.url || !c.db || !c.username) return 'none';
    if (!c.apiKey) return (window.DVSec && window.DVSec.hasPasscode()) ? 'locked' : 'none';
    if (!c.proxyUrl) return 'noproxy';
    return 'ok';
  }

  function noteCors(r) {
    try {
      var a = r.headers.get('access-control-allow-origin');
      if (!a || !window.DVSec) return;
      var v = a === '*' ? 'open' : 'restricted';
      if (window.DVSec.getConf().workerOrigin !== v) window.DVSec.setConf({ workerOrigin: v });
    } catch (e) {}
  }

  /* ── Concurrency throttle ────────────────────────────────────────────────────
     Overview + Odoo Live fire many parallel requests.  Odoo returns HTTP 429
     ("Rate limit exceeded") when too many arrive at once.  We cap in-flight
     Worker calls at MAX_CONCURRENT so Odoo never sees a burst. */
  var MAX_CONCURRENT = 3, _inFlight = 0, _queue = [];
  function _flush() {
    while (_inFlight < MAX_CONCURRENT && _queue.length) {
      var job = _queue.shift();
      _inFlight++;
      job.run().then(function (r) { _inFlight--; _flush(); job.resolve(r); },
                     function (e) { _inFlight--; _flush(); job.reject(e); });
    }
  }

  function _rawFetch(proxyUrl, body, t0) {
    return fetch(String(proxyUrl).replace(/\/+$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        noteCors(r);
        return r.text().then(function (t) {
          var d = null; try { d = JSON.parse(t); } catch (e) {}
          if (!d) throw new Error('Worker returned HTTP ' + r.status + ' (not JSON). Check the Worker URL in Settings.');
          if (!d.ok) throw new Error(d.error || 'Odoo request failed');
          api.lastLatency = Date.now() - t0;
          return d;
        });
      }, function () { throw new Error('Cannot reach the Worker. Check the Worker URL, your connection and ALLOWED_ORIGINS.'); });
  }

  function call(endpoint, extra) {
    var s = state();
    if (s !== 'ok') { var err = new Error(MSG[s]); err.code = s; return Promise.reject(err); }
    var c = cfg(), t0 = Date.now();
    var body = Object.assign({}, extra || {}, { url: c.url, db: c.db, username: c.username, apiKey: c.apiKey, endpoint: endpoint });
    return new Promise(function (resolve, reject) {
      _queue.push({ resolve: resolve, reject: reject, run: function () { return _rawFetch(c.proxyUrl, body, t0); } });
      _flush();
    });
  }

  function cached(key, fn) { if (!memo[key]) memo[key] = fn().catch(function (e) { delete memo[key]; throw e; }); return memo[key]; }

  var api = {
    state: state, cfg: cfg, call: call, lastLatency: null,
    message: function (s) { return MSG[s || state()] || ''; },
    reset: function () { memo = {}; _queue = []; _inFlight = 0; },
    test: function () { return call('test'); },
    modules: function () { return cached('modules', function () { return call('modules').then(function (d) { return d.modules || []; }); }); },
    fields: function (model) { return cached('f:' + model, function () { return call('fields', { model: model }).then(function (d) { return d.fields || {}; }); }); },
    records: function (model, opts) { return call('records', Object.assign({ model: model }, opts || {})); },
    readGroup: function (model, opts) { return call('read-group', Object.assign({ model: model }, opts || {})).then(function (d) { return d.groups || []; }); },
    count: function (model, domain) { return api.records(model, { domain: domain || [], fields: ['id'], limit: 1 }).then(function (r) { return r.total || 0; }); },
    /* Aggregate a single measure over a domain → { sum, count } */
    sum: function (model, domain, field) {
      return api.readGroup(model, { domain: domain || [], fields: field ? [field + ':sum'] : [], groupby: [] })
        .then(function (g) { g = g[0] || {}; return { sum: field ? (Number(g[field]) || 0) : 0, count: g.__count || 0 }; });
    },
    /* Company currency code (e.g. "USD"), or null. Null is never cached. */
    currency: function () {
      if (memo.cur) return memo.cur;
      memo.cur = api.records('res.company', { fields: ['currency_id'], limit: 1 })
        .then(function (r) { var v = r.rows && r.rows[0] && r.rows[0].currency_id; return Array.isArray(v) ? String(v[1]).trim().slice(0, 3).toUpperCase() : null; })
        .catch(function () { return null; })
        .then(function (v) { if (!v) delete memo.cur; return v; });
      return memo.cur;
    }
  };
  window.DVOdooClient = api;

  /* -- Formatters ---------------------------------------------------------- */
  var cur = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n, d) { return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: d == null ? 0 : d }); }
  function money(n, compact) {
    n = Number(n) || 0;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 0 }).format(n);
    } catch (e) { return num(n); }
  }
  function stripHtml(h) {
    if (!h) return '';
    try { return (new DOMParser().parseFromString(String(h), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim(); }
    catch (e) { return String(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  }
  function when(s) {
    if (!s) return '–';
    var d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    if (isNaN(d)) return String(s);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function isoDaysAgo(n) { var d = new Date(Date.now() - n * 864e5); return d.toISOString().slice(0, 19).replace('T', ' '); }
  function csv(rows) {
    return rows.map(function (r) { return r.map(function (c) { var v = String(c == null ? '' : c); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
  }
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 800);
  }
  var PALETTE = ['#e8a33d', '#5b8fae', '#4fb477', '#e5654f', '#8b5cf6', '#f0c06a', '#2da6b2', '#c76b3c', '#9a9552', '#7a86c9'];
  function theme() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      text: light ? 'rgba(26,22,37,.6)' : 'rgba(234,237,248,.55)', grid: light ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.06)',
      tipBg: light ? 'rgba(255,255,255,.98)' : 'rgba(14,17,20,.96)', tipText: light ? '#1a1625' : '#e7ede7', light: light
    };
  }
  /* Create/replace a Chart.js chart on a canvas (keeps a registry so re-renders never leak). */
  var charts = {};
  function chart(canvasId, config) {
    var el = document.getElementById(canvasId);
    if (!el || !window.Chart) return null;
    if (charts[canvasId]) { try { charts[canvasId].destroy(); } catch (e) {} }
    var t = theme();
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: { duration: 350 } }, config.options || {});
    config.options.plugins = Object.assign({ legend: { display: false }, tooltip: { backgroundColor: t.tipBg, titleColor: t.tipText, bodyColor: t.tipText, borderColor: t.grid, borderWidth: 1, padding: 10 } }, config.options.plugins || {});
    charts[canvasId] = new window.Chart(el.getContext('2d'), config);
    return charts[canvasId];
  }
  function resizeCharts(root) {
    Object.keys(charts).forEach(function (k) { var c = charts[k]; if (c && c.canvas && (!root || root.contains(c.canvas))) { try { c.resize(); } catch (e) {} } });
  }
  function getChart(canvasId) { return charts[canvasId] || null; }
  api.currency().then(function (c) { cur = c; }, function () {});
  ['dv:unlocked', 'dv:odoo-config-saved'].forEach(function (ev) { document.addEventListener(ev, function () { memo = {}; api.currency().then(function (c) { cur = c; }); }); });

  window.DVFmt = { esc: esc, num: num, money: money, stripHtml: stripHtml, when: when, isoDaysAgo: isoDaysAgo, csv: csv, download: download, PALETTE: PALETTE, chart: chart, theme: theme, resizeCharts: resizeCharts, getChart: getChart, setCurrency: function (c) { cur = c; } };
})();
