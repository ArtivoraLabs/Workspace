/* ==========================================================================
   DashView — Overview (live from Odoo)
   Every number and chart here is read from the connected Odoo instance via
   DVOdooClient. Each card loads independently: if an app is not installed
   (e.g. no CRM) or the Odoo user lacks access, only that card says so.
   ========================================================================== */
(function () {
  'use strict';
  var root = document.getElementById('view-overview');
  if (!root || !window.DVOdooClient) return;

  var C = window.DVOdooClient, F = window.DVFmt, esc = F.esc;
  function $(id) { return document.getElementById(id); }
  var CONF = [['state', 'in', ['sale', 'done']]];
  var iso = F.isoDaysAgo;
  var S = { range: 30, seq: 0, timer: null, sum: null, trend: null, cat: null, pipe: null, inv: null, top: null, recent: [], shops: null, shopProd: null, shopProdSource: 'pos', lastSynced: null };
  var STATE_LBL = { draft: 'Quotation', sent: 'Quotation sent', sale: 'Sales order', done: 'Locked', cancel: 'Cancelled' };
  var STATE_CLS = { draft: 'review', sent: 'review', sale: 'active', done: 'active', cancel: 'blocked' };
  var ICON = {
    rev: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    ord: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
    aov: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
    pipe: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
    ar: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
    cust: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'
  };
  var KPIS = [['rev', 'Revenue', 'c-signal'], ['ord', 'Orders', 'c-accent2'], ['aov', 'Avg. order value', 'c-beacon'], ['pipe', 'Open pipeline', 'c-emerald'], ['ar', 'Receivable outstanding', 'c-danger'], ['cust', 'Customers', 'c-ink']];

  function friendly(e) {
    var m = (e && e.message) || 'Unavailable';
    if (/doesn.t exist|does not exist/i.test(m)) return 'Not available — that Odoo app is not installed';
    if (/access|not allowed|forbidden/i.test(m)) return 'The connected Odoo user has no access to this data';
    return m;
  }
  function shortMonth(l) { var m = String(l).match(/^(.+?)\s+(\d{4})$/); return m ? m[1].slice(0, 3) + ' ’' + m[2].slice(2) : String(l); }
  function label(v, none) { return Array.isArray(v) ? v[1] : (v === false || v == null ? (none || '(none)') : String(v)); }

  /* -- Skeleton --------------------------------------------------------------- */
  function build() {
    $('ovKpis').innerHTML = KPIS.map(function (k) {
      return '<div class="kpi-card ' + k[2] + '" id="ovk-' + k[0] + '"><div class="kpi-top"><div class="kpi-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON[k[0]] + '</svg></div></div>' +
        '<p class="kpi-label">' + k[1] + '</p><p class="kpi-value">–</p><p class="kpi-delta neutral">&nbsp;</p></div>';
    }).join('');
    var panel = function (cls, id, title, sub, extra) {
      return '<div class="panel ' + cls + '"><div class="chart-header"><div><h3 id="' + id + 'T">' + title + '</h3><p class="chart-subtitle" id="' + id + 'S">' + sub + '</p></div></div><div class="ov-body" id="' + id + 'B"><div class="olx-skel"></div></div>' + (extra || '') + '</div>';
    };
    $('ovGrid').innerHTML =
      panel('ov-span-2', 'ovTrend', 'Revenue trend', 'Confirmed sales · last 12 months') +
      panel('', 'ovCat', 'Sales by category', 'Selected period', '<div class="olx-legend" id="ovCatL"></div>') +
      panel('', 'ovTop', 'Top customers', 'Selected period') +
      panel('', 'ovPipe', 'CRM pipeline', 'Expected revenue by stage') +
      panel('', 'ovInv', 'Invoices by payment status', 'Posted customer invoices', '<div class="olx-legend" id="ovInvL"></div>') +
      panel('ov-span-2', 'ovShops', 'Sales by shop / location', 'Selected period') +
      panel('', 'ovShopProd', 'Best-selling products', 'Selected period') +
      panel('ov-span-3', 'ovRec', 'Recent orders', 'Latest sales orders and quotations');
  }
  function body(id, html) { var el = $(id + 'B'); if (el) el.innerHTML = html; }
  function fail(id, e) { body(id, '<div class="olx-empty-s is-error">' + esc(friendly(e)) + '</div>'); var l = $(id + 'L'); if (l) l.innerHTML = ''; }
  function canvas(id) { body(id, '<div class="ov-canvas"><canvas id="' + id + 'Cv"></canvas></div>'); return id + 'Cv'; }
  function kpi(id, value, sub, dir) {
    var el = $('ovk-' + id); if (!el) return;
    el.querySelector('.kpi-value').textContent = value;
    var d = el.querySelector('.kpi-delta'); d.textContent = sub || ' '; d.className = 'kpi-delta ' + (dir || 'neutral');
    el.title = '';
  }
  function kpiErr(id, e) { var el = $('ovk-' + id); if (!el) return; el.querySelector('.kpi-value').textContent = 'n/a'; var d = el.querySelector('.kpi-delta'); d.textContent = friendly(e); d.className = 'kpi-delta neutral'; }
  function delta(c, p, tag) {
    if (!p) return { t: c ? 'New — no prior ' + tag : 'No activity', d: 'neutral' };
    var x = (c - p) / p * 100;
    return { t: (x >= 0 ? '↑ ' : '↓ ') + Math.abs(x).toFixed(1) + '% vs previous ' + tag, d: x >= 0 ? 'up' : 'down' };
  }
  function setStatus(mode, text) {
    var pill = $('ovStatus'); if (!pill) return;
    pill.classList.remove('is-live', 'is-error'); if (mode === 'live') pill.classList.add('is-live'); if (mode === 'error') pill.classList.add('is-error');
    $('ovStatusText').textContent = text;
  }
  function banner() {
    var s = C.state(), b = $('ovBanner');
    if (s === 'ok') { b.hidden = true; return true; }
    b.hidden = false;
    $('ovBannerText').innerHTML = '<strong>' + (s === 'locked' ? 'Workspace locked.' : 'Connect your Odoo to see live numbers.') + '</strong> ' + esc(C.message(s));
    setStatus('error', s === 'locked' ? 'Locked' : 'Not connected');
    return false;
  }
  function emptyState() {
    build();
    KPIS.forEach(function (k) { kpi(k[0], '–', 'Waiting for Odoo'); });
    ['ovTrend', 'ovCat', 'ovTop', 'ovPipe', 'ovInv', 'ovShops', 'ovShopProd', 'ovRec'].forEach(function (id) { body(id, '<div class="olx-empty-s">Connect Odoo to load this card.</div>'); });
  }

  /* -- Loaders (each one handles its own errors) ------------------------------ */
  function jobSales(days) {
    var cur = C.sum('sale.order', CONF.concat([['date_order', '>=', iso(days)]]), 'amount_total');
    var prv = C.sum('sale.order', CONF.concat([['date_order', '>=', iso(days * 2)], ['date_order', '<', iso(days)]]), 'amount_total');
    var tag = days === 365 ? 'year' : days + ' days';
    return Promise.all([cur, prv]).then(function (r) {
      var c = r[0], p = r[1], a1 = c.count ? c.sum / c.count : 0, a0 = p.count ? p.sum / p.count : 0, d;
      d = delta(c.sum, p.sum, tag); kpi('rev', F.money(c.sum, c.sum >= 1e5), d.t, d.d);
      d = delta(c.count, p.count, tag); kpi('ord', F.num(c.count), d.t, d.d);
      d = delta(a1, a0, tag); kpi('aov', F.money(a1), d.t, d.d);
      S.sum = { revenue: c.sum, orders: c.count, aov: a1, days: days };
    }).catch(function (e) { ['rev', 'ord', 'aov'].forEach(function (id) { kpiErr(id, e); }); });
  }
  function jobTrend() {
    return C.readGroup('sale.order', { domain: CONF.concat([['date_order', '>=', iso(370)]]), fields: ['amount_total:sum'], groupby: ['date_order:month'] }).then(function (g) {
      g = g.slice(-12);
      S.trend = { labels: g.map(function (x) { return shortMonth(x['date_order:month']); }), rev: g.map(function (x) { return Number(x.amount_total) || 0; }), cnt: g.map(function (x) { return x.__count || 0; }) };
      drawTrend();
    }).catch(function (e) { fail('ovTrend', e); });
  }
  function jobCategory(days) {
    var d = iso(days), done = function (title, sub, g, key) {
      var rows = g.map(function (x) { return { label: label(x[key], 'Uncategorised'), value: Number(x.price_subtotal) || 0 }; }).filter(function (r) { return r.value > 0; }).sort(function (a, b) { return b.value - a.value; });
      if (rows.length > 6) { var rest = rows.slice(5).reduce(function (s, r) { return s + r.value; }, 0); rows = rows.slice(0, 5).concat([{ label: 'Other', value: rest }]); }
      S.cat = { title: title, sub: sub, rows: rows }; drawCat();
    };
    return C.fields('sale.report').then(function (f) {
      var key = f.categ_id ? 'categ_id' : (f.product_categ_id ? 'product_categ_id' : null);
      if (!key) throw new Error('no category field');
      return C.readGroup('sale.report', { domain: [['state', 'in', ['sale', 'done']], ['date', '>=', d]], fields: ['price_subtotal:sum'], groupby: [key] }).then(function (g) { done('Sales by category', 'Product category · selected period', g, key); });
    }).catch(function () {
      return C.readGroup('sale.order.line', { domain: [['state', 'in', ['sale', 'done']], ['create_date', '>=', d]], fields: ['price_subtotal:sum'], groupby: ['product_id'] }).then(function (g) { done('Top products', 'Revenue by product · selected period', g, 'product_id'); });
    }).catch(function (e) { fail('ovCat', e); });
  }
  function jobTop(days) {
    return C.readGroup('sale.order', { domain: CONF.concat([['date_order', '>=', iso(days)]]), fields: ['amount_total:sum'], groupby: ['partner_id'] }).then(function (g) {
      S.top = g.map(function (x) { return { label: label(x.partner_id), value: Number(x.amount_total) || 0 }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 6);
      drawTop();
    }).catch(function (e) { fail('ovTop', e); });
  }
  function jobPipeline() {
    var open = [['type', '=', 'opportunity'], ['probability', '<', 100]];
    return Promise.all([C.readGroup('crm.lead', { domain: [['type', '=', 'opportunity']], fields: ['expected_revenue:sum'], groupby: ['stage_id'] }), C.sum('crm.lead', open, 'expected_revenue')]).then(function (r) {
      S.pipe = r[0].map(function (x) { return { label: label(x.stage_id), value: Number(x.expected_revenue) || 0, count: x.__count || 0 }; });
      kpi('pipe', F.money(r[1].sum, r[1].sum >= 1e5), r[1].count + ' open opportunities', 'neutral'); drawPipe();
    }).catch(function (e) { kpiErr('pipe', e); fail('ovPipe', e); });
  }
  function jobInvoices() {
    var base = [['move_type', '=', 'out_invoice'], ['state', '=', 'posted']], unpaid = base.concat([['payment_state', 'in', ['not_paid', 'partial']]]);
    return Promise.all([C.sum('account.move', unpaid, 'amount_residual'), C.sum('account.move', unpaid.concat([['invoice_date_due', '<', new Date().toISOString().slice(0, 10)]]), 'amount_residual'),
      C.readGroup('account.move', { domain: base, fields: ['amount_total:sum'], groupby: ['payment_state'] }), C.fields('account.move')]).then(function (r) {
      var sel = {}; ((r[3].payment_state || {}).selection || []).forEach(function (x) { sel[x[0]] = x[1]; });
      S.inv = r[2].map(function (x) { return { label: sel[x.payment_state] || label(x.payment_state), value: Number(x.amount_total) || 0 }; }).filter(function (x) { return x.value > 0; });
      kpi('ar', F.money(r[0].sum, r[0].sum >= 1e5), r[1].sum > 0 ? F.money(r[1].sum, true) + ' overdue' : 'Nothing overdue', r[1].sum > 0 ? 'down' : 'up'); drawInv();
    }).catch(function (e) { kpiErr('ar', e); fail('ovInv', e); });
  }
  function jobCustomers() {
    return C.count('res.partner', [['customer_rank', '>', 0]]).catch(function () { return C.count('res.partner', [['is_company', '=', true]]); })
      .then(function (n) { kpi('cust', F.num(n), 'Partners with sales', 'neutral'); }).catch(function (e) { kpiErr('cust', e); });
  }
  function jobRecent() {
    return C.records('sale.order', { fields: ['name', 'partner_id', 'amount_total', 'state', 'date_order', 'user_id'], limit: 8, order: 'date_order desc' }).then(function (r) {
      S.recent = r.rows || []; drawRecent();
    }).catch(function (e) { fail('ovRec', e); });
  }

  /* -- Shop / Location loaders -------------------------------------------------- */
  function jobShops(days) {
    /* Try POS first (shop = pos.config), fall back to sale.order by warehouse */
    var d = iso(days);
    return C.readGroup('pos.order', {
      domain: [['state', 'in', ['done', 'invoiced']], ['date_order', '>=', d]],
      fields: ['amount_total:sum'], groupby: ['config_id']
    }).then(function (g) {
      if (!g.length) throw new Error('no POS data');
      S.shopProdSource = 'pos';
      S.shops = g.map(function (x) { return { label: label(x.config_id, 'Unknown shop'), value: Number(x.amount_total) || 0, count: x.__count || 0 }; })
        .sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
      $('ovShopsT').textContent = 'Sales by POS shop';
      $('ovShopsS').textContent = 'Revenue per point-of-sale · selected period';
      drawShops();
    }).catch(function () {
      /* Fallback: sale.order grouped by warehouse (shop = warehouse) */
      S.shopProdSource = 'sale';
      return C.readGroup('sale.order', {
        domain: CONF.concat([['date_order', '>=', d]]),
        fields: ['amount_total:sum'], groupby: ['warehouse_id']
      }).then(function (g) {
        S.shops = g.map(function (x) { return { label: label(x.warehouse_id, 'Default'), value: Number(x.amount_total) || 0, count: x.__count || 0 }; })
          .sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
        $('ovShopsT').textContent = 'Sales by warehouse / location';
        $('ovShopsS').textContent = 'Revenue per warehouse · selected period';
        drawShops();
      }).catch(function (e) { fail('ovShops', e); });
    });
  }
  function jobShopProd(days) {
    /* Top products: POS order lines first, then sale.order lines */
    var d = iso(days);
    var posDom = [['order_id.state', 'in', ['done', 'invoiced']], ['order_id.date_order', '>=', d]];
    var saleDom = [['order_id.state', 'in', ['sale', 'done']], ['order_id.date_order', '>=', d]];
    var src = S.shopProdSource === 'pos' ? C.readGroup('pos.order.line', { domain: posDom, fields: ['price_subtotal:sum'], groupby: ['product_id'] })
                                         : Promise.reject(new Error('use sale'));
    return src.catch(function () {
      return C.readGroup('sale.order.line', { domain: saleDom, fields: ['price_subtotal:sum'], groupby: ['product_id'] });
    }).then(function (g) {
      if (!g.length) { body('ovShopProd', '<div class="olx-empty-s">No product sales in this period.</div>'); return; }
      S.shopProd = g.map(function (x) { return { label: label(x.product_id, 'Unknown'), value: Number(x.price_subtotal) || 0, count: x.__count || 0 }; })
        .filter(function (r) { return r.value > 0; })
        .sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
      drawShopProd();
    }).catch(function (e) { fail('ovShopProd', e); });
  }

  /* -- Drawing ------------------------------------------------------------------ */
  var COMPACT = function (v) { return F.money(v, true); };
  function drawTrend() {
    var t = S.trend, th = F.theme(); if (!t) return;
    if (!t.rev.length) return body('ovTrend', '<div class="olx-empty-s">No confirmed sales in the last 12 months.</div>');
    var id = canvas('ovTrend');
    F.chart(id, { type: 'bar', data: { labels: t.labels, datasets: [
      { type: 'line', label: 'Revenue', data: t.rev, yAxisID: 'y', borderColor: F.PALETTE[0], backgroundColor: F.PALETTE[0] + '22', fill: true, tension: 0.35, borderWidth: 2.5, pointRadius: 3, order: 1 },
      { type: 'bar', label: 'Orders', data: t.cnt, yAxisID: 'y1', backgroundColor: F.PALETTE[1] + '66', borderRadius: 4, maxBarThickness: 26, order: 2 }] },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true, position: 'bottom', labels: { color: th.text, boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: function (c) { return ' ' + c.dataset.label + ': ' + (c.datasetIndex === 0 ? F.money(c.raw) : F.num(c.raw)); } } } },
        scales: { x: { grid: { display: false }, ticks: { color: th.text } }, y: { grid: { color: th.grid }, ticks: { color: th.text, callback: COMPACT }, beginAtZero: true }, y1: { position: 'right', grid: { display: false }, ticks: { color: th.text, precision: 0 }, beginAtZero: true } } } });
  }
  function legend(rows) {
    var tot = rows.reduce(function (s, r) { return s + r.value; }, 0) || 1;
    return rows.map(function (r, i) { return '<div class="olx-leg"><i style="background:' + F.PALETTE[i % F.PALETTE.length] + '"></i><span title="' + esc(r.label) + '">' + esc(r.label) + '</span><b>' + F.money(r.value, true) + '</b><em>' + Math.round(r.value / tot * 100) + '%</em></div>'; }).join('');
  }
  function donut(id, rows) {
    var th = F.theme(), cv = canvas(id);
    F.chart(cv, { type: 'doughnut', data: { labels: rows.map(function (r) { return r.label; }), datasets: [{ data: rows.map(function (r) { return r.value; }), backgroundColor: F.PALETTE, borderColor: th.light ? '#fff' : 'rgba(0,0,0,0)', borderWidth: 3, hoverOffset: 6 }] }, options: { cutout: '68%', plugins: { tooltip: { callbacks: { label: function (c) { return ' ' + F.money(c.raw); } } } } } });
    $(id + 'L').innerHTML = legend(rows);
  }
  function drawCat() {
    var c = S.cat; if (!c) return; $('ovCatT').textContent = c.title; $('ovCatS').textContent = c.sub;
    if (!c.rows.length) { body('ovCat', '<div class="olx-empty-s">No sales in this period.</div>'); $('ovCatL').innerHTML = ''; return; }
    donut('ovCat', c.rows);
  }
  function drawInv() {
    if (!S.inv) return;
    if (!S.inv.length) { body('ovInv', '<div class="olx-empty-s">No posted customer invoices.</div>'); $('ovInvL').innerHTML = ''; return; }
    donut('ovInv', S.inv);
  }
  function drawTop() {
    var rows = S.top || []; if (!rows.length) return body('ovTop', '<div class="olx-empty-s">No sales in this period.</div>');
    var max = rows[0].value || 1;
    body('ovTop', '<div class="ov-bars">' + rows.map(function (r, i) {
      return '<div class="ov-bar-row"><span class="ov-rank">' + (i + 1) + '</span><div class="ov-bar-main"><div class="ov-bar-top"><span title="' + esc(r.label) + '">' + esc(r.label) + '</span><b>' + F.money(r.value, true) + '</b></div><div class="ov-bar-track"><i style="width:' + Math.max(4, Math.round(r.value / max * 100)) + '%"></i></div></div></div>';
    }).join('') + '</div>');
  }
  function drawPipe() {
    var th = F.theme(), rows = S.pipe || []; if (!rows.length) return body('ovPipe', '<div class="olx-empty-s">No opportunities in the pipeline.</div>');
    var cv = canvas('ovPipe');
    F.chart(cv, { type: 'bar', data: { labels: rows.map(function (r) { return r.label; }), datasets: [{ data: rows.map(function (r) { return r.value; }), backgroundColor: F.PALETTE[2] + 'cc', borderRadius: 6, maxBarThickness: 34 }] },
      options: { plugins: { tooltip: { callbacks: { label: function (c) { return ' ' + F.money(c.raw) + ' · ' + rows[c.dataIndex].count + ' deals'; } } } }, scales: { x: { grid: { display: false }, ticks: { color: th.text } }, y: { grid: { color: th.grid }, ticks: { color: th.text, callback: COMPACT }, beginAtZero: true } } } });
  }
  function drawRecent() {
    var rows = S.recent; if (!rows.length) return body('ovRec', '<div class="olx-empty-s">No sales orders yet.</div>');
    body('ovRec', '<div class="table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Customer</th><th>Salesperson</th><th>Date</th><th class="olx-r">Total</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function (o) {
        return '<tr><td class="mono">' + esc(o.name) + '</td><td>' + esc(label(o.partner_id)) + '</td><td>' + esc(label(o.user_id, '–')) + '</td><td class="mono">' + esc(F.when(o.date_order)) + '</td><td class="olx-r">' + esc(F.money(o.amount_total)) + '</td>' +
          '<td><span class="status-pill ' + (STATE_CLS[o.state] || 'review') + '">' + esc(STATE_LBL[o.state] || o.state) + '</span></td></tr>';
      }).join('') + '</tbody></table></div>');
  }
  function drawShops() {
    var rows = S.shops || [];
    if (!rows.length) { body('ovShops', '<div class="olx-empty-s">No shop/warehouse data in this period.</div>'); return; }
    var th = F.theme(), topShop = rows[0];
    /* Badge for top shop */
    var badge = '<div class="ov-top-shop-badge"><span class="status-pill active">🏆 ' + esc(topShop.label) + '</span><span class="ov-shop-stat">' + F.money(topShop.value, topShop.value >= 1e5) + ' · ' + F.num(topShop.count) + ' orders</span></div>';
    var cv = canvas('ovShops');
    /* Put badge in the subtitle slot */
    var sub = $('ovShopsS'); if (sub) sub.innerHTML = (sub.textContent || '') + ' &nbsp;' + badge;
    var colors = rows.map(function (r, i) { return F.PALETTE[i % F.PALETTE.length]; });
    F.chart(cv, {
      type: 'bar',
      data: { labels: rows.map(function (r) { return r.label; }), datasets: [{
        data: rows.map(function (r) { return r.value; }),
        backgroundColor: colors.map(function (c) { return c + 'cc'; }),
        borderColor: colors,
        borderWidth: 1.5,
        borderRadius: 6,
        maxBarThickness: 52
      }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) {
          var r = rows[c.dataIndex];
          return [' Revenue: ' + F.money(c.raw), ' Orders: ' + F.num(r.count)];
        } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: th.text, maxRotation: 30 } },
          y: { grid: { color: th.grid }, ticks: { color: th.text, callback: COMPACT }, beginAtZero: true }
        }
      }
    });
  }
  function drawShopProd() {
    var rows = S.shopProd || [];
    if (!rows.length) { body('ovShopProd', '<div class="olx-empty-s">No product data in this period.</div>'); return; }
    var max = rows[0].value || 1;
    body('ovShopProd', '<div class="ov-bars">' + rows.map(function (r, i) {
      return '<div class="ov-bar-row">' +
        '<span class="ov-rank">' + (i + 1) + '</span>' +
        '<div class="ov-bar-main">' +
          '<div class="ov-bar-top">' +
            '<span title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
            '<b>' + F.money(r.value, true) + '</b>' +
          '</div>' +
          '<div class="ov-bar-track"><i style="width:' + Math.max(4, Math.round(r.value / max * 100)) + '%;background:' + F.PALETTE[i % F.PALETTE.length] + '"></i></div>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>');
  }

  function redraw() { drawTrend(); drawCat(); drawInv(); drawTop(); drawPipe(); drawShops(); drawShopProd(); }

  /* -- Widget Builder compatibility (its “Odoo overview” source reads this) ------ */
  function publish() {
    var t = S.trend || { labels: [], rev: [], cnt: [] }, cat = (S.cat && S.cat.rows) || [], top = S.top || [];
    window.DASHVIEW_OV = {
      MONTHS: t.labels, REVENUE: t.rev, ORDERS_M: t.cnt, CATS: cat.map(function (r) { return r.label; }), CAT_REV: cat.map(function (r) { return r.value; }),
      TOP_L: top.map(function (r) { return r.label; }), TOP_V: top.map(function (r) { return r.value; }),
      ORDERS: S.recent.map(function (o) { return { id: o.name, customer: label(o.partner_id), state: STATE_LBL[o.state] || o.state, revenue: o.amount_total, date: o.date_order }; }),
      SUMMARY: { revenue12: t.rev.reduce(function (a, b) { return a + b; }, 0), orders12: t.cnt.reduce(function (a, b) { return a + b; }, 0) }
    };
    document.dispatchEvent(new CustomEvent('dv:overview-data'));
  }
  window.DASHVIEW_OV = window.DASHVIEW_OV || { MONTHS: [], REVENUE: [], ORDERS_M: [], CATS: [], CAT_REV: [], TOP_L: [], TOP_V: [], ORDERS: [], SUMMARY: { revenue12: 0, orders12: 0 } };

  /* -- Orchestration -------------------------------------------------------------- */
  function loadAll() {
    if (!banner()) { emptyState(); return; }
    var seq = ++S.seq, days = S.range, t0 = Date.now();
    setStatus('connecting', 'Syncing…');
    Promise.all([jobSales(days), jobTrend(), jobCategory(days), jobTop(days), jobPipeline(), jobInvoices(), jobCustomers(), jobRecent(), jobShops(days), jobShopProd(days)]).then(function () {
      if (seq !== S.seq) return;
      S.lastSynced = new Date(); setStatus('live', 'Live · synced ' + S.lastSynced.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' · ' + (Date.now() - t0) + ' ms'); publish();
    });
  }
  function exportCsv() {
    if (!S.sum) { if (window.showToast) window.showToast('Connect Odoo first \u2014 nothing to export yet.'); return; }
    var rows = [['Metric', 'Value'], ['Period (days)', S.sum.days], ['Revenue', S.sum.revenue], ['Orders', S.sum.orders], ['Average order value', S.sum.aov.toFixed(2)], [], ['Month', 'Revenue', 'Orders']];
    if (S.trend) S.trend.labels.forEach(function (l, i) { rows.push([l, S.trend.rev[i], S.trend.cnt[i]]); });
    rows.push([], ['Order', 'Customer', 'Total', 'Status']);
    S.recent.forEach(function (o) { rows.push([o.name, label(o.partner_id), o.amount_total, STATE_LBL[o.state] || o.state]); });
    F.download('odoo-overview-' + new Date().toISOString().slice(0, 10) + '.csv', F.csv(rows));
    if (window.DVSec) window.DVSec.log('Exported overview', 'CSV summary');
  }

  function init() {
    var d = new Date(), h = d.getHours(), name = '';
    try { name = (JSON.parse(localStorage.getItem('dashview_profile')) || {}).displayName || ''; } catch (e) {}
    if (!name) { try { var u = window.DVAuth && window.DVAuth.currentUser && window.DVAuth.currentUser(); name = (u && u.name) || ''; } catch (e) {} }
    $('ovGreeting').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + name.split(' ')[0] : '') + '.';
    $('dateLabel').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    build();
    document.querySelectorAll('#ovRange button').forEach(function (b) {
      b.addEventListener('click', function () { document.querySelectorAll('#ovRange button').forEach(function (x) { x.classList.toggle('active', x === b); }); S.range = +b.getAttribute('data-range'); loadAll(); });
    });
    $('ovRefresh').addEventListener('click', function () { C.reset(); loadAll(); });
    $('ovExport').addEventListener('click', exportCsv);
    ['dv:odoo-config-saved', 'dv:unlocked'].forEach(function (ev) { document.addEventListener(ev, function () { C.reset(); loadAll(); }); });
    window.__overviewExportCSV = exportCsv; // shared hook: command palette \u201cExport\u201d + Reports \u2192 Sales Overview Report
    document.addEventListener('dv:locked', function () { banner(); emptyState(); });
    window.addEventListener('storage', function (e) { if (e.key === 'dashview_odoo_config') loadAll(); });
    window.applyOverviewChartTheme = redraw;
    S.timer = setInterval(function () { if (root.classList.contains('active') && !document.hidden && C.state() === 'ok') loadAll(); }, 60000);
    var start = root.classList.contains('active') || /^#(widgets)?$/.test(location.hash) ;
    if (start) loadAll(); else banner();
    document.querySelectorAll('[data-view="overview"]').forEach(function (l) { l.addEventListener('click', function () { if (!S.lastSynced) loadAll(); }); });
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
