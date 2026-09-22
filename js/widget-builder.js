/* ==========================================================================
   DashView — Widget Builder, Import/Export, Sharing & TV Mode
   ==========================================================================
   Widgets are plain JSON persisted to localStorage (dv_widgets). Each widget
   points at a data SOURCE:
     - demo   -> (historic id) reads window.DASHVIEW_OV: the LIVE Odoo overview snapshot
                published by js/overview-live.js
     - odoo   -> reads window.DVOdoo.fetchModel() (live Odoo through your Worker; see
                js/odoo-service.js)
     - csv    → data imported directly into the widget itself and cached on
                the widget object (client-side only, prototype)

   Data comes from your live Odoo through the Worker. Swap the `computeDemo`/DVOdoo calls
   for real API calls once server/ is wired up — the render layer
   (renderKpiBody/renderChartBody/renderTableBody) doesn't care where the
   numbers came from, so it needs no changes.
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'dv_widgets';
  var liveTimers = {};
  var chartInstances = {};
  var editingId = null;

  function byId(id) { return document.getElementById(id); }
  function toast(msg) { if (window.showToast) window.showToast(msg); }
  function can(perm) { return window.DVAuth ? window.DVAuth.can(perm) : true; }
  function esc(str) { return String(str).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function uid() { return 'w_' + Math.random().toString(36).slice(2, 9); }

  var DEMO_METRICS = {
    revenue_total: { label: 'Revenue (last 12 months)', type: 'kpi' },
    orders_count: { label: 'Orders (last 12 months)', type: 'kpi' },
    avg_order_value: { label: 'Average order value', type: 'kpi' },
    category_breakdown: { label: 'Revenue by category', type: 'chart', chartType: 'bar' },
    region_breakdown: { label: 'Top customers (revenue)', type: 'chart', chartType: 'doughnut' },
    monthly_trend: { label: 'Revenue trend', type: 'chart', chartType: 'line' },
    recent_orders: { label: 'Recent orders', type: 'table' }
  };

  /* ── Storage ─────────────────────────────────────────────────────────── */
  function loadWidgets() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && raw.length) return raw;
    } catch (e) {}
    return seedWidgets();
  }
  function saveWidgets(list) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { toast('Could not save — layout may be too large for local storage.'); } }
  function seedWidgets() {
    var seed = [
      { id: uid(), title: 'Total revenue', type: 'kpi', source: { kind: 'demo', metric: 'revenue_total' }, live: false, intervalSec: 15, order: 0 },
      { id: uid(), title: 'Revenue by category', type: 'chart', source: { kind: 'demo', metric: 'category_breakdown' }, live: false, intervalSec: 15, order: 1 },
      { id: uid(), title: 'Recent orders', type: 'table', source: { kind: 'demo', metric: 'recent_orders' }, live: false, intervalSec: 15, order: 2 }
    ];
    saveWidgets(seed);
    return seed;
  }

  /* ── Demo data computation ──────────────────────────────────────────── */
  function computeDemo(metric) {
    /* "Demo" is a historical id: the source now reads the LIVE Odoo overview snapshot
       that js/overview-live.js publishes on window.DASHVIEW_OV (12 months of confirmed sales). */
    var ov = window.DASHVIEW_OV;
    if (!ov || !ov.SUMMARY) return null;
    var sum = ov.SUMMARY, hasData = sum.orders12 > 0 || (ov.MONTHS && ov.MONTHS.length);
    if (!hasData) return null;
    var money = function (n) { return window.DVFmt ? window.DVFmt.money(n, false) : '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); };
    if (metric === 'revenue_total') return { kind: 'kpi', value: money(sum.revenue12), sub: sum.orders12 + ' orders \u00b7 last 12 months', raw: sum.revenue12 };
    if (metric === 'orders_count') return { kind: 'kpi', value: Number(sum.orders12).toLocaleString(), sub: 'Confirmed \u00b7 last 12 months', raw: sum.orders12 };
    if (metric === 'avg_order_value') { var avg = sum.orders12 ? sum.revenue12 / sum.orders12 : 0; return { kind: 'kpi', value: money(avg), sub: 'Per confirmed order', raw: avg }; }
    if (metric === 'category_breakdown') return { kind: 'chart', chartType: 'bar', labels: (ov.CATS || []).slice(), values: (ov.CAT_REV || []).map(function (v) { return Math.round(v); }) };
    if (metric === 'region_breakdown') return { kind: 'chart', chartType: 'doughnut', labels: (ov.TOP_L || []).slice(), values: (ov.TOP_V || []).map(function (v) { return Math.round(v); }) };
    if (metric === 'monthly_trend') return { kind: 'chart', chartType: 'line', labels: (ov.MONTHS || []).slice(), values: (ov.REVENUE || []).slice() };
    if (metric === 'recent_orders') return { kind: 'table', fields: ['Order', 'Customer', 'Total'], rows: (ov.ORDERS || []).slice(0, 6).map(function (o) { return [o.id, o.customer, money(o.revenue)]; }) };
    return null;
  }

  /* ── CSV parsing (lightweight — prototype-grade) ───────────────────────── */
  function parseCsv(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (!lines.length) return { fields: [], rows: [] };
    var fields = lines[0].split(',').map(function (h) { return h.trim(); });
    var rows = lines.slice(1, 201).map(function (line) { return line.split(',').map(function (c) { return c.trim(); }); });
    return { fields: fields, rows: rows };
  }

  /* ── Table → chart aggregation (CSV / Odoo rows) ───────────────────────
     Groups arbitrary {fields, rows} data by one column and sums (or counts)
     another, so imported spreadsheets and Odoo records can drive a chart
     the same way the built-in demo metrics do. */
  function computeTableChart(fields, rows, catField, valField, chartType) {
    var ci = fields.indexOf(catField);
    if (ci === -1) return { kind: 'chart', chartType: chartType || 'bar', labels: [], values: [] };
    var vi = valField ? fields.indexOf(valField) : -1;
    var totals = {}, order = [];
    rows.forEach(function (r) {
      var key = r[ci] === undefined || r[ci] === '' ? '(blank)' : String(r[ci]);
      if (!(key in totals)) { totals[key] = 0; order.push(key); }
      totals[key] += vi > -1 ? (parseFloat(String(r[vi]).replace(/[^0-9.-]/g, '')) || 0) : 1;
    });
    // Keep the chart legible: top 12 groups by size.
    order.sort(function (a, b) { return totals[b] - totals[a]; });
    var labels = order.slice(0, 12);
    return { kind: 'chart', chartType: chartType || 'bar', labels: labels, values: labels.map(function (l) { return Math.round(totals[l] * 100) / 100; }) };
  }

  /* ── Rendering ───────────────────────────────────────────────────────── */
  function renderKpiBody(container, data) {
    container.innerHTML = '<div class="dv-widget-kpi-value">' + esc(data.value) + '</div><div class="dv-widget-kpi-sub">' + esc(data.sub || '') + '</div>';
  }

  function renderProgressBody(container, raw, label, sub, target) {
    if (raw == null || !target || target <= 0) {
      container.innerHTML = '<p class="dv-widget-empty">' + (target ? 'No data yet.' : 'Edit this widget to set a target value.') + '</p>';
      return;
    }
    var pct = Math.max(0, Math.min(100, Math.round((raw / target) * 100)));
    container.innerHTML =
      '<div class="dv-widget-progress">' +
        '<div class="dv-widget-progress-top"><span class="dv-widget-progress-val">' + esc(label) + '</span><span class="dv-widget-progress-pct' + (pct >= 100 ? ' is-done' : '') + '">' + pct + '%</span></div>' +
        '<div class="dv-widget-progress-track"><div class="dv-widget-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="dv-widget-progress-sub">' + esc(sub || '') + (sub ? ' · ' : '') + 'Target ' + esc(target.toLocaleString()) + '</div>' +
      '</div>';
  }

  // Chart.js needs a different dataset/scale shape for radar than for the
  // bar/line/doughnut family, and "area" is really a filled line — this
  // keeps that branching in one place rather than scattered through callers.
  var RADIAL_CHARTS = { doughnut: 1, pie: 1, radar: 1 };
  function renderChartBody(container, data, canvasId) {
    container.innerHTML = '<div class="dv-widget-chart-wrap"><canvas id="' + canvasId + '"></canvas></div>';
    if (!window.Chart || !data.labels || !data.labels.length) {
      container.innerHTML = '<p class="dv-widget-empty">No chartable data yet.</p>'; return;
    }
    // Read the canvas back from `container` directly rather than
    // document.getElementById: at first render the card (and this canvas)
    // hasn't been appended to the document yet, so a document-scoped lookup
    // would return null even though the element exists in this subtree.
    var canvasEl = container.querySelector('#' + canvasId);
    if (!canvasEl) return;
    var ctx = canvasEl.getContext('2d');
    if (chartInstances[canvasId]) { try { chartInstances[canvasId].destroy(); } catch (e) {} }
    var palette = ['#e8a33d', '#5b8fae', '#8b5cf6', '#4fb477', '#d98f27', '#e5654f'];
    var style = data.chartType || 'bar';
    var isLine = style === 'line' || style === 'area';
    var chartJsType = style === 'area' ? 'line' : style;
    var axisTint = 'rgba(231,237,231,0.4)';
    var cfg = {
      type: chartJsType,
      data: {
        labels: data.labels,
        datasets: [{
          data: data.values,
          backgroundColor: isLine ? (style === 'area' ? 'rgba(232,163,61,0.18)' : 'rgba(232,163,61,0.12)') : data.labels.map(function (_, i) { return palette[i % palette.length]; }),
          borderColor: isLine ? '#e8a33d' : (style === 'radar' ? '#e8a33d' : 'transparent'),
          borderWidth: isLine ? 2 : (style === 'radar' ? 2 : 0),
          fill: style === 'area',
          tension: 0.35,
          borderRadius: style === 'bar' ? 6 : 0,
          pointRadius: isLine ? 2 : (style === 'radar' ? 3 : 0),
          pointBackgroundColor: '#e8a33d'
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: RADIAL_CHARTS[style] ? true : false, labels: { color: 'rgba(231,237,231,0.6)', boxWidth: 10, font: { size: 10 } } } },
        scales: style === 'doughnut' || style === 'pie' ? {} : style === 'radar' ? {
          r: { ticks: { display: false, backdropColor: 'transparent' }, grid: { color: 'rgba(232,163,61,0.1)' }, angleLines: { color: 'rgba(232,163,61,0.12)' }, pointLabels: { color: axisTint, font: { size: 10 } } }
        } : {
          x: { ticks: { color: axisTint, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: axisTint, font: { size: 10 } }, grid: { color: 'rgba(232,163,61,0.08)' } }
        }
      }
    };
    chartInstances[canvasId] = new Chart(ctx, cfg);
  }

  function renderTableBody(container, data) {
    if (!data.rows || !data.rows.length) { container.innerHTML = '<p class="dv-widget-empty">No records to show.</p>'; return; }
    var head = '<thead><tr>' + data.fields.map(function (f) { return '<th>' + esc(f) + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>' + data.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody>';
    container.innerHTML = '<div class="dv-widget-table-wrap"><table class="dash-table">' + head + body + '</table></div>';
  }

  function fillBody(widget, container, canvasIdPrefix) {
    var src = widget.source || { kind: 'demo', metric: 'revenue_total' };
    if (src.kind === 'demo') {
      var data = computeDemo(src.metric);
      if (!data) { container.innerHTML = '<p class="dv-widget-empty">Live Odoo data isn\'t loaded yet \u2014 connect Odoo in Settings.</p>'; return; }
      if (widget.type === 'progress') { renderProgressBody(container, data.raw != null ? data.raw : null, data.value || '', data.sub, widget.target); return; }
      if (widget.type === 'chart' && data.labels) { renderChartBody(container, { chartType: widget.chartType || data.chartType, labels: data.labels, values: data.values }, canvasIdPrefix + '_' + widget.id); return; }
      if (data.kind === 'kpi') renderKpiBody(container, data);
      else if (data.kind === 'chart') renderChartBody(container, { chartType: widget.chartType || data.chartType, labels: data.labels, values: data.values }, canvasIdPrefix + '_' + widget.id);
      else renderTableBody(container, data);
      return;
    }
    if (src.kind === 'odoo') {
      container.innerHTML = '<p class="dv-widget-loading">Fetching from Odoo…</p>';
      if (!window.DVOdoo) { container.innerHTML = '<p class="dv-widget-empty">Odoo service unavailable.</p>'; return; }
      var modelLabel = (window.DVOdoo.MODELS[src.model] || {}).label || src.model;
      window.DVOdoo.fetchModel(src.model, { limit: widget.type === 'table' ? 6 : undefined }).then(function (res) {
        if (widget.type === 'progress') { renderProgressBody(container, res.total, res.total.toLocaleString(), modelLabel, widget.target); return; }
        if (widget.type === 'kpi') { renderKpiBody(container, { value: res.total.toLocaleString(), sub: modelLabel }); return; }
        renderTableBody(container, { fields: res.fields, rows: res.rows });
      });
      return;
    }
    if (src.kind === 'csv') {
      var cached = src.data;
      if (!cached || !cached.rows.length) { container.innerHTML = '<p class="dv-widget-empty">No file imported into this widget yet — edit it to add one.</p>'; return; }
      if (widget.type === 'chart') {
        renderChartBody(container, computeTableChart(cached.fields, cached.rows, src.catField, src.valField, widget.chartType), canvasIdPrefix + '_' + widget.id);
        return;
      }
      if (widget.type === 'kpi' || widget.type === 'progress') {
        var colIdx = cached.fields.indexOf(src.numericField);
        var raw, label, sub;
        if (colIdx > -1) {
          raw = cached.rows.reduce(function (s, r) { return s + (parseFloat(String(r[colIdx]).replace(/[^0-9.-]/g, '')) || 0); }, 0);
          label = raw.toLocaleString(undefined, { maximumFractionDigits: 2 });
          sub = 'Sum of ' + src.numericField + ' · ' + cached.rows.length + ' rows';
        } else {
          raw = cached.rows.length;
          label = raw.toLocaleString();
          sub = 'Rows in ' + (src.fileName || 'imported file');
        }
        if (widget.type === 'progress') renderProgressBody(container, raw, label, sub, widget.target);
        else renderKpiBody(container, { value: label, sub: sub });
        return;
      }
      renderTableBody(container, { fields: cached.fields, rows: cached.rows.slice(0, 6) });
      return;
    }
    container.innerHTML = '<p class="dv-widget-empty">Unknown data source.</p>';
  }

  function sourceTag(widget) {
    var src = widget.source || {};
    if (src.kind === 'demo') return 'Odoo \u00b7 ' + (DEMO_METRICS[src.metric] ? DEMO_METRICS[src.metric].label : src.metric);
    if (src.kind === 'odoo') return 'Odoo \u00b7 ' + src.model;
    if (src.kind === 'csv') return 'Imported · ' + (src.fileName || 'file');
    return 'Unknown source';
  }

  function buildCard(widget, opts) {
    opts = opts || {};
    var tv = !!opts.tv;
    var readOnly = !!opts.readOnly;
    var card = document.createElement('div');
    card.className = tv ? 'dv-tv-widget' : 'dv-widget-card dv-widget-card--' + (widget.size || 'md');
    if (!tv) { card.draggable = !readOnly && can('editWidgets'); card.dataset.id = widget.id; }
    var canEdit = !readOnly && can('editWidgets');
    card.innerHTML =
      '<div class="dv-widget-head">' +
      '  <div class="dv-widget-head-left">' +
      (tv ? '' : '    <span class="dv-widget-drag-handle" title="Drag to reorder">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>') +
      '    <div style="min-width:0;">' +
      '      <span class="dv-widget-title">' + esc(widget.title) + (widget.live ? ' <span class="dv-widget-live-dot" style="display:inline-block;margin-left:6px;"></span>' : '') + '</span>' +
      (tv ? '' : '      <span class="dv-widget-source-tag">' + esc(sourceTag(widget)) + '</span>') +
      '    </div>' +
      '  </div>' +
      (tv || !canEdit ? '' :
        '  <div class="dv-widget-actions">' +
        '    <button type="button" class="dv-widget-icon-btn" data-action="edit" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
        '    <button type="button" class="dv-widget-icon-btn danger" data-action="delete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>' +
        '  </div>') +
      '</div>' +
      '<div class="dv-widget-body" id="' + (tv ? 'tvBody' : 'body_' + widget.id) + '"></div>';

    if (!tv) {
      var editBtn = card.querySelector('[data-action="edit"]');
      var delBtn = card.querySelector('[data-action="delete"]');
      if (editBtn) editBtn.addEventListener('click', function (e) { e.stopPropagation(); openModal(widget); });
      if (delBtn) delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!can('deleteWidgets')) { toast('You do not have permission to delete widgets.'); return; }
        if (!confirm('Remove "' + widget.title + '" from this dashboard?')) return;
        deleteWidget(widget.id);
      });
    }
    var body = card.querySelector('.dv-widget-body');
    fillBody(widget, body, tv ? 'tv_canvas' : 'canvas');
    return card;
  }

  /* ── Grid + drag reorder ─────────────────────────────────────────────── */
  var dragSrcId = null;
  function renderGrid() {
    var grid = byId('dvWidgetGrid');
    if (!grid) return;
    Object.keys(chartInstances).forEach(function (k) { try { chartInstances[k].destroy(); } catch (e) {} });
    chartInstances = {};
    var widgets = loadWidgets().slice().sort(function (a, b) { return a.order - b.order; });
    grid.innerHTML = '';
    if (!widgets.length) {
      grid.innerHTML = '<p class="dv-widget-empty">No widgets yet — add one to get started.</p>';
      return;
    }
    widgets.forEach(function (w) {
      var card = buildCard(w);
      card.addEventListener('dragstart', function () { dragSrcId = w.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); grid.querySelectorAll('.dv-widget-card').forEach(function (c) { c.classList.remove('drop-target'); }); });
      card.addEventListener('dragover', function (e) { e.preventDefault(); card.classList.add('drop-target'); });
      card.addEventListener('dragleave', function () { card.classList.remove('drop-target'); });
      card.addEventListener('drop', function (e) {
        e.preventDefault(); card.classList.remove('drop-target');
        if (!dragSrcId || dragSrcId === w.id) return;
        reorder(dragSrcId, w.id);
      });
      grid.appendChild(card);
    });
    setupLiveTimers(widgets);
  }

  function reorder(srcId, targetId) {
    var widgets = loadWidgets().slice().sort(function (a, b) { return a.order - b.order; });
    var srcIdx = widgets.findIndex(function (w) { return w.id === srcId; });
    var tgtIdx = widgets.findIndex(function (w) { return w.id === targetId; });
    if (srcIdx === -1 || tgtIdx === -1) return;
    var moved = widgets.splice(srcIdx, 1)[0];
    widgets.splice(tgtIdx, 0, moved);
    widgets.forEach(function (w, i) { w.order = i; });
    saveWidgets(widgets);
    renderGrid();
  }

  function deleteWidget(id) {
    var widgets = loadWidgets().filter(function (w) { return w.id !== id; });
    widgets.forEach(function (w, i) { w.order = i; });
    saveWidgets(widgets);
    clearInterval(liveTimers[id]);
    delete liveTimers[id];
    renderGrid();
    toast('Widget removed.');
  }

  function setupLiveTimers(widgets) {
    Object.keys(liveTimers).forEach(function (id) { clearInterval(liveTimers[id]); });
    liveTimers = {};
    widgets.forEach(function (w) {
      if (!w.live) return;
      liveTimers[w.id] = setInterval(function () {
        var body = byId('body_' + w.id);
        if (!body) return;
        fillBody(w, body, 'canvas');
        var card = body.closest('.dv-widget-card');
        if (card) { card.classList.remove('dv-flash'); void card.offsetWidth; card.classList.add('dv-flash'); }
      }, Math.max(3, w.intervalSec || 15) * 1000);
    });
  }

  /* ── Add / edit modal ────────────────────────────────────────────────── */
  var pendingCsv = null;

  function populateSourceOptions() {
    var select = byId('dvWidgetSourceSelect');
    if (!select) return;
    var odooOptions = window.DVOdoo ? Object.keys(window.DVOdoo.MODELS).map(function (m) {
      return '<option value="odoo:' + m + '">Odoo \u00b7 ' + window.DVOdoo.MODELS[m].label + '</option>';
    }).join('') : '';
    select.innerHTML =
      '<optgroup label="Odoo overview (live)">' +
      Object.keys(DEMO_METRICS).map(function (m) { return '<option value="demo:' + m + '">' + DEMO_METRICS[m].label + '</option>'; }).join('') +
      '</optgroup>' +
      '<optgroup label="Odoo (live model)">' + odooOptions + '</optgroup>' +
      '<optgroup label="Imported file"><option value="csv:">CSV / Excel file…</option></optgroup>';
  }

  function updateModalForSource(skipAutoType) {
    var val = byId('dvWidgetSourceSelect').value;
    var kind = val.split(':')[0];
    byId('dvWidgetCsvRow').style.display = kind === 'csv' ? 'block' : 'none';
    var typeChips = document.querySelectorAll('#dvWidgetTypeChips .chip-select');
    typeChips.forEach(function (chip) {
      var type = chip.dataset.type;
      // Chart needs a known field schema up front (CSV columns are read
      // synchronously; Odoo's aren't in this modal), so it's the one type
      // not offered for an Odoo source. Everything else works anywhere.
      var allowed = type === 'chart' ? kind !== 'odoo' : true;
      chip.style.display = allowed ? '' : 'none';
      if (!allowed) chip.classList.remove('active');
    });
    if (!document.querySelector('#dvWidgetTypeChips .chip-select.active')) {
      var firstVisible = document.querySelector('#dvWidgetTypeChips .chip-select:not([style*="display: none"])');
      if (firstVisible) firstVisible.classList.add('active');
    }
    if (kind === 'demo' && !skipAutoType) {
      var metric = val.split(':')[1];
      var meta = DEMO_METRICS[metric];
      if (meta) {
        document.querySelectorAll('#dvWidgetTypeChips .chip-select').forEach(function (c) { c.classList.toggle('active', c.dataset.type === meta.type); });
      }
    }
    updateModalRows();
  }

  // Shows/hides the type-specific detail rows (chart style, target, and the
  // three CSV field pickers) for whatever source + type is selected right now.
  function updateModalRows() {
    var kind = byId('dvWidgetSourceSelect').value.split(':')[0];
    var type = selectedType();
    if (byId('dvWidgetChartTypeRow')) byId('dvWidgetChartTypeRow').style.display = type === 'chart' ? 'block' : 'none';
    if (byId('dvWidgetTargetRow')) byId('dvWidgetTargetRow').style.display = type === 'progress' ? 'block' : 'none';
    var hasCsv = kind === 'csv' && pendingCsv;
    if (byId('dvWidgetNumericFieldRow')) byId('dvWidgetNumericFieldRow').style.display = (hasCsv && (type === 'kpi' || type === 'progress')) ? 'block' : 'none';
    if (byId('dvWidgetCatFieldRow')) byId('dvWidgetCatFieldRow').style.display = (hasCsv && type === 'chart') ? 'block' : 'none';
    if (byId('dvWidgetValFieldRow')) byId('dvWidgetValFieldRow').style.display = (hasCsv && type === 'chart') ? 'block' : 'none';
  }

  function selectedType() {
    var active = document.querySelector('#dvWidgetTypeChips .chip-select.active');
    return active ? active.dataset.type : 'kpi';
  }

  // Fills the three CSV-driven <select>s from a parsed file, restoring a
  // previous choice when editing an existing widget (existingSource).
  function populateCsvFieldSelects(parsed, existingSource) {
    var numSelect = byId('dvWidgetNumericFieldSelect');
    if (numSelect) {
      numSelect.innerHTML = '<option value="">— row count only —</option>' + parsed.fields.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('');
      if (existingSource && existingSource.numericField) numSelect.value = existingSource.numericField;
    }
    var catSelect = byId('dvWidgetCatFieldSelect');
    if (catSelect) {
      catSelect.innerHTML = parsed.fields.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('');
      if (existingSource && existingSource.catField) catSelect.value = existingSource.catField;
    }
    var valSelect = byId('dvWidgetValFieldSelect');
    if (valSelect) {
      valSelect.innerHTML = '<option value="">— count rows —</option>' + parsed.fields.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('');
      if (existingSource && existingSource.valField) valSelect.value = existingSource.valField;
    }
  }

  function openModal(widget) {
    if (!can('editWidgets')) { toast('You do not have permission to edit widgets.'); return; }
    editingId = widget ? widget.id : null;
    pendingCsv = widget && widget.source && widget.source.kind === 'csv' ? widget.source.data : null;
    byId('dvWidgetModalTitle').textContent = widget ? 'Edit widget' : 'Add a widget';
    byId('dvWidgetTitleInput').value = widget ? widget.title : '';
    populateSourceOptions();
    var sourceVal = widget ? (widget.source.kind === 'demo' ? 'demo:' + widget.source.metric : widget.source.kind === 'odoo' ? 'odoo:' + widget.source.model : 'csv:') : 'demo:revenue_total';
    byId('dvWidgetSourceSelect').value = sourceVal;
    document.querySelectorAll('#dvWidgetTypeChips .chip-select').forEach(function (c) { c.classList.toggle('active', c.dataset.type === (widget ? widget.type : 'kpi')); });
    byId('dvWidgetLiveCheck').checked = widget ? !!widget.live : false;
    byId('dvWidgetIntervalSelect').value = widget && widget.intervalSec ? String(widget.intervalSec) : '15';
    if (byId('dvWidgetSizeSelect')) byId('dvWidgetSizeSelect').value = widget && widget.size ? widget.size : 'md';
    if (byId('dvWidgetChartTypeSelect')) byId('dvWidgetChartTypeSelect').value = widget && widget.chartType ? widget.chartType : 'bar';
    if (byId('dvWidgetTargetInput')) byId('dvWidgetTargetInput').value = widget && widget.target != null ? widget.target : '';
    byId('dvWidgetCsvStatus').textContent = pendingCsv ? (pendingCsv.rows.length + ' rows loaded') : 'No file loaded yet.';
    if (pendingCsv) populateCsvFieldSelects(pendingCsv, widget && widget.source);
    updateModalForSource(true);
    byId('dvWidgetModal').classList.add('open');
  }

  function openBuilderWithSource(source) {
    if (window.dashviewShowView) window.dashviewShowView('widgets');
    setTimeout(function () {
      openModal(null);
      var val = source.kind === 'odoo' ? 'odoo:' + source.model : 'demo:revenue_total';
      byId('dvWidgetSourceSelect').value = val;
      byId('dvWidgetTitleInput').value = source.kind === 'odoo' ? ((window.DVOdoo.MODELS[source.model] || {}).label || source.model) : '';
      updateModalForSource();
    }, 60);
  }

  function closeModal() { byId('dvWidgetModal').classList.remove('open'); }

  function saveWidgetFromModal() {
    var title = byId('dvWidgetTitleInput').value.trim();
    if (!title) { toast('Give the widget a title.'); return; }
    var sourceVal = byId('dvWidgetSourceSelect').value;
    var kind = sourceVal.split(':')[0];
    var type = selectedType();
    var source;
    if (kind === 'demo') source = { kind: 'demo', metric: sourceVal.split(':')[1] };
    else if (kind === 'odoo') source = { kind: 'odoo', model: sourceVal.split(':')[1] };
    else {
      if (!pendingCsv) { toast('Import a CSV/Excel file for this widget first.'); return; }
      source = {
        kind: 'csv', data: pendingCsv, fileName: pendingCsv.fileName,
        numericField: byId('dvWidgetNumericFieldSelect') ? byId('dvWidgetNumericFieldSelect').value : '',
        catField: byId('dvWidgetCatFieldSelect') ? byId('dvWidgetCatFieldSelect').value : '',
        valField: byId('dvWidgetValFieldSelect') ? byId('dvWidgetValFieldSelect').value : ''
      };
    }
    if (type === 'chart' && kind === 'csv' && !source.catField) { toast('Choose a column to group by for the chart.'); return; }
    var fields = {
      title: title, type: type, source: source,
      live: byId('dvWidgetLiveCheck').checked, intervalSec: parseInt(byId('dvWidgetIntervalSelect').value, 10) || 15,
      size: byId('dvWidgetSizeSelect') ? byId('dvWidgetSizeSelect').value : 'md',
      chartType: byId('dvWidgetChartTypeSelect') ? byId('dvWidgetChartTypeSelect').value : 'bar',
      target: (byId('dvWidgetTargetInput') && byId('dvWidgetTargetInput').value !== '') ? parseFloat(byId('dvWidgetTargetInput').value) : null
    };
    var widgets = loadWidgets();
    if (editingId) {
      var idx = widgets.findIndex(function (w) { return w.id === editingId; });
      if (idx > -1) Object.keys(fields).forEach(function (k) { widgets[idx][k] = fields[k]; });
    } else {
      fields.id = uid();
      fields.order = widgets.length;
      widgets.push(fields);
    }
    saveWidgets(widgets);
    closeModal();
    renderGrid();
    toast(editingId ? 'Widget updated.' : 'Widget added.');
  }

  function handleCsvFile(file) {
    if (!file) return;
    var isExcel = /\.(xlsx|xls)$/i.test(file.name);
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed;
        if (isExcel && window.XLSX) {
          var wb = XLSX.read(reader.result, { type: 'binary' });
          var sheet = wb.Sheets[wb.SheetNames[0]];
          var rows2d = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          var fields = (rows2d[0] || []).map(String);
          var rows = rows2d.slice(1, 201).map(function (r) { return fields.map(function (_, i) { return r[i] === undefined ? '' : String(r[i]); }); });
          parsed = { fields: fields, rows: rows };
        } else {
          parsed = parseCsv(String(reader.result));
        }
        parsed.fileName = file.name;
        pendingCsv = parsed;
        byId('dvWidgetCsvStatus').textContent = parsed.rows.length + ' rows loaded from ' + file.name;
        populateCsvFieldSelects(parsed, null);
        updateModalRows();
      } catch (e) { toast('Could not read that file.'); }
    };
    if (isExcel) reader.readAsBinaryString(file); else reader.readAsText(file);
  }

  /* ── Export / import layout ─────────────────────────────────────────── */
  function exportLayout() {
    var widgets = loadWidgets();
    var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), widgets: widgets }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'dashview-widgets-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    URL.revokeObjectURL(url);
    toast('Layout exported.');
  }

  function importLayout(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        var widgets = parsed.widgets || parsed;
        if (!Array.isArray(widgets)) throw new Error('bad shape');
        widgets.forEach(function (w, i) { if (!w.id) w.id = uid(); w.order = i; });
        saveWidgets(widgets);
        renderGrid();
        toast('Layout imported (' + widgets.length + ' widgets).');
      } catch (e) { toast('That file is not a valid DashView widget layout.'); }
    };
    reader.readAsText(file);
  }

  /* ── Share ───────────────────────────────────────────────────────────── */
  function openShareModal() {
    if (!can('share')) { toast('You do not have permission to share this dashboard.'); return; }
    var widgets = loadWidgets();
    var payload = { title: 'Shared DashView widgets', sharedAt: new Date().toISOString(), widgets: widgets };
    var encoded;
    try { encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); }
    catch (e) { toast('Could not build a share link for this layout.'); return; }
    var base = location.href.replace(/[^/]*$/, '');
    var link = base + 'share.html#d=' + encoded;
    byId('dvShareLinkInput').value = link;
    byId('dvShareModal').classList.add('open');
  }

  /* ── TV Mode ─────────────────────────────────────────────────────────── */
  var tvIndex = 0, tvTimer = null, tvClockTimer = null;
  function renderTvClock() { var el = byId('dvTvClock'); if (el) el.textContent = new Date().toLocaleTimeString(); }
  function renderTvWidget() {
    var widgets = loadWidgets().slice().sort(function (a, b) { return a.order - b.order; });
    if (!widgets.length) return;
    tvIndex = tvIndex % widgets.length;
    var stage = byId('dvTvStage');
    stage.innerHTML = '';
    stage.appendChild(buildCard(widgets[tvIndex], { tv: true }));
    var dots = byId('dvTvDots');
    dots.innerHTML = widgets.map(function (_, i) { return '<span class="dv-tv-dot' + (i === tvIndex ? ' active' : '') + '"></span>'; }).join('');
  }
  function startTv() {
    if (!can('tvMode')) { toast('You do not have permission to use TV Mode.'); return; }
    var widgets = loadWidgets();
    if (!widgets.length) { toast('Add at least one widget before starting TV Mode.'); return; }
    tvIndex = 0;
    byId('dvTvOverlay').classList.add('open');
    renderTvWidget(); renderTvClock();
    var el = byId('dvTvOverlay');
    if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
    tvTimer = setInterval(function () { tvIndex++; renderTvWidget(); }, 7000);
    tvClockTimer = setInterval(renderTvClock, 1000);
  }
  function stopTv() {
    byId('dvTvOverlay').classList.remove('open');
    clearInterval(tvTimer); clearInterval(tvClockTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    if (!byId('dvWidgetGrid')) return; // this page has no Widget Builder view
    renderGrid();

    if (byId('dvAddWidgetBtn')) byId('dvAddWidgetBtn').addEventListener('click', function () { openModal(null); });
    if (byId('dvWidgetModalClose')) byId('dvWidgetModalClose').addEventListener('click', closeModal);
    if (byId('dvWidgetModal')) byId('dvWidgetModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeModal(); });
    if (byId('dvWidgetSaveBtn')) byId('dvWidgetSaveBtn').addEventListener('click', saveWidgetFromModal);
    if (byId('dvWidgetSourceSelect')) byId('dvWidgetSourceSelect').addEventListener('change', updateModalForSource);
    document.querySelectorAll('#dvWidgetTypeChips .chip-select').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('#dvWidgetTypeChips .chip-select').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        updateModalRows();
      });
    });
    if (byId('dvWidgetCsvDrop')) byId('dvWidgetCsvDrop').addEventListener('click', function () { byId('dvWidgetCsvInput').click(); });
    if (byId('dvWidgetCsvInput')) byId('dvWidgetCsvInput').addEventListener('change', function (e) { handleCsvFile(e.target.files[0]); });

    if (byId('dvExportLayoutBtn')) byId('dvExportLayoutBtn').addEventListener('click', function () {
      if (!can('importExport')) { toast('You do not have permission to export.'); return; }
      exportLayout();
    });
    if (byId('dvImportLayoutBtn')) byId('dvImportLayoutBtn').addEventListener('click', function () {
      if (!can('importExport')) { toast('You do not have permission to import.'); return; }
      byId('dvImportLayoutFile').click();
    });
    if (byId('dvImportLayoutFile')) byId('dvImportLayoutFile').addEventListener('change', function (e) { if (e.target.files[0]) importLayout(e.target.files[0]); });

    if (byId('dvShareBtn')) byId('dvShareBtn').addEventListener('click', openShareModal);
    if (byId('dvShareModalClose')) byId('dvShareModalClose').addEventListener('click', function () { byId('dvShareModal').classList.remove('open'); });
    if (byId('dvShareModal')) byId('dvShareModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) byId('dvShareModal').classList.remove('open'); });
    if (byId('dvShareCopyBtn')) byId('dvShareCopyBtn').addEventListener('click', function () {
      byId('dvShareLinkInput').select();
      if (navigator.clipboard) navigator.clipboard.writeText(byId('dvShareLinkInput').value).then(function () { toast('Link copied.'); });
      else { document.execCommand('copy'); toast('Link copied.'); }
    });

    if (byId('dvTvModeBtn')) byId('dvTvModeBtn').addEventListener('click', startTv);
    if (byId('dvTvExitBtn')) byId('dvTvExitBtn').addEventListener('click', stopTv);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && byId('dvTvOverlay').classList.contains('open')) stopTv(); });
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && byId('dvTvOverlay').classList.contains('open')) stopTv(); });

    document.addEventListener('dv:session-changed', renderGrid);
  });

  window.DVWidgets = { openBuilderWithSource: openBuilderWithSource, renderGrid: renderGrid, buildCard: buildCard, loadWidgets: loadWidgets };
})();
