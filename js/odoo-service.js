/* ==========================================================================
   DashView — Odoo integration service (PROTOTYPE / MOCK)
   ==========================================================================
   This simulates talking to an Odoo instance over its standard /jsonrpc
   endpoint. It never makes a real network call — connect()/testConnection()/
   fetchModel() all resolve from an in-memory canned dataset after an
   artificial delay, so the UI (loading states, error states, latency) behaves
   like the real thing would.

   PRODUCTION PATH: swap the bodies of connect()/testConnection()/fetchModel()
   for calls to a small backend proxy (server/src/routes) that does the real
   Odoo JSON-RPC handshake — browsers can't call Odoo's /jsonrpc directly
   with a stored API key without exposing that key, so a same-origin proxy is
   required either way. Nothing in this file's public shape needs to change
   for the rest of the app to keep working once that proxy exists.
   ========================================================================== */
(function () {
  'use strict';

  var CONFIG_KEY = 'dashview_odoo_config';
  var CONNECTED_KEY = 'dashview_odoo_connected';

  function loadJSON(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ── Canned dataset, standing in for a real Odoo db ─────────────────────── */
  var MODELS = {
    'sale.order': { label: 'Sales Orders', icon: 'file-text', fields: ['Reference', 'Customer', 'Total', 'Stage', 'Date'] },
    'product.template': { label: 'Products', icon: 'box', fields: ['Name', 'SKU', 'Sales Price', 'On Hand', 'Category'] },
    'res.partner': { label: 'Customers', icon: 'users', fields: ['Name', 'Company', 'Email', 'City', 'Orders'] },
    'crm.lead': { label: 'CRM Leads', icon: 'target', fields: ['Title', 'Contact', 'Stage', 'Expected Revenue', 'Salesperson'] }
  };

  var DATA = {
    'sale.order': [
      ['S00142', 'Northwind Traders', '$4,820.00', 'Sales Order', '2026-09-10'],
      ['S00141', 'Blue Harbor Retail', '$1,240.50', 'Quotation', '2026-09-10'],
      ['S00140', 'Ferra Manufacturing', '$18,900.00', 'Sales Order', '2026-09-09'],
      ['S00139', 'Cobalt & Vine', '$690.00', 'Invoiced', '2026-09-08'],
      ['S00138', 'Northwind Traders', '$2,310.00', 'Sales Order', '2026-09-07'],
      ['S00137', 'Halden Logistics', '$7,450.00', 'Quotation', '2026-09-06'],
      ['S00136', 'Pemberton Goods', '$980.25', 'Invoiced', '2026-09-05'],
      ['S00135', 'Ferra Manufacturing', '$3,150.00', 'Sales Order', '2026-09-04']
    ],
    'product.template': [
      ['Oak Executive Desk', 'FRN-0142', '$629.00', '48', 'Furniture'],
      ['Wireless Mesh Router X6', 'NET-0087', '$149.00', '212', 'Networking'],
      ['Ceramic Pour-Over Set', 'HOM-0033', '$42.50', '340', 'Home'],
      ['Carbon Trail Backpack', 'ACC-0219', '$89.00', '95', 'Accessories'],
      ['Studio Monitor Stand (pair)', 'AUD-0061', '$74.00', '61', 'Audio'],
      ['Task Chair — Mesh Back', 'FRN-0158', '$219.00', '73', 'Furniture']
    ],
    'res.partner': [
      ['Amara Khan', 'Northwind Traders', 'amara@northwind.co', 'Austin', '14'],
      ['Devon Ruiz', 'Blue Harbor Retail', 'devon@blueharbor.com', 'Seattle', '5'],
      ['Priya Nair', 'Ferra Manufacturing', 'priya@ferra-mfg.com', 'Chicago', '22'],
      ['Owen Castillo', 'Cobalt & Vine', 'owen@cobaltvine.com', 'Denver', '3'],
      ['Lena Fischer', 'Halden Logistics', 'lena@halden.io', 'Portland', '9'],
      ['Marcus Webb', 'Pemberton Goods', 'marcus@pemberton.com', 'Miami', '7']
    ],
    'crm.lead': [
      ['Enterprise rollout — Northwind', 'Amara Khan', 'Proposal', '$24,000', 'Jonah Price'],
      ['Q4 restock — Blue Harbor', 'Devon Ruiz', 'Qualified', '$6,200', 'Sasha Lee'],
      ['New warehouse — Ferra', 'Priya Nair', 'Negotiation', '$41,500', 'Jonah Price'],
      ['Referral — Cobalt & Vine', 'Owen Castillo', 'New', '$3,100', 'Amara Khan']
    ]
  };

  function isConnected() { return !!loadJSON(CONNECTED_KEY, false); }
  function getConfig() { return loadJSON(CONFIG_KEY, {}); }

  function connect(cfg) {
    return delay(900 + Math.random() * 500).then(function () {
      if (!cfg.url || !cfg.db) return { ok: false, error: 'URL and database are required.' };
      saveJSON(CONFIG_KEY, cfg);
      saveJSON(CONNECTED_KEY, true);
      return { ok: true, uid: 2, user: cfg.user || 'admin', db: cfg.db };
    });
  }

  function disconnect() { saveJSON(CONNECTED_KEY, false); }

  function testConnection() {
    var cfg = getConfig();
    return delay(700 + Math.random() * 400).then(function () {
      if (!cfg.url) return { ok: false, error: 'No Odoo URL configured yet.' };
      return { ok: true, latencyMs: Math.round(120 + Math.random() * 180) };
    });
  }

  function fetchModel(modelName, opts) {
    opts = opts || {};
    var rows = DATA[modelName] || [];
    return delay(350 + Math.random() * 350).then(function () {
      var filtered = rows;
      if (opts.search) {
        var q = opts.search.toLowerCase();
        filtered = rows.filter(function (r) { return r.join(' ').toLowerCase().indexOf(q) > -1; });
      }
      if (opts.limit) filtered = filtered.slice(0, opts.limit);
      return { ok: true, model: modelName, fields: MODELS[modelName].fields, rows: filtered, total: rows.length };
    });
  }

  window.DVOdoo = {
    MODELS: MODELS, isConnected: isConnected, getConfig: getConfig,
    connect: connect, disconnect: disconnect, testConnection: testConnection, fetchModel: fetchModel
  };

  /* ── Wire the existing Settings panel (Connect / Test buttons) ─────────── */
  function byId(id) { return document.getElementById(id); }
  function toast(msg) { if (window.showToast) window.showToast(msg); }

  function refreshStatusTag() {
    var tag = byId('odooStatusTag');
    if (!tag) return;
    if (isConnected()) { tag.textContent = 'Connected (mock)'; tag.style.color = 'var(--emerald,#4fb477)'; }
    else if (getConfig().url) { tag.textContent = 'Configured, not connected'; tag.style.color = ''; }
    else { tag.textContent = 'Not connected'; tag.style.color = ''; }
    var viewPill = byId('odooViewStatusPill');
    if (viewPill) {
      viewPill.textContent = isConnected() ? 'Connected (mock data)' : 'Demo dataset — connect in Settings for live mapping';
      viewPill.classList.toggle('dv-pill-live', isConnected());
    }
  }

  function initSettingsPanel() {
    var cfg = getConfig();
    if (byId('odooUrl')) byId('odooUrl').value = cfg.url || '';
    if (byId('odooDb')) byId('odooDb').value = cfg.db || '';
    if (byId('odooUser')) byId('odooUser').value = cfg.user || '';
    refreshStatusTag();

    if (byId('odooConnectBtn')) byId('odooConnectBtn').addEventListener('click', function () {
      if (window.DVAuth && !window.DVAuth.can('manageOdoo')) { toast('Only Admins can connect Odoo in this workspace.'); return; }
      var newCfg = { url: byId('odooUrl').value.trim(), db: byId('odooDb').value.trim(), user: byId('odooUser').value.trim() };
      if (!newCfg.url || !newCfg.db) { toast('Add at least the Odoo URL and database name.'); return; }
      var btn = byId('odooConnectBtn'); var prev = btn.textContent; btn.textContent = 'Connecting…'; btn.disabled = true;
      byId('odooStatusTag').textContent = 'Connecting…';
      connect(newCfg).then(function (res) {
        btn.textContent = prev; btn.disabled = false;
        if (!res.ok) { toast(res.error); refreshStatusTag(); return; }
        refreshStatusTag();
        toast('Connected to ' + newCfg.url + ' (mock) — browse it under "Odoo Data". A real deployment proxies this through server/.');
      });
    });

    if (byId('odooTestBtn')) byId('odooTestBtn').addEventListener('click', function () {
      var btn = byId('odooTestBtn'); var prev = btn.textContent; btn.textContent = 'Testing…'; btn.disabled = true;
      testConnection().then(function (res) {
        btn.textContent = prev; btn.disabled = false;
        toast(res.ok ? ('Reachable — ~' + res.latencyMs + 'ms round trip (simulated).') : res.error);
      });
    });
  }

  /* ── Odoo data browser view (#view-odoo) ────────────────────────────────── */
  var activeModel = 'sale.order';
  function renderModelTabs() {
    var wrap = byId('odooModelTabs');
    if (!wrap) return;
    wrap.innerHTML = Object.keys(MODELS).map(function (key) {
      return '<button type="button" class="board-tab' + (key === activeModel ? ' active' : '') + '" data-model="' + key + '">' + MODELS[key].label + '</button>';
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
        tbody.innerHTML = '<tr><td colspan="' + (res.fields.length + 1) + '" style="text-align:center;color:var(--ink-30);padding:var(--sp-6) 0;">No matching records.</td></tr>';
        return;
      }
      tbody.innerHTML = res.rows.map(function (row) {
        return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') +
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
    renderModelTabs();
    renderTable();
    if (byId('odooRecordsSearch')) byId('odooRecordsSearch').addEventListener('input', function () { renderTable(); });
    refreshStatusTag();
  }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () { initSettingsPanel(); initOdooView(); });
  document.addEventListener('dv:session-changed', function () { refreshStatusTag(); });
})();
