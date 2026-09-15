/* ==========================================================================
   DashView — Widget Builder, Import/Export, Sharing & TV Mode
   ==========================================================================
   Widgets are plain JSON persisted to localStorage (dv_widgets). Each widget
   points at a data SOURCE:
     - demo   → reads window.DASHVIEW_OV (the same in-memory demo dataset the
                Overview page already renders from — see js/overview.js)
     - odoo   → reads window.DVOdoo.fetchModel() (mock Odoo client, see
                js/odoo-service.js)
     - csv    → data imported directly into the widget itself and cached on
                the widget object (client-side only, prototype)

   Nothing here talks to a real backend. Swap the `computeDemo`/DVOdoo calls
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
    revenue_total: { label: 'Total revenue', type: 'kpi' },
    orders_count: { label: 'Total orders', type: 'kpi' },
    avg_order_value: { label: 'Average order value', type: 'kpi' },
    category_breakdown: { label: 'Revenue by category', type: 'chart', chartType: 'bar' },
    region_breakdown: { label: 'Orders by region', type: 'chart', chartType: 'doughnut' },
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
    var ov = window.DASHVIEW_OV;
    if (!ov || !ov.ORDERS) return null;
    var orders = ov.ORDERS;
    if (metric === 'revenue_total') {
      var total = orders.reduce(function (s, o) { return s + o.revenue; }, 0);
      return { kind: 'kpi', value: '$' + total.toLocaleString(undefined, { maximumFractionDigits: 0 }), sub: orders.length + ' orders' };
    }
    if (metric === 'orders_count') {
      return { kind: 'kpi', value: orders.length.toLocaleString(), sub: 'Across all channels' };
    }
    if (metric === 'avg_order_value') {
      var t = orders.reduce(function (s, o) { return s + o.revenue; }, 0);
      var avg = orders.length ? t / orders.length : 0;
      return { kind: 'kpi', value: '$' + avg.toFixed(2), sub: 'Per order' };
    }
    if (metric === 'category_breakdown') {
      var byCategory = {};
      orders.forEach(function (o) { byCategory[o.category] = (byCategory[o.category] || 0) + o.revenue; });
      var labels = Object.keys(byCategory);
      return { kind: 'chart', chartType: 'bar', labels: labels, values: labels.map(function (l) { return Math.round(byCategory[l]); }) };
    }
    if (metric === 'region_breakdown') {
      var byRegion = {};
      orders.forEach(function (o) { byRegion[o.region] = (byRegion[o.region] || 0) + 1; });
      var rl = Object.keys(byRegion);
      return { kind: 'chart', chartType: 'doughnut', labels: rl, values: rl.map(function (l) { return byRegion[l]; }) };
    }
    if (metric === 'monthly_trend') {
      if (ov.MONTHS && ov.REVENUE) return { kind: 'chart', chartType: 'line', labels: ov.MONTHS, values: ov.REVENUE };
      return { kind: 'chart', chartType: 'line', labels: [], values: [] };
    }
    if (metric === 'recent_orders') {
      var rows = orders.slice(0, 6).map(function (o) { return [o.customer, o.category, '$' + o.revenue.toLocaleString()]; });
      return { kind: 'table', fields: ['Customer', 'Category', 'Revenue'], rows: rows };
    }
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

  /* ── Rendering ───────────────────────────────────────────────────────── */
  function renderKpiBody(container, data) {
    container.innerHTML = '<div class="dv-widget-kpi-value">' + esc(data.value) + '</div><div class="dv-widget-kpi-sub">' + esc(data.sub || '') + '</div>';
  }

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
    var cfg = {
      type: data.chartType || 'bar',
      data: {
        labels: data.labels,
        datasets: [{
          data: data.values,
          backgroundColor: data.chartType === 'line' ? 'rgba(232,163,61,0.18)' : data.labels.map(function (_, i) { return palette[i % palette.length]; }),
          borderColor: data.chartType === 'line' ? '#e8a33d' : 'transparent',
          borderWidth: data.chartType === 'line' ? 2 : 0,
          fill: data.chartType === 'line',
          tension: 0.35,
          borderRadius: data.chartType === 'bar' ? 6 : 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: data.chartType === 'doughnut', labels: { color: 'rgba(231,237,231,0.6)', boxWidth: 10, font: { size: 10 } } } },
        scales: data.chartType === 'doughnut' ? {} : {
          x: { ticks: { color: 'rgba(231,237,231,0.4)', font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: 'rgba(231,237,231,0.4)', font: { size: 10 } }, grid: { color: 'rgba(232,163,61,0.08)' } }
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
      if (!data) { container.innerHTML = '<p class="dv-widget-empty">Demo data isn\'t loaded on this view yet.</p>'; return; }
      if (data.kind === 'kpi') renderKpiBody(container, data);
      else if (data.kind === 'chart') renderChartBody(container, data, canvasIdPrefix + '_' + widget.id);
      else renderTableBody(container, data);
      return;
    }
    if (src.kind === 'odoo') {
      container.innerHTML = '<p class="dv-widget-loading">Fetching from Odoo…</p>';
      if (!window.DVOdoo) { container.innerHTML = '<p class="dv-widget-empty">Odoo service unavailable.</p>'; return; }
      window.DVOdoo.fetchModel(src.model, { limit: widget.type === 'kpi' ? undefined : 6 }).then(function (res) {
        if (widget.type === 'kpi') renderKpiBody(container, { value: res.total.toLocaleString(), sub: (window.DVOdoo.MODELS[src.model] || {}).label || src.model });
        else renderTableBody(container, { fields: res.fields, rows: res.rows });
      });
      return;
    }
    if (src.kind === 'csv') {
      var cached = src.data;
      if (!cached || !cached.rows.length) { container.innerHTML = '<p class="dv-widget-empty">No file imported into this widget yet — edit it to add one.</p>'; return; }
      if (widget.type === 'kpi') {
        var colIdx = cached.fields.indexOf(src.numericField);
        if (colIdx > -1) {
          var sum = cached.rows.reduce(function (s, r) { return s + (parseFloat(String(r[colIdx]).replace(/[^0-9.-]/g, '')) || 0); }, 0);
          renderKpiBody(container, { value: sum.toLocaleString(undefined, { maximumFractionDigits: 2 }), sub: 'Sum of ' + src.numericField + ' · ' + cached.rows.length + ' rows' });
        } else {
          renderKpiBody(container, { value: cached.rows.length.toLocaleString(), sub: 'Rows in ' + (src.fileName || 'imported file') });
        }
      } else {
        renderTableBody(container, { fields: cached.fields, rows: cached.rows.slice(0, 6) });
      }
      return;
    }
    container.innerHTML = '<p class="dv-widget-empty">Unknown data source.</p>';
  }

  function sourceTag(widget) {
    var src = widget.source || {};
    if (src.kind === 'demo') return 'Demo · ' + (DEMO_METRICS[src.metric] ? DEMO_METRICS[src.metric].label : src.metric);
    if (src.kind === 'odoo') return 'Odoo (mock) · ' + src.model;
    if (src.kind === 'csv') return 'Imported · ' + (src.fileName || 'file');
    return 'Unknown source';
  }

  function buildCard(widget, opts) {
    opts = opts || {};
    var tv = !!opts.tv;
    var readOnly = !!opts.readOnly;
    var card = document.createElement('div');
    card.className = tv ? 'dv-tv-widget' : 'dv-widget-card';
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
      return '<option value="odoo:' + m + '">Odoo (mock) — ' + window.DVOdoo.MODELS[m].label + '</option>';
    }).join('') : '';
    select.innerHTML =
      '<optgroup label="Demo dataset">' +
      Object.keys(DEMO_METRICS).map(function (m) { return '<option value="demo:' + m + '">' + DEMO_METRICS[m].label + '</option>'; }).join('') +
      '</optgroup>' +
      '<optgroup label="Odoo (mock)">' + odooOptions + '</optgroup>' +
      '<optgroup label="Imported file"><option value="csv:">CSV / Excel file…</option></optgroup>';
  }

  function updateModalForSource() {
    var val = byId('dvWidgetSourceSelect').value;
    var kind = val.split(':')[0];
    byId('dvWidgetCsvRow').style.display = kind === 'csv' ? 'block' : 'none';
    byId('dvWidgetNumericFieldRow').style.display = 'none';
    var typeChips = document.querySelectorAll('#dvWidgetTypeChips .chip-select');
    typeChips.forEach(function (chip) {
      var type = chip.dataset.type;
      var allowed = kind === 'demo' ? true : (type === 'kpi' || type === 'table');
      chip.style.display = allowed ? '' : 'none';
      if (!allowed) chip.classList.remove('active');
    });
    if (!document.querySelector('#dvWidgetTypeChips .chip-select.active')) {
      var firstVisible = document.querySelector('#dvWidgetTypeChips .chip-select:not([style*="display: none"])');
      if (firstVisible) firstVisible.classList.add('active');
    }
    if (kind === 'demo') {
      var metric = val.split(':')[1];
      var meta = DEMO_METRICS[metric];
      if (meta) {
        document.querySelectorAll('#dvWidgetTypeChips .chip-select').forEach(function (c) { c.classList.toggle('active', c.dataset.type === meta.type); });
      }
    }
  }

  function selectedType() {
    var active = document.querySelector('#dvWidgetTypeChips .chip-select.active');
    return active ? active.dataset.type : 'kpi';
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
    byId('dvWidgetCsvStatus').textContent = pendingCsv ? (pendingCsv.rows.length + ' rows loaded') : 'No file loaded yet.';
    updateModalForSource();
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
      source = { kind: 'csv', data: pendingCsv, fileName: pendingCsv.fileName, numericField: byId('dvWidgetNumericFieldSelect') ? byId('dvWidgetNumericFieldSelect').value : '' };
    }
    var widgets = loadWidgets();
    if (editingId) {
      var idx = widgets.findIndex(function (w) { return w.id === editingId; });
      if (idx > -1) {
        widgets[idx].title = title; widgets[idx].type = type; widgets[idx].source = source;
        widgets[idx].live = byId('dvWidgetLiveCheck').checked; widgets[idx].intervalSec = parseInt(byId('dvWidgetIntervalSelect').value, 10) || 15;
      }
    } else {
      widgets.push({
        id: uid(), title: title, type: type, source: source,
        live: byId('dvWidgetLiveCheck').checked, intervalSec: parseInt(byId('dvWidgetIntervalSelect').value, 10) || 15,
        order: widgets.length
      });
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
        var numSelect = byId('dvWidgetNumericFieldSelect');
        if (numSelect) {
          numSelect.innerHTML = '<option value="">— row count only —</option>' + parsed.fields.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('');
          byId('dvWidgetNumericFieldRow').style.display = selectedType() === 'kpi' ? 'block' : 'none';
        }
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
        if (byId('dvWidgetNumericFieldRow')) byId('dvWidgetNumericFieldRow').style.display = (chip.dataset.type === 'kpi' && pendingCsv) ? 'block' : 'none';
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
