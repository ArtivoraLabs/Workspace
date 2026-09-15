/* ==========================================================================
   DashView Pro — additive layer on top of overview.js:
   - Region filter + role-based views (Admin / Sales Manager / Sales Rep)
   - Multi-board switching (Sales / Marketing / Finance) — each board is its
     own mini dashboard with its own KPIs and charts
   - Real-time simulation ("Live" toggle) — generates new orders client-side
     on an interval and threads them through KPIs, charts and the table,
     consistent with this app's zero-network-calls design
   - Region performance + customer-mix charts, a sales funnel
   - KPI sparklines
   - Export menu: CSV (reuses overview.js), Excel (.xlsx via SheetJS),
     PDF (print), and a copyable text summary ("share")
   No network calls. No external state. Everything here is deterministic or
   derived from the same in-memory ORDERS dataset overview.js already builds.
   ========================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var OV = window.DASHVIEW_OV;
    if (!OV) return; // overview.js didn't load (e.g. a page that doesn't use it)

    var byId = function (id) { return document.getElementById(id); };
    var toast = function (msg) { if (window.showToast) window.showToast(msg); };

    var state = { role: 'admin', region: '', board: 'sales', range: 30, live: false, liveTimer: null };

    /* ── Date range anchor ────────────────────────────────────────────────
       The seed dataset is dated across a fixed calendar year, and live mode
       appends orders stamped with the real "now". To make 7D/30D/90D/1Y mean
       something real for both, we anchor "today" to the most recent order
       date we currently know about (recomputed each time, so it tracks live
       inflow) rather than the browser's wall-clock date. */
    var DAY_MS = 86400000;
    function rangeAnchorMs() {
      // Anchor only on the historical (non-live) dataset, which never changes —
      // otherwise the very first live-generated order (stamped with today's real
      // date) would yank the anchor years forward and make the whole historical
      // dataset fall outside every range.
      var max = -Infinity;
      OV.ORDERS.forEach(function (o) { if (o.live) return; var t = Date.parse(o.date); if (t > max) max = t; });
      return isFinite(max) ? max : Date.now();
    }
    function inWindow(dateStr, anchor, startOffsetDays, endOffsetDays) {
      var t = Date.parse(dateStr);
      var start = anchor - startOffsetDays * DAY_MS;
      var end = anchor - endOffsetDays * DAY_MS;
      return t > start && t <= end;
    }

    /* ────────────────────────── Sparklines ────────────────────────────── */
    function drawSpark(canvasId, values, color) {
      var el = byId(canvasId);
      if (!el || !window.Chart) return null;
      return new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels: values.map(function (_, i) { return i; }), datasets: [{
          data: values, borderColor: color, borderWidth: 2, pointRadius: 0, tension: .4, fill: false
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
          elements: { line: { borderCapStyle: 'round' } }
        }
      });
    }
    var custByMonth = new Array(12).fill(0);
    OV.ORDERS.forEach(function (o) { custByMonth[parseInt(o.date.slice(5, 7), 10) - 1] += 1; });
    drawSpark('sparkRevenue', OV.REVENUE, '#e8a33d');
    drawSpark('sparkOrders', OV.ORDERS_M, '#5b8fae');
    drawSpark('sparkCustomers', custByMonth, '#4fb477');

    /* ────────────────────────── Region filter ─────────────────────────── */
    var regionSel = byId('regionFilter');
    OV.REGIONS.forEach(function (r) {
      var opt = document.createElement('option'); opt.value = r; opt.textContent = r;
      regionSel.appendChild(opt);
    });

    /* ────────────────────── Aggregates for a subset ────────────────────── */
    function computeAggregates(subset) {
      var revenue = 0, qty = 0; var custMap = {};
      subset.forEach(function (o) {
        revenue += o.revenue; qty += o.qty;
        if (!custMap[o.customer]) custMap[o.customer] = 0;
        custMap[o.customer] += 1;
      });
      var custNames = Object.keys(custMap);
      var repeat = custNames.filter(function (c) { return custMap[c] > 1; }).length;
      return {
        revenue: revenue, orders: subset.length, customers: custNames.length,
        aov: subset.length ? revenue / subset.length : 0,
        repeatPct: custNames.length ? Math.round(repeat / custNames.length * 100) : 0,
        avgItems: subset.length ? (qty / subset.length).toFixed(1) : '0',
        newCust: custNames.length - repeat, returningCust: repeat
      };
    }

    function catBreakdown(subset) {
      var map = {}; OV.CATS.forEach(function (c) { map[c] = 0; });
      subset.forEach(function (o) { map[o.category] += o.revenue; });
      return OV.CATS.map(function (c) { return map[c]; });
    }
    function regionBreakdown(subset) {
      var map = {}; OV.REGIONS.forEach(function (r) { map[r] = 0; });
      subset.forEach(function (o) { map[o.region] += o.revenue; });
      return OV.REGIONS.map(function (r) { return map[r]; });
    }

    /* ────────────────────────── New charts ─────────────────────────────── */
    var ct = OV.chartTheme();
    var regionBarChart = new Chart(byId('regionBarChart').getContext('2d'), {
      type: 'bar',
      data: { labels: OV.REGIONS, datasets: [{ data: regionBreakdown(OV.ORDERS), backgroundColor: OV.REGION_COLORS, borderRadius: 6, maxBarThickness: 36 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          backgroundColor: ct.tooltipBg, borderColor: ct.tooltipBorder, borderWidth: 1,
          titleColor: ct.tooltipTitle, bodyColor: ct.tooltipBody,
          callbacks: { label: function (c) { return ' $' + (c.raw / 1000).toFixed(1) + 'k'; } }
        } },
        scales: { x: { grid: { color: ct.gridY }, ticks: { callback: function (v) { return '$' + (v / 1000).toFixed(0) + 'k'; }, font: { size: 11 } } }, y: { grid: { display: false } } }
      }
    });

    var newReturningChart = new Chart(byId('newReturningChart').getContext('2d'), {
      type: 'doughnut',
      data: { labels: ['New', 'Returning'], datasets: [{ data: [1, 1], backgroundColor: ['#e8a33d', '#4fb477'], borderColor: 'rgba(0,0,0,0)', borderWidth: 4, hoverOffset: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { display: false }, tooltip: {
        backgroundColor: ct.tooltipBg, borderColor: ct.tooltipBorder, borderWidth: 1, titleColor: ct.tooltipTitle, bodyColor: ct.tooltipBody
      } } }
    });

    /* ────────────────────────── Funnel ─────────────────────────────────── */
    function renderFunnel(orderCount) {
      var stages = [
        { label: 'Leads', mult: 4.4, color: '#e8a33d' },
        { label: 'Qualified', mult: 2.3, color: '#f0c06a' },
        { label: 'Proposal Sent', mult: 1.35, color: '#5b8fae' },
        { label: 'Closed Won', mult: 1, color: '#4fb477' }
      ];
      var max = Math.max(1, Math.round(orderCount * stages[0].mult));
      var html = stages.map(function (s) {
        var v = Math.max(1, Math.round(orderCount * s.mult));
        var pct = Math.max(6, Math.round(v / max * 100));
        return '<div class="funnel-row">'
          + '<span class="funnel-label">' + s.label + '</span>'
          + '<div class="funnel-track"><div class="funnel-fill" style="width:' + pct + '%;background:' + s.color + '">' + v.toLocaleString() + '</div></div>'
          + '<span class="funnel-meta">' + Math.round(v / max * 100) + '%</span>'
          + '</div>';
      }).join('');
      byId('salesFunnel').innerHTML = html;
    }

    /* ─────────────────────────── Recompute all ─────────────────────────── */
    // Single source of truth: region + role + date-range, combined. Every KPI,
    // chart, the funnel, the orders table and CSV/PDF export all read through
    // these two functions so the whole board stays in sync with one filter set.
    function matchRegionRole(o) {
      var matchRegion = !state.region || o.region === state.region;
      var matchRole = state.role !== 'rep' || o.customer === repAssignedCustomer;
      return matchRegion && matchRole;
    }
    function currentSubset() {
      var anchor = rangeAnchorMs();
      return OV.ORDERS.filter(function (o) {
        // Live-simulated orders always count as "just happened" — they carry
        // today's real date, which is outside every synthetic-calendar window.
        return matchRegionRole(o) && (o.live || inWindow(o.date, anchor, state.range, 0));
      });
    }
    function previousSubset() {
      var anchor = rangeAnchorMs();
      return OV.ORDERS.filter(function (o) {
        return matchRegionRole(o) && !o.live && inWindow(o.date, anchor, state.range * 2, state.range);
      });
    }

    function fmtK(n) { return '$' + (n / 1000).toFixed(1) + 'k'; }
    function pctDelta(curr, prev) {
      if (!prev) return curr ? { pct: 100, dir: 'up' } : { pct: 0, dir: 'neutral' };
      var pct = (curr - prev) / prev * 100;
      return { pct: pct, dir: pct > 0.05 ? 'up' : (pct < -0.05 ? 'down' : 'neutral') };
    }
    function deltaLabel(curr, prev, unit) {
      var d = pctDelta(curr, prev);
      var arrow = d.dir === 'up' ? '↑' : (d.dir === 'down' ? '↓' : '—');
      var text = arrow + ' ' + Math.abs(d.pct).toFixed(1) + (unit || '%') + ' vs prior ' + state.range + 'D';
      return { text: text, dir: d.dir };
    }
    function setDelta(id, curr, prev) {
      var el = byId(id);
      if (!el) return;
      var d = deltaLabel(curr, prev);
      el.textContent = d.text;
      el.className = 'kpi-delta ' + d.dir;
    }

    function recomputeAll() {
      var subset = currentSubset();
      var prevSubset = previousSubset();
      var agg = computeAggregates(subset);
      var prevAgg = computeAggregates(prevSubset);

      byId('kpiRevenue').textContent = fmtK(agg.revenue);
      byId('kpiOrders').textContent = agg.orders.toLocaleString();
      byId('kpiCustomers').textContent = agg.customers.toLocaleString();
      byId('kpiAOV').textContent = '$' + agg.aov.toFixed(2);
      byId('kpiRepeat').textContent = agg.repeatPct + '%';
      byId('kpiAvgItems').textContent = agg.avgItems;

      // Item #1: real, calculated deltas — current period vs the prior period
      // of the same length, both drawn from the live-filtered dataset.
      setDelta('kpiRevDelta', agg.revenue, prevAgg.revenue);
      setDelta('kpiOrdersDelta', agg.orders, prevAgg.orders);
      setDelta('kpiCustomersDelta', agg.customers, prevAgg.customers);
      setDelta('kpiAOVDelta', agg.aov, prevAgg.aov);

      var catData = catBreakdown(subset);
      OV.charts.category.data.datasets[0].data = catData;
      OV.charts.category.update('none');

      regionBarChart.data.datasets[0].data = regionBreakdown(subset);
      regionBarChart.update('none');

      newReturningChart.data.datasets[0].data = [agg.newCust || 1, agg.returningCust || 1];
      newReturningChart.update('none');
      byId('newReturningLegend').innerHTML =
        '<span class="legend-item"><span class="legend-dot" style="background:#e8a33d"></span>New (' + agg.newCust + ')</span>' +
        '<span class="legend-item"><span class="legend-dot" style="background:#4fb477"></span>Returning (' + agg.returningCust + ')</span>';

      renderFunnel(agg.orders);

      // Item #4: Marketing / Finance boards ride the same region + role +
      // date-range + live filter as the Sales board.
      updateMarketingBoard(subset, prevSubset);
      updateFinanceBoard(subset, prevSubset);

      window.__ovExtraFilter = function (o) {
        var anchor = rangeAnchorMs();
        return matchRegionRole(o) && (o.live || inWindow(o.date, anchor, state.range, 0));
      };
      if (window.__ovApplyFilter) window.__ovApplyFilter();
    }

    /* ─────────────────────── Role-based view gating ────────────────────── */
    var repAssignedCustomer = OV.ORDERS[0] ? OV.ORDERS[0].customer : null;
    var roleOnlyPanels = ['#topCustomersList', '#regionList', '#goalRing'].map(function (sel) {
      var el = document.querySelector(sel); return el ? el.closest('.panel') : null;
    }).filter(Boolean);
    var regionMixGrid = byId('regionMixGrid');
    var pipelinePanel = byId('pipelinePanel');
    var exportMenu = byId('exportMenu');
    var roleNote = byId('roleNote');
    var boardTabs = document.querySelectorAll('.board-tab');

    function applyRole(role) {
      state.role = role;
      var isRep = role === 'rep';
      roleOnlyPanels.forEach(function (p) { p.classList.toggle('pro-hidden-by-role', isRep); });
      regionMixGrid.classList.toggle('pro-hidden-by-role', isRep);
      pipelinePanel.classList.toggle('pro-hidden-by-role', isRep);

      var xlsxBtn = exportMenu.querySelector('[data-export="xlsx"]');
      var shareBtn = exportMenu.querySelector('[data-export="share"]');
      xlsxBtn.disabled = isRep;
      shareBtn.disabled = isRep;

      boardTabs.forEach(function (btn) {
        var board = btn.dataset.board;
        var locked = (board !== 'sales') && (isRep || (role === 'manager' && board === 'marketing'));
        btn.classList.toggle('locked', locked);
      });

      if (isRep) {
        roleNote.style.display = 'block';
        roleNote.textContent = '🔒 Sales Rep view — showing your own orders only. Company-wide panels, other boards and bulk export are restricted.';
        if (state.board !== 'sales') switchBoard('sales');
      } else if (role === 'manager') {
        roleNote.style.display = 'block';
        roleNote.textContent = '🔒 Sales Manager view — Marketing board is Admin-only.';
        if (state.board === 'marketing') switchBoard('sales');
      } else {
        roleNote.style.display = 'none';
      }
      recomputeAll();
    }

    byId('roleSelect').addEventListener('change', function (e) { applyRole(e.target.value); });

    regionSel.addEventListener('change', function (e) { state.region = e.target.value; recomputeAll(); });

    /* ── Date range (item #2: synced with region + role, applied everywhere) ── */
    document.querySelectorAll('.date-range button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.date-range button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.range = parseInt(btn.dataset.range, 10) || 30;
        recomputeAll();
        toast('View updated to last ' + btn.dataset.range + ' days');
      });
    });

    /* ───────────────────────────── Boards ──────────────────────────────── */
    function switchBoard(board) {
      var btn = document.querySelector('.board-tab[data-board="' + board + '"]');
      if (btn && btn.classList.contains('locked')) {
        toast('This board is restricted for your current role.');
        return;
      }
      state.board = board;
      boardTabs.forEach(function (b) { b.classList.toggle('active', b.dataset.board === board); });
      ['sales', 'marketing', 'finance'].forEach(function (b) {
        var el = byId('board-' + b); if (el) el.style.display = (b === board) ? '' : 'none';
      });
      // Canvases inside a panel that was display:none report zero size until now.
      if (board === 'marketing' || board === 'finance') {
        requestAnimationFrame(function () {
          try {
            if (marketingChannelChart) { marketingChannelChart.resize(); marketingCampaignChart.resize(); }
            if (financePnlChart) { financePnlChart.resize(); financeExpenseChart.resize(); }
          } catch (e) {}
        });
      }
    }
    boardTabs.forEach(function (btn) { btn.addEventListener('click', function () { switchBoard(btn.dataset.board); }); });

    function kpiCard(cls, label, value, delta, deltaCls) {
      return '<div class="kpi-card ' + cls + '"><div class="kpi-top"></div><p class="kpi-label">' + label + '</p>' +
        '<p class="kpi-value">' + value + '</p><p class="kpi-delta ' + deltaCls + '">' + delta + '</p>' +
        '<div class="kpi-spark-wrap kpi-spark-wrap-empty"></div></div>';
    }

    // How much of the whole dataset's revenue the current region/role/date
    // filter represents — used to scale the (inherently seasonal, 12-month)
    // reference trend charts so Marketing/Finance move with the same filters
    // as the Sales board instead of always showing the full-year picture.
    function scaleFactor(subset) {
      var subRev = subset.reduce(function (s, o) { return s + o.revenue; }, 0);
      var fullRev = OV.ORDERS.reduce(function (s, o) { return s + o.revenue; }, 0);
      return fullRev ? (subRev / fullRev) : 1;
    }

    /* ── Marketing board ──────────────────────────────────────────────── */
    function marketingMetrics(subset) {
      var agg = computeAggregates(subset);
      var visitors = Math.round(agg.orders * 21.4);
      var conv = visitors ? (agg.orders / visitors * 100) : 0;
      var adSpend = Math.round(agg.revenue * 0.09);
      var cac = agg.orders ? (adSpend / agg.orders) : 0;
      return { visitors: visitors, conv: conv, adSpend: adSpend, cac: cac, revenue: agg.revenue };
    }
    var marketingChannelChart = null, marketingCampaignChart = null;
    function buildMarketingBoard(subset) {
      var m = marketingMetrics(subset);
      var channels = ['Organic Search', 'Paid Search', 'Social', 'Email', 'Referral', 'Direct'];
      var weights = [.32, .24, .18, .12, .08, .06];
      marketingChannelChart = new Chart(byId('marketingChannelChart').getContext('2d'), {
        type: 'bar',
        data: { labels: channels, datasets: [{ data: weights.map(function (w) { return Math.round(m.visitors * w); }), backgroundColor: '#8b5cf6', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: ct.gridY } }, x: { grid: { display: false } } } }
      });
      var sf = scaleFactor(subset);
      marketingCampaignChart = new Chart(byId('marketingCampaignChart').getContext('2d'), {
        type: 'line',
        data: { labels: OV.MONTHS, datasets: [
          { label: 'Spend', data: OV.REVENUE.map(function (v) { return Math.round(v * 0.09 * sf); }), borderColor: '#e5654f', backgroundColor: 'transparent', borderWidth: 2, tension: .4 },
          { label: 'Conversions', data: OV.ORDERS_M.map(function (v) { return Math.round(v * 1.15 * sf); }), borderColor: '#8b5cf6', backgroundColor: 'transparent', borderWidth: 2, tension: .4 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }, scales: { y: { grid: { color: ct.gridY } }, x: { grid: { display: false } } } }
      });
    }
    function updateMarketingBoard(subset, prevSubset) {
      var m = marketingMetrics(subset), p = marketingMetrics(prevSubset);
      var dVisitors = deltaLabel(m.visitors, p.visitors), dConv = deltaLabel(m.conv, p.conv);
      var dSpend = deltaLabel(m.adSpend, p.adSpend), dCac = deltaLabel(m.cac, p.cac);
      byId('marketingKpiGrid').innerHTML =
        kpiCard('c-purple', 'Website Visitors', m.visitors.toLocaleString(), dVisitors.text, dVisitors.dir) +
        kpiCard('c-signal', 'Conversion Rate', m.conv.toFixed(2) + '%', dConv.text, dConv.dir) +
        kpiCard('c-danger', 'Ad Spend', '$' + m.adSpend.toLocaleString(), dSpend.text, dSpend.dir) +
        kpiCard('c-teal', 'Customer Acq. Cost', '$' + m.cac.toFixed(2), dCac.text, dCac.dir) +
        kpiCard('c-emerald', 'Email Open Rate', '34.6%', 'Modeled — not order-derived', 'neutral') +
        kpiCard('c-accent2', 'Social Engagement', '4.8%', 'Modeled — not order-derived', 'neutral');

      if (!marketingChannelChart) { buildMarketingBoard(subset); return; }
      var weights = [.32, .24, .18, .12, .08, .06];
      marketingChannelChart.data.datasets[0].data = weights.map(function (w) { return Math.round(m.visitors * w); });
      marketingChannelChart.update('none');
      var sf = scaleFactor(subset);
      marketingCampaignChart.data.datasets[0].data = OV.REVENUE.map(function (v) { return Math.round(v * 0.09 * sf); });
      marketingCampaignChart.data.datasets[1].data = OV.ORDERS_M.map(function (v) { return Math.round(v * 1.15 * sf); });
      marketingCampaignChart.update('none');
    }

    /* ── Finance board ────────────────────────────────────────────────── */
    function financeMetrics(subset) {
      var agg = computeAggregates(subset);
      var opex = Math.round(agg.revenue * 0.38);
      var netProfit = Math.round(agg.revenue * 0.24);
      var cashFlow = Math.round(netProfit * 1.12);
      var outstanding = Math.round(agg.revenue * 0.06);
      var burn = Math.round(opex / 12);
      return { revenue: agg.revenue, grossMarginPct: 62, opex: opex, netProfit: netProfit, cashFlow: cashFlow, outstanding: outstanding, burn: burn };
    }
    var financePnlChart = null, financeExpenseChart = null;
    function buildFinanceBoard(subset) {
      var f = financeMetrics(subset);
      var sf = scaleFactor(subset);
      var revScaled = OV.REVENUE.map(function (v) { return Math.round(v * sf); });
      var expenses = OV.REVENUE.map(function (v) { return Math.round(v * (0.62 + (Math.sin(v) * 0.03)) * sf); });
      var profit = revScaled.map(function (v, i) { return v - expenses[i]; });
      financePnlChart = new Chart(byId('financePnlChart').getContext('2d'), {
        type: 'line',
        data: { labels: OV.MONTHS, datasets: [
          { label: 'Revenue', data: revScaled, borderColor: '#e8a33d', backgroundColor: 'transparent', borderWidth: 2, tension: .4 },
          { label: 'Expenses', data: expenses, borderColor: '#e5654f', backgroundColor: 'transparent', borderWidth: 2, tension: .4 },
          { label: 'Profit', data: profit, borderColor: '#4fb477', backgroundColor: 'transparent', borderWidth: 2, tension: .4 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }, scales: { y: { grid: { color: ct.gridY }, ticks: { callback: function (v) { return '$' + (v / 1000).toFixed(0) + 'k'; } } }, x: { grid: { display: false } } } }
      });
      var depts = ['Payroll', 'Marketing', 'R&D', 'Operations', 'Facilities', 'Other'];
      var deptWeights = [.46, .18, .16, .10, .06, .04];
      financeExpenseChart = new Chart(byId('financeExpenseChart').getContext('2d'), {
        type: 'doughnut',
        data: { labels: depts, datasets: [{ data: deptWeights.map(function (w) { return Math.round(f.opex * w); }), backgroundColor: ['#e8a33d', '#8b5cf6', '#5b8fae', '#4fb477', '#f0c06a', '#e5654f'], borderColor: 'rgba(0,0,0,0)', borderWidth: 4, hoverOffset: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } } }
      });
    }
    function updateFinanceBoard(subset, prevSubset) {
      var f = financeMetrics(subset), p = financeMetrics(prevSubset);
      var dProfit = deltaLabel(f.netProfit, p.netProfit), dOpex = deltaLabel(f.opex, p.opex);
      var dCash = deltaLabel(f.cashFlow, p.cashFlow), dOut = deltaLabel(f.outstanding, p.outstanding);
      var dBurn = deltaLabel(f.burn, p.burn);
      byId('financeKpiGrid').innerHTML =
        kpiCard('c-emerald', 'Gross Margin', f.grossMarginPct + '%', 'Modeled at 62% of revenue', 'neutral') +
        kpiCard('c-signal', 'Net Profit', '$' + f.netProfit.toLocaleString(), dProfit.text, dProfit.dir) +
        kpiCard('c-danger', 'Operating Expenses', '$' + f.opex.toLocaleString(), dOpex.text, dOpex.dir) +
        kpiCard('c-teal', 'Cash Flow', '$' + f.cashFlow.toLocaleString(), dCash.text, dCash.dir) +
        kpiCard('c-accent2', 'Outstanding Invoices', '$' + f.outstanding.toLocaleString(), dOut.text, dOut.dir) +
        kpiCard('c-purple', 'Monthly Burn Rate', '$' + f.burn.toLocaleString(), dBurn.text, dBurn.dir);

      if (!financePnlChart) { buildFinanceBoard(subset); return; }
      var sf = scaleFactor(subset);
      var revScaled = OV.REVENUE.map(function (v) { return Math.round(v * sf); });
      var expenses = OV.REVENUE.map(function (v) { return Math.round(v * (0.62 + (Math.sin(v) * 0.03)) * sf); });
      var profit = revScaled.map(function (v, i) { return v - expenses[i]; });
      financePnlChart.data.datasets[0].data = revScaled;
      financePnlChart.data.datasets[1].data = expenses;
      financePnlChart.data.datasets[2].data = profit;
      financePnlChart.update('none');
      var deptWeights = [.46, .18, .16, .10, .06, .04];
      financeExpenseChart.data.datasets[0].data = deptWeights.map(function (w) { return Math.round(f.opex * w); });
      financeExpenseChart.update('none');
    }

    /* ──────────────────────── Live simulation ──────────────────────────── */
    var liveToggle = byId('liveToggle');
    function generateOrder() {
      var cat = OV.CATS[Math.floor(Math.random() * OV.CATS.length)];
      var price = +(20 + Math.random() * 160).toFixed(2);
      var qty = Math.ceil(Math.random() * 5);
      var fn = OV.firstNames[Math.floor(Math.random() * OV.firstNames.length)];
      var ln = OV.lastNames[Math.floor(Math.random() * OV.lastNames.length)];
      var now = new Date();
      return {
        id: 'ORD-' + (2000 + OV.ORDERS.length),
        customer: fn + ' ' + ln, category: cat, price: price, qty: qty,
        revenue: +(price * qty).toFixed(2),
        date: now.toISOString().slice(0, 10),
        region: OV.weightedPick(OV.REGIONS, OV.REGION_WEIGHTS),
        live: true
      };
    }
    function auditTimestamp(d) {
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function tickLive() {
      if (state.role === 'rep') return; // reps don't get simulated company-wide inflow
      var order = generateOrder();
      OV.ORDERS.push(order);
      recomputeAll();
      var revEl = byId('kpiRevenue'), ordEl = byId('kpiOrders');
      [revEl, ordEl].forEach(function (el) { if (!el) return; el.classList.remove('pro-flash'); void el.offsetWidth; el.classList.add('pro-flash'); });
      toast('New order ' + order.id + ' — $' + order.revenue.toFixed(2) + ' (' + order.region + ')');

      // Item #8: live orders leave a trail in the Audit log too.
      AUDIT.unshift({
        time: auditTimestamp(new Date()),
        user: 'System (Live mode)',
        action: 'New order received',
        resource: order.id + ' · $' + order.revenue.toFixed(2) + ' · ' + order.region,
        ip: '—',
        status: 'active'
      });
      var auditSearchEl = byId('auditSearch');
      renderAudit(auditSearchEl ? auditSearchEl.value : '');
    }
    liveToggle.addEventListener('change', function () {
      state.live = liveToggle.checked;
      if (state.live) {
        toast('Live mode on — simulating incoming orders every few seconds.');
        state.liveTimer = setInterval(tickLive, 4000);
      } else {
        clearInterval(state.liveTimer);
      }
    });

    /* ──────────────────────────── Export menu ───────────────────────────── */
    var exportBtnOld = byId('exportOrdersBtn');
    var exportBtn = exportBtnOld.cloneNode(true); // strip overview.js's direct-export click listener
    exportBtnOld.parentNode.replaceChild(exportBtn, exportBtnOld);

    exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!exportMenu.contains(e.target) && e.target !== exportBtn) exportMenu.classList.remove('open');
    });

    function exportXLSX(filename, sheetName) {
      if (!window.XLSX) { toast('Excel export library did not load.'); return; }
      // Item #3: always export what the current role/region/date filter allows —
      // for a Sales Rep that's only their own orders, same as the CSV export.
      var source = window.__ovExtraFilter ? OV.ORDERS.filter(window.__ovExtraFilter) : OV.ORDERS;
      var ws = XLSX.utils.json_to_sheet(source.map(function (o) {
        return { 'Order ID': o.id, Customer: o.customer, Category: o.category, Price: o.price, Qty: o.qty, Revenue: o.revenue, Date: o.date, Region: o.region };
      }));
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Orders').slice(0, 31));
      XLSX.writeFile(wb, filename || 'dashview-orders.xlsx');
    }
    function copySummary() {
      var agg = computeAggregates(currentSubset());
      var text = 'DashView — Sales Summary (' + new Date().toLocaleDateString() + ')\n' +
        'Revenue: ' + fmtK(agg.revenue) + '\nOrders: ' + agg.orders + '\nCustomers: ' + agg.customers +
        '\nAvg order value: $' + agg.aov.toFixed(2) + '\nRepeat rate: ' + agg.repeatPct + '%';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Summary copied to clipboard.'); }, function () { toast(text); });
      } else { toast('Copy not supported — summary logged to console.'); console.log(text); }
    }
    exportMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-export]');
      if (!btn || btn.disabled) return;
      var type = btn.dataset.export;
      exportMenu.classList.remove('open');
      if (type === 'csv') { toast('Preparing CSV…'); setTimeout(function () { window.__overviewExportCSV(); }, 300); }
      else if (type === 'xlsx') { toast('Preparing Excel workbook…'); setTimeout(exportXLSX, 300); }
      else if (type === 'pdf') { toast('Opening print dialog…'); setTimeout(function () { window.print(); }, 300); }
      else if (type === 'share') { copySummary(); }
    });

    /* ── Theme retint (item #5): region, customer-mix, marketing & finance charts ── */
    function retintChart(chart, opts) {
      if (!chart) return;
      if (chart.options.plugins && chart.options.plugins.tooltip) {
        Object.assign(chart.options.plugins.tooltip, { backgroundColor: ct.tooltipBg, borderColor: ct.tooltipBorder, titleColor: ct.tooltipTitle, bodyColor: ct.tooltipBody });
      }
      if (opts && opts.gridScale && chart.options.scales[opts.gridScale] && chart.options.scales[opts.gridScale].grid) {
        chart.options.scales[opts.gridScale].grid.color = ct.gridY;
      }
      chart.update('none');
    }
    function applyProChartsTheme() {
      ct = OV.chartTheme();
      retintChart(regionBarChart, { gridScale: 'x' });
      retintChart(newReturningChart);
      retintChart(marketingChannelChart, { gridScale: 'y' });
      retintChart(marketingCampaignChart, { gridScale: 'y' });
      retintChart(financePnlChart, { gridScale: 'y' });
      retintChart(financeExpenseChart);
    }
    window.__dashboardProApplyTheme = applyProChartsTheme;

    /* ───────────────────────────── Init ─────────────────────────────────── */
    recomputeAll();

    /* ══════════════════════ Projects / Agent tasks / Team / Reports / Audit log ══════════════════════
       Static, realistic content for the sidebar tabs that previously did nothing.
       Reuses REPO_DEFS-style names from the rest of the app for consistency. */

    var LANG_COLORS = { TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584', Swift: '#F05138', HCL: '#844FBA' };
    var AVATAR_COLORS = ['#e8a33d', '#5b8fae', '#4fb477', '#f0c06a', '#e5654f', '#c76b3c', '#4a8c86', '#9a9552', '#8b5cf6'];
    function initials(name) { return name.split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }
    function hashColor(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }

    /* ── Projects ─────────────────────────────────────────────────────────── */
    var PROJECTS = [
      { name: 'platform-v2', desc: 'Core DashView platform — API, orchestration, model routing.', lang: 'TypeScript', status: 'active', progress: 78, updated: '2h ago' },
      { name: 'ai-studio', desc: 'Image generation, code analysis and report export tools.', lang: 'TypeScript', status: 'active', progress: 64, updated: '5h ago' },
      { name: 'auth-service', desc: 'Authentication, sessions and org/team permissions.', lang: 'Python', status: 'active', progress: 91, updated: '1h ago' },
      { name: 'design-system', desc: 'Shared glass component library and design tokens.', lang: 'TypeScript', status: 'maintenance', progress: 100, updated: '3d ago' },
      { name: 'mobile-app', desc: 'iOS/Android client built on the platform API.', lang: 'Swift', status: 'progress', progress: 42, updated: '1d ago' },
      { name: 'api-gateway', desc: 'Edge routing, rate limiting and request signing.', lang: 'Go', status: 'active', progress: 85, updated: '30m ago' },
      { name: 'data-pipeline', desc: 'ETL jobs for usage analytics and model telemetry.', lang: 'Python', status: 'risk', progress: 15, updated: '2d ago' },
      { name: 'infra-terraform', desc: 'Infrastructure as code for all environments.', lang: 'HCL', status: 'active', progress: 70, updated: '6h ago' }
    ];
    var PROJECT_STATUS_LABEL = { active: 'Active', maintenance: 'Maintenance', progress: 'In progress', risk: 'At risk' };
    var PROJECT_STATUS_PILL = { active: 'active', maintenance: 'active', progress: 'review', risk: 'blocked' };

    // Bug: these 4 KPI cards were hardcoded in dashboard.html (e.g. "Active
    // Projects: 6") and had drifted out of sync with the actual PROJECTS list
    // below (only 5 of the 8 entries have status:'active'). Computing them
    // from PROJECTS directly means the numbers are always correct, and stay
    // correct if the project list ever changes.
    function renderProjectKPIs() {
      var activeCount = PROJECTS.filter(function (p) { return p.status === 'active'; }).length;
      var atRiskProjects = PROJECTS.filter(function (p) { return p.status === 'risk'; });
      var onTrackCount = PROJECTS.filter(function (p) { return p.status !== 'risk' && p.progress >= 50; }).length;
      var avgProgress = Math.round(PROJECTS.reduce(function (s, p) { return s + p.progress; }, 0) / PROJECTS.length);
      if (byId('projKpiActive')) byId('projKpiActive').textContent = activeCount;
      if (byId('projKpiActiveSub')) byId('projKpiActiveSub').textContent = 'of ' + PROJECTS.length + ' total';
      if (byId('projKpiAvgProgress')) byId('projKpiAvgProgress').textContent = avgProgress + '%';
      if (byId('projKpiOnTrack')) byId('projKpiOnTrack').textContent = onTrackCount;
      if (byId('projKpiAtRisk')) byId('projKpiAtRisk').textContent = atRiskProjects.length;
      if (byId('projKpiAtRiskSub')) byId('projKpiAtRiskSub').textContent = atRiskProjects.length
        ? atRiskProjects.map(function (p) { return p.name; }).join(', ') + ' slipping'
        : 'None right now';
    }

    function renderProjects(filterQ) {
      var q = (filterQ || '').toLowerCase();
      var list = PROJECTS.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) > -1 || p.desc.toLowerCase().indexOf(q) > -1; });
      byId('projectsGrid').innerHTML = list.map(function (p) {
        return '<div class="project-card">'
          + '<div class="project-card-head"><h3>' + p.name + '</h3><span class="status-pill ' + PROJECT_STATUS_PILL[p.status] + '">' + PROJECT_STATUS_LABEL[p.status] + '</span></div>'
          + '<p class="project-card-desc">' + p.desc + '</p>'
          + '<div class="project-progress-row"><div class="progress-track"><div class="progress-fill" style="width:' + p.progress + '%"></div></div><span class="project-progress-pct">' + p.progress + '%</span></div>'
          + '<div class="project-card-foot"><span class="project-card-lang"><span class="project-card-lang-dot" style="background:' + (LANG_COLORS[p.lang] || '#999') + '"></span>' + p.lang + '</span><span style="font-size:11px;color:var(--ink-30);font-family:var(--f-mono)">' + p.updated + '</span></div>'
          + '</div>';
      }).join('') || '<p style="color:var(--ink-30);font-size:var(--fs-sm)">No projects match your search.</p>';
    }
    renderProjects('');
    renderProjectKPIs();
    if (byId('projectSearch')) byId('projectSearch').addEventListener('input', function (e) { renderProjects(e.target.value); });
    if (byId('newProjectBtn')) byId('newProjectBtn').addEventListener('click', function () { toast('Project creation is a demo action in this static build.'); });

    /* ── Agent tasks ──────────────────────────────────────────────────────── */
    var TASKS = [
      { task: 'Implement sliding-window rate limiter', repo: 'platform-api', agent: 'Agent · Nova', status: 'review', label: 'In review', updated: '6m ago' },
      { task: 'Fix flaky test on feat/payments', repo: 'payments-api', agent: 'Agent · Orion', status: 'blocked', label: 'Blocked', updated: '4h ago' },
      { task: 'Add OAuth2 refresh token rotation', repo: 'auth-service', agent: 'Agent · Nova', status: 'active', label: 'In progress', updated: '22m ago' },
      { task: 'Optimize Terraform state locking', repo: 'infra-terraform', agent: 'Agent · Atlas', status: 'active', label: 'Passing', updated: '1h ago' },
      { task: 'Migrate ETL job to Airflow 2.9', repo: 'data-pipeline', agent: 'Agent · Vega', status: 'active', label: 'In progress', updated: '3h ago' },
      { task: 'Draft mobile push notification service', repo: 'mobile-app', agent: 'Agent · Lyra', status: 'review', label: 'Planning', updated: '1d ago' },
      { task: 'Add dark-mode tokens to design-system', repo: 'design-system', agent: 'Agent · Lyra', status: 'active', label: 'Passing', updated: '5h ago' },
      { task: 'Write integration tests for api-gateway', repo: 'api-gateway', agent: 'Agent · Orion', status: 'review', label: 'In review', updated: '2h ago' },
      { task: 'Investigate memory leak in ai-studio worker', repo: 'ai-studio', agent: 'Agent · Nova', status: 'blocked', label: 'Blocked', updated: '8h ago' },
      { task: 'Add webhook signature verification', repo: 'platform-api', agent: 'Agent · Atlas', status: 'active', label: 'Passing', updated: '30m ago' },
      { task: 'Refactor billing invoice generator', repo: 'billing', agent: 'Agent · Vega', status: 'active', label: 'In progress', updated: '45m ago' },
      { task: 'Set up canary deploys for checkout-service', repo: 'checkout-service', agent: 'Agent · Atlas', status: 'review', label: 'Planning', updated: '2d ago' },
      { task: 'Add rate-limit bypass audit alert', repo: 'platform-api', agent: 'Agent · Orion', status: 'review', label: 'Waiting on you', updated: '1h ago' },
      { task: 'Upgrade Node runtime to 22 LTS', repo: 'infra-terraform', agent: 'Agent · Nova', status: 'active', label: 'Passing', updated: '6h ago' }
    ];
    function renderTasks(q, statusFilter) {
      q = (q || '').toLowerCase();
      var list = TASKS.filter(function (t) {
        var mq = !q || t.task.toLowerCase().indexOf(q) > -1 || t.repo.toLowerCase().indexOf(q) > -1;
        var ms = !statusFilter || t.status === statusFilter;
        return mq && ms;
      });
      byId('taskBody').innerHTML = list.map(function (t) {
        return '<tr><td>' + t.task + '</td><td class="mono">' + t.repo + '</td><td>' + t.agent + '</td>'
          + '<td><span class="status-pill ' + t.status + '">' + t.label + '</span></td>'
          + '<td class="mono">' + t.updated + '</td></tr>';
      }).join('') || '<tr><td colspan="5" style="color:var(--ink-30)">No tasks match your filters.</td></tr>';
    }
    renderTasks('', '');
    if (byId('taskSearch')) byId('taskSearch').addEventListener('input', function (e) { renderTasks(e.target.value, byId('taskStatusFilter').value); });
    if (byId('taskStatusFilter')) byId('taskStatusFilter').addEventListener('change', function (e) { renderTasks(byId('taskSearch').value, e.target.value); });

    /* ── Team ─────────────────────────────────────────────────────────────── */
    var TEAM = [
      { name: 'Amara Khan', role: 'Founder & Admin', status: 'online', projects: 8 },
      { name: 'Daniyal Raza', role: 'Engineering Lead', status: 'online', projects: 5 },
      { name: 'Sara Ahmed', role: 'Product Manager', status: 'away', projects: 4 },
      { name: 'Bilal Hussain', role: 'DevOps Engineer', status: 'online', projects: 3 },
      { name: 'Zara Farooq', role: 'UI/UX Designer', status: 'offline', projects: 2 },
      { name: 'Hamza Tariq', role: 'Data Engineer', status: 'online', projects: 3 },
      { name: 'Mahnoor Iqbal', role: 'QA Engineer', status: 'away', projects: 4 },
      { name: 'Omer Sheikh', role: 'Customer Success', status: 'online', projects: 1 }
    ];
    byId('teamGrid').innerHTML = TEAM.map(function (m) {
      return '<div class="team-card">'
        + '<div class="team-avatar-wrap"><div class="team-avatar" style="background:' + hashColor(m.name) + '">' + initials(m.name) + '</div><span class="team-status-dot ' + m.status + '"></span></div>'
        + '<div><p class="team-card-name">' + m.name + '</p><p class="team-card-role">' + m.role + '</p><p class="team-card-meta">' + m.projects + ' project' + (m.projects === 1 ? '' : 's') + '</p></div>'
        + '</div>';
    }).join('');
    if (byId('inviteTeamBtn')) byId('inviteTeamBtn').addEventListener('click', function () { toast('Invite flow is a demo action in this static build.'); });

    /* ── Reports ──────────────────────────────────────────────────────────── */
    var REPORTS = [
      { title: 'Monthly Sales Summary', desc: 'Revenue, orders and top categories for the last calendar month.', fmt: 'PDF', generated: 'Sep 1, 2026', action: 'pdf' },
      { title: 'Customer Cohort Analysis', desc: 'Repeat-purchase behaviour grouped by acquisition month.', fmt: 'XLSX', generated: 'Aug 28, 2026', action: 'xlsx' },
      { title: 'Regional Performance Report', desc: 'Revenue and order volume broken down by region.', fmt: 'CSV', generated: 'Sep 3, 2026', action: 'csv' },
      { title: 'Marketing Campaign ROI', desc: 'Spend vs. conversions across all active channels.', fmt: 'PDF', generated: 'Aug 30, 2026', action: 'pdf' },
      { title: 'Finance P&L Statement', desc: 'Monthly profit and loss with department expense split.', fmt: 'XLSX', generated: 'Sep 1, 2026', action: 'xlsx' },
      { title: 'Agent Task Velocity', desc: 'Completion time and throughput for autonomous agent tasks.', fmt: 'CSV', generated: 'Sep 5, 2026', action: 'csv' }
    ];
    var FMT_COLOR = { PDF: '#e5654f', XLSX: '#4fb477', CSV: '#5b8fae' };
    byId('reportsGrid').innerHTML = REPORTS.map(function (r) {
      return '<div class="report-card">'
        + '<div class="report-card-icon" style="background:' + FMT_COLOR[r.fmt] + '22;color:' + FMT_COLOR[r.fmt] + '">' + r.fmt + '</div>'
        + '<p class="report-card-title">' + r.title + '</p><p class="report-card-desc">' + r.desc + '</p>'
        + '<p class="report-card-meta">Last generated ' + r.generated + '</p>'
        + '<div class="report-card-actions"><button class="btn btn-outline btn-sm" data-run="' + r.action + '" data-title="' + r.title + '">Generate now</button></div>'
        + '</div>';
    }).join('');
    function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
    byId('reportsGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-run]'); if (!btn) return;
      var type = btn.dataset.run;
      var title = btn.dataset.title || 'Report';
      // Item #3: Excel export is Admin/Manager-only, same restriction as the export menu.
      if (type === 'xlsx' && state.role === 'rep') { toast('Excel export is restricted for the Sales Rep view.'); return; }
      // Each report card now names the report it's actually producing — both in
      // the toast and in the downloaded file — instead of a generic "Generating
      // report…" for every card regardless of which one was clicked.
      toast('Generating "' + title + '"…');
      setTimeout(function () {
        var slug = 'dashview-' + slugify(title);
        if (type === 'csv' && window.__overviewExportCSV) window.__overviewExportCSV(slug + '.csv');
        else if (type === 'xlsx') exportXLSX(slug + '.xlsx', title);
        else if (type === 'pdf') window.print();
        toast('"' + title + '" is ready.');
      }, 350);
    });
    if (byId('newReportBtn')) byId('newReportBtn').addEventListener('click', function () { toast('Custom report builder is a demo action — use Data Studio to build one from scratch.'); });

    /* ── Audit log ────────────────────────────────────────────────────────── */
    var AUDIT = [
      { time: '2026-09-10 09:42', user: 'Amara Khan', action: 'Signed in', resource: 'acme-corp workspace', ip: '203.101.44.12', status: 'active' },
      { time: '2026-09-10 09:10', user: 'Daniyal Raza', action: 'Merged pull request #479', resource: 'checkout-service', ip: '203.101.44.31', status: 'active' },
      { time: '2026-09-09 22:05', user: 'System', action: 'API key rotated', resource: 'platform-api', ip: '—', status: 'review' },
      { time: '2026-09-09 18:47', user: 'Sara Ahmed', action: 'Exported report', resource: 'Monthly Sales Summary', ip: '182.191.6.90', status: 'active' },
      { time: '2026-09-09 15:12', user: 'Bilal Hussain', action: 'Updated infrastructure config', resource: 'infra-terraform', ip: '203.101.44.55', status: 'active' },
      { time: '2026-09-09 11:30', user: 'Unknown', action: 'Failed login attempt', resource: 'acme-corp workspace', ip: '91.208.184.2', status: 'blocked' },
      { time: '2026-09-08 20:03', user: 'Hamza Tariq', action: 'Modified data pipeline schedule', resource: 'data-pipeline', ip: '203.101.44.62', status: 'active' },
      { time: '2026-09-08 14:26', user: 'Amara Khan', action: 'Invited team member', resource: 'Omer Sheikh', ip: '203.101.44.12', status: 'active' },
      { time: '2026-09-08 09:58', user: 'Zara Farooq', action: 'Updated design tokens', resource: 'design-system', ip: '182.191.6.14', status: 'active' },
      { time: '2026-09-07 16:41', user: 'System', action: 'Permission change flagged for review', resource: 'auth-service', ip: '—', status: 'review' }
    ];
    var AUDIT_LABEL = { active: 'Success', review: 'Flagged', blocked: 'Denied' };
    function renderAudit(q) {
      q = (q || '').toLowerCase();
      var list = AUDIT.filter(function (a) { return !q || a.user.toLowerCase().indexOf(q) > -1 || a.action.toLowerCase().indexOf(q) > -1 || a.resource.toLowerCase().indexOf(q) > -1; });
      byId('auditBody').innerHTML = list.map(function (a) {
        return '<tr><td class="mono">' + a.time + '</td><td>' + a.user + '</td><td>' + a.action + '</td><td>' + a.resource + '</td>'
          + '<td class="mono">' + a.ip + '</td><td><span class="status-pill ' + a.status + '">' + AUDIT_LABEL[a.status] + '</span></td></tr>';
      }).join('') || '<tr><td colspan="6" style="color:var(--ink-30)">No log entries match your search.</td></tr>';
    }
    renderAudit('');
    if (byId('auditSearch')) byId('auditSearch').addEventListener('input', function (e) { renderAudit(e.target.value); });
    if (byId('exportAuditBtn')) byId('exportAuditBtn').addEventListener('click', function () {
      var rows = ['Time,User,Action,Resource,IP,Status'];
      AUDIT.forEach(function (a) { rows.push([a.time, a.user, a.action, a.resource, a.ip, AUDIT_LABEL[a.status]].join(',')); });
      var blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a2 = document.createElement('a'); a2.href = url; a2.download = 'audit-log.csv'; a2.click();
      URL.revokeObjectURL(url);
      toast('Audit log exported.');
    });

    /* ══════════════════════ Settings ══════════════════════ */
    var PROFILE_KEY = 'dashview_profile';
    var ODOO_KEY = 'dashview_odoo_config';

    function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
    function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

    // Profile
    var profile = loadJSON(PROFILE_KEY, { workspaceName: 'acme-corp', displayName: 'Amara Khan' });
    if (byId('setWorkspaceName')) byId('setWorkspaceName').value = profile.workspaceName;
    if (byId('setDisplayName')) byId('setDisplayName').value = profile.displayName;
    if (byId('setThemeSelect')) byId('setThemeSelect').value = document.documentElement.getAttribute('data-theme') || 'dark';
    if (byId('setThemeSelect')) byId('setThemeSelect').addEventListener('change', function (e) {
      if (window.dashviewApplyTheme) window.dashviewApplyTheme(e.target.value);
    });
    if (byId('saveProfileBtn')) byId('saveProfileBtn').addEventListener('click', function () {
      saveJSON(PROFILE_KEY, { workspaceName: byId('setWorkspaceName').value.trim() || 'acme-corp', displayName: byId('setDisplayName').value.trim() || 'Amara Khan' });
      toast('Profile saved.');
    });

    // Data & backup
    function refreshStorageUsage() {
      var bytes = 0;
      try { for (var k in localStorage) { if (localStorage.hasOwnProperty(k)) bytes += (localStorage.getItem(k) || '').length + k.length; } } catch (e) {}
      var tag = byId('storageUsageTag');
      if (tag) tag.textContent = (bytes / 1024).toFixed(1) + ' KB used';
    }
    refreshStorageUsage();

    if (byId('exportBackupBtn')) byId('exportBackupBtn').addEventListener('click', function () {
      var dump = {};
      try { for (var k in localStorage) { if (localStorage.hasOwnProperty(k)) dump[k] = localStorage.getItem(k); } } catch (e) {}
      var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: dump }, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'dashview-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      URL.revokeObjectURL(url);
      toast('Backup exported — keep this file somewhere safe.');
    });
    if (byId('importBackupBtn')) byId('importBackupBtn').addEventListener('click', function () { byId('importBackupFile').click(); });
    if (byId('importBackupFile')) byId('importBackupFile').addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var data = parsed.data || parsed;
          Object.keys(data).forEach(function (k) { localStorage.setItem(k, data[k]); });
          toast('Backup restored — reloading…');
          setTimeout(function () { location.reload(); }, 700);
        } catch (err) { toast('That file could not be read as a DashView backup.'); }
      };
      reader.readAsText(file);
    });
    if (byId('clearLocalBtn')) byId('clearLocalBtn').addEventListener('click', function () {
      if (!confirm('Clear all locally saved DashView data (workbooks, chat history, preferences)? This cannot be undone unless you have a backup file.')) return;
      localStorage.clear();
      toast('Local data cleared — reloading…');
      setTimeout(function () { location.reload(); }, 600);
    });

    // Odoo integration — connect/test wiring, the mock RPC client, and the
    // "Odoo Data" browser view now live in js/odoo-service.js (window.DVOdoo),
    // so this block just leaves ODOO_KEY declared above for any legacy reads.

    // AI Assistant API key status
    if (byId('aiKeyStatusTag')) {
      var aiCfg = window.DASHVIEW_AI_CONFIG;
      byId('aiKeyStatusTag').textContent = (aiCfg && aiCfg.apiKey) ? 'Key configured' : 'Using offline demo engine';
    }
  });
})();
