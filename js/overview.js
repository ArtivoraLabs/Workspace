/* ==========================================================================
   DashView — Overview tab (KPIs, revenue/category charts, orders table)
   ========================================================================== */
(function () {
  'use strict';

  /* Deterministic PRNG (mulberry32) so the demo dataset — and every KPI,
     chart and report built on top of it — is identical on every load and
     every refresh. A reporting surface whose headline numbers reshuffle
     each time the page reloads is not something you can screenshot, trust,
     or hand to a director; a fixed seed makes the "sample data" behave like
     real, reproducible data. */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = mulberry32(20260910);

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var REVENUE = [42380,38920,51240,48760,62450,58300,71820,68940,82150,76430,94280,87620];
  var ORDERS_M = [612,584,723,695,881,841,1024,987,1183,1098,1362,1245];
  var CATS = ['Electronics','Beauty','Home','Toys','Clothing','Sports'];
  var CAT_REV = [94200,51300,67800,38400,24100,8700];
  var CAT_COLORS = ['#e8a33d','#4fb477','#5b8fae','#c76b3c','#f0c06a','#e5654f'];
  var REGIONS = ['North America','Europe','APAC','LATAM','MEA'];
  var REGION_WEIGHTS = [0.38,0.27,0.19,0.10,0.06];
  var REGION_COLORS = ['#e8a33d','#5b8fae','#4fb477','#f0c06a','#e5654f'];
  var MONTHLY_GOAL = 300000;

  function weightedPick(arr, weights) {
    var r = rand(), sum = 0;
    for (var i = 0; i < arr.length; i++) { sum += weights[i]; if (r <= sum) return arr[i]; }
    return arr[arr.length-1];
  }

  var ORDERS = [];
  var firstNames = ['Liam','Emma','Noah','Olivia','William','Ava','James','Sophia','Oliver','Isabella'];
  var lastNames = ['Smith','Johnson','Chen','Garcia','Kim','Patel','Lee','Wilson','Davis','Taylor'];
  for (var i = 0; i < 120; i++) {
    var cat = CATS[Math.floor(rand()*CATS.length)];
    var price = +(20 + rand()*160).toFixed(2);
    var qty = Math.ceil(rand()*5);
    var month = String(Math.floor(rand()*12)+1).padStart(2,'0');
    var day = String(Math.floor(rand()*28)+1).padStart(2,'0');
    var fn = firstNames[Math.floor(rand()*firstNames.length)];
    var ln = lastNames[Math.floor(rand()*lastNames.length)];
    ORDERS.push({
      id:'ORD-'+(1000+i), customer: fn+' '+ln, category:cat, price:price, qty:qty,
      revenue:+(price*qty).toFixed(2), date:'2023-'+month+'-'+day, region: weightedPick(REGIONS, REGION_WEIGHTS)
    });
  }

  function byId(id){ return document.getElementById(id); }

  /* ── Chart theming ────────────────────────────────────────────────────── */
  function chartTheme() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      text: light ? 'rgba(26,22,37,.55)' : 'rgba(234,237,248,.5)',
      gridY: light ? 'rgba(124,58,237,.08)' : 'rgba(139,92,246,.08)',
      tooltipBg: light ? 'rgba(255,255,255,.98)' : 'rgba(14,17,38,.96)',
      tooltipBorder: light ? 'rgba(124,58,237,.2)' : 'rgba(139,92,246,.28)',
      tooltipTitle: light ? '#1a1625' : 'rgba(234,237,248,.9)',
      tooltipBody: light ? 'rgba(26,22,37,.68)' : 'rgba(234,237,248,.65)',
      revenueLine: light ? '#b87316' : '#e8a33d',
      ordersLine: light ? '#3d7290' : '#5b8fae',
    };
  }
  var ct = chartTheme();

  var revCtx = byId('revenueChart').getContext('2d');
  function revenueFillGradient() {
    var g = revCtx.createLinearGradient(0,0,0,220);
    g.addColorStop(0,'rgba(139,92,246,.25)');
    g.addColorStop(1,'rgba(139,92,246,0)');
    return g;
  }

  var revenueChart = new Chart(revCtx, {
    type:'line',
    data:{ labels:MONTHS, datasets:[
      { label:'Revenue', data:REVENUE, borderColor:ct.revenueLine, backgroundColor:revenueFillGradient(), borderWidth:2.5, tension:.4, fill:true, pointBackgroundColor:ct.revenueLine, pointRadius:4, pointHoverRadius:6 },
      { label:'Orders', data:ORDERS_M.map(function(v){return v*65;}), borderColor:ct.ordersLine, backgroundColor:'transparent', borderWidth:2, borderDash:[5,3], tension:.4, pointRadius:3, pointHoverRadius:5 }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
      plugins:{ legend:{display:false}, tooltip:{
        backgroundColor:ct.tooltipBg, borderColor:ct.tooltipBorder, borderWidth:1,
        titleColor:ct.tooltipTitle, bodyColor:ct.tooltipBody, padding:12,
        callbacks:{ label:function(c){ return c.datasetIndex===0 ? ' Revenue: $'+(c.raw/1000).toFixed(1)+'k' : ' Orders: '+Math.round(c.raw/65); } }
      }},
      scales:{ x:{grid:{display:false}, ticks:{font:{size:11}}}, y:{grid:{color:ct.gridY}, ticks:{callback:function(v){return '$'+(v/1000).toFixed(0)+'k';}, font:{size:11}}} }
    }
  });

  var catCtx = byId('categoryChart').getContext('2d');
  var categoryChart = new Chart(catCtx, {
    type:'doughnut',
    data:{ labels:CATS, datasets:[{ data:CAT_REV, backgroundColor:CAT_COLORS, borderColor:'rgba(0,0,0,0)', borderWidth:4, hoverOffset:8 }] },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'72%',
      plugins:{ legend:{display:false}, tooltip:{
        backgroundColor:ct.tooltipBg, borderColor:ct.tooltipBorder, borderWidth:1,
        titleColor:ct.tooltipTitle, bodyColor:ct.tooltipBody,
        callbacks:{ label:function(c){ return '$'+(c.raw/1000).toFixed(1)+'k · '+((c.raw/CAT_REV.reduce(function(a,b){return a+b;},0))*100).toFixed(1)+'%'; } }
      }}
    }
  });

  // Exposed so shell.js can resize these when the Overview tab becomes visible
  // (a canvas inside a display:none panel reports zero size until then).
  window.__overviewCharts = { get revenue(){ return revenueChart; }, get category(){ return categoryChart; } };

  // Exposed so the shared theme toggle (shell.js) can re-tint these charts.
  window.applyOverviewChartTheme = function () {
    ct = chartTheme();
    Chart.defaults.color = ct.text;
    revenueChart.data.datasets[0].borderColor = ct.revenueLine;
    revenueChart.data.datasets[0].pointBackgroundColor = ct.revenueLine;
    revenueChart.data.datasets[1].borderColor = ct.ordersLine;
    if (revenueChart.config.type === 'line') revenueChart.data.datasets[0].backgroundColor = revenueFillGradient();
    Object.assign(revenueChart.options.plugins.tooltip, { backgroundColor:ct.tooltipBg, borderColor:ct.tooltipBorder, titleColor:ct.tooltipTitle, bodyColor:ct.tooltipBody });
    revenueChart.options.scales.y.grid.color = ct.gridY;
    revenueChart.update();
    Object.assign(categoryChart.options.plugins.tooltip, { backgroundColor:ct.tooltipBg, borderColor:ct.tooltipBorder, titleColor:ct.tooltipTitle, bodyColor:ct.tooltipBody });
    categoryChart.update();
  };

  var catLegend = byId('catLegend');
  CATS.forEach(function (c,i) {
    catLegend.innerHTML += '<span class="legend-item"><span class="legend-dot" style="background:'+CAT_COLORS[i]+'"></span>'+c+'</span>';
  });

  document.querySelectorAll('.chart-type-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.chart-type-btn').forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      revenueChart.config.type = btn.dataset.type;
      if (btn.dataset.type === 'bar') {
        revenueChart.data.datasets[0].backgroundColor = CAT_COLORS[0]+'66';
        revenueChart.data.datasets[0].borderRadius = 4;
      } else {
        revenueChart.data.datasets[0].backgroundColor = revenueFillGradient();
      }
      revenueChart.destroy();
      revenueChart = new Chart(revCtx, revenueChart.config);
    });
  });

  /* ── Orders table ─────────────────────────────────────────────────────── */
  var currentPage = 1, perPage = 10;
  var filtered = ORDERS.slice();

  function renderTable() {
    var start = (currentPage-1)*perPage;
    var rows = filtered.slice(start, start+perPage);
    byId('ordersBody').innerHTML = rows.map(function (o) {
      return '<tr><td class="td-order">'+o.id+'</td><td class="td-customer">'+o.customer+'</td>'
        + '<td><span class="cat-badge cat-'+o.category+'">'+o.category+'</span></td>'
        + '<td>$'+o.price.toFixed(2)+'</td><td class="td-qty">'+o.qty+'</td>'
        + '<td class="td-rev">$'+o.revenue.toFixed(2)+'</td>'
        + '<td style="color:var(--ink-30);font-size:.75rem;font-family:var(--f-mono)">'+o.date+'</td></tr>';
    }).join('');

    var total = filtered.length, pages = Math.ceil(total/perPage) || 1;
    byId('paginationInfo').textContent = 'Showing '+(start+1)+'–'+Math.min(start+perPage,total)+' of '+total+' orders';
    var btns = byId('paginationBtns'); btns.innerHTML = '';
    var prev = document.createElement('button'); prev.className='page-btn'; prev.textContent='←'; prev.disabled = currentPage<=1;
    prev.onclick = function(){ currentPage--; renderTable(); }; btns.appendChild(prev);
    var maxP = Math.min(pages,5);
    for (var p=1; p<=maxP; p++) {
      var b = document.createElement('button');
      b.className = 'page-btn'+(p===currentPage?' active':''); b.textContent = p;
      b.onclick = (function(pp){ return function(){ currentPage=pp; renderTable(); }; })(p);
      btns.appendChild(b);
    }
    var next = document.createElement('button'); next.className='page-btn'; next.textContent='→'; next.disabled = currentPage>=pages;
    next.onclick = function(){ currentPage++; renderTable(); }; btns.appendChild(next);
  }

  function applyFilter() {
    var q = byId('tableSearch').value.toLowerCase();
    var cat = byId('catFilter').value;
    filtered = ORDERS.filter(function (o) {
      var matchQ = !q || o.customer.toLowerCase().indexOf(q)>-1 || o.id.toLowerCase().indexOf(q)>-1 || o.category.toLowerCase().indexOf(q)>-1;
      var matchC = !cat || o.category === cat;
      var matchExtra = window.__ovExtraFilter ? window.__ovExtraFilter(o) : true;
      return matchQ && matchC && matchExtra;
    });
    currentPage = 1; renderTable();
  }
  byId('tableSearch').addEventListener('input', applyFilter);
  byId('catFilter').addEventListener('change', applyFilter);
  renderTable();

  // Exposed so dashboard-pro.js (filters, live simulation, role/board switching,
  // export) can read/extend this module without duplicating the data layer.
  window.__ovApplyFilter = applyFilter;
  window.DASHVIEW_OV = {
    ORDERS: ORDERS, CATS: CATS, CAT_COLORS: CAT_COLORS, CAT_REV: CAT_REV,
    REGIONS: REGIONS, REGION_COLORS: REGION_COLORS, REGION_WEIGHTS: REGION_WEIGHTS,
    MONTHS: MONTHS, REVENUE: REVENUE, ORDERS_M: ORDERS_M,
    firstNames: firstNames, lastNames: lastNames, weightedPick: weightedPick,
    charts: { get revenue(){ return revenueChart; }, get category(){ return categoryChart; } },
    chartTheme: chartTheme
  };

  /* ── Date range ───────────────────────────────────────────────────────── */
  // Real filtering (synced with the region/role filters) lives in dashboard-pro.js,
  // which owns currentSubset()/recomputeAll() — the single choke point every KPI,
  // chart, the table and the funnel all read from. This file just renders the date.
  byId('dateLabel').textContent = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  /* ── Customer insights (top customers + repeat rate) ─────────────────── */
  var custMap = {};
  ORDERS.forEach(function (o) {
    if (!custMap[o.customer]) custMap[o.customer] = { name:o.customer, orders:0, revenue:0 };
    custMap[o.customer].orders += 1;
    custMap[o.customer].revenue += o.revenue;
  });
  var custList = Object.keys(custMap).map(function(k){ return custMap[k]; });
  var repeatCount = custList.filter(function(c){ return c.orders > 1; }).length;
  var repeatRate = Math.round((repeatCount / custList.length) * 100);
  var avgItems = (ORDERS.reduce(function(s,o){ return s+o.qty; },0) / ORDERS.length).toFixed(1);
  if (byId('kpiRepeat')) byId('kpiRepeat').textContent = repeatRate + '%';
  if (byId('kpiAvgItems')) byId('kpiAvgItems').textContent = avgItems;

  var AVATAR_COLORS = ['#e8a33d','#5b8fae','#4fb477','#f0c06a','#e5654f','#c76b3c','#4a8c86','#9a9552'];
  function initials(name){ return name.split(' ').map(function(p){return p[0];}).join('').slice(0,2).toUpperCase(); }
  function hashColor(name){ var h=0; for(var i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))>>>0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }

  var topCustomers = custList.sort(function(a,b){ return b.revenue - a.revenue; }).slice(0,5);
  var topCustEl = byId('topCustomersList');
  if (topCustEl) {
    var maxCustRev = topCustomers[0] ? topCustomers[0].revenue : 1;
    topCustEl.innerHTML = topCustomers.map(function (c, idx) {
      return '<div class="rank-row">'
        + '<span class="rank-num">'+(idx+1)+'</span>'
        + '<span class="rank-avatar" style="background:'+hashColor(c.name)+'">'+initials(c.name)+'</span>'
        + '<div class="rank-main"><span class="rank-name">'+c.name+'</span><span class="rank-sub">'+c.orders+' orders</span></div>'
        + '<div class="rank-end"><span class="rank-value">$'+c.revenue.toFixed(0)+'</span>'
        + '<div class="progress-track" style="width:64px;margin-top:4px;"><div class="progress-fill" style="width:'+Math.round(c.revenue/maxCustRev*100)+'%;background:'+hashColor(c.name)+'"></div></div></div>'
        + '</div>';
    }).join('');
  }

  /* ── Sales by region ──────────────────────────────────────────────────── */
  var regionMap = {};
  REGIONS.forEach(function(r){ regionMap[r] = 0; });
  ORDERS.forEach(function (o) { regionMap[o.region] += o.revenue; });
  var totalRegionRev = REGIONS.reduce(function(s,r){ return s+regionMap[r]; }, 0);
  var regionEl = byId('regionList');
  if (regionEl) {
    regionEl.innerHTML = REGIONS.map(function (r, idx) {
      var pct = totalRegionRev ? Math.round(regionMap[r]/totalRegionRev*100) : 0;
      return '<div class="region-row">'
        + '<span class="region-dot" style="background:'+REGION_COLORS[idx]+'"></span>'
        + '<span class="region-name">'+r+'</span>'
        + '<div class="progress-track" style="flex:1;margin:0 10px;"><div class="progress-fill" style="width:'+pct+'%;background:'+REGION_COLORS[idx]+'"></div></div>'
        + '<span class="region-pct">'+pct+'%</span>'
        + '</div>';
    }).join('');
  }

  /* ── Monthly goal progress ────────────────────────────────────────────── */
  var totalRevenue = ORDERS.reduce(function(s,o){ return s+o.revenue; }, 0);
  var goalPct = Math.min(100, Math.round(totalRevenue / MONTHLY_GOAL * 100));
  var today = new Date();
  var daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  var daysLeft = daysInMonth - today.getDate();
  if (byId('goalRing')) byId('goalRing').style.background = 'conic-gradient(var(--signal) '+(goalPct*3.6)+'deg, var(--paper-alt) 0deg)';
  if (byId('goalPct')) byId('goalPct').textContent = goalPct + '%';
  if (byId('goalCurrent')) byId('goalCurrent').textContent = '$'+(totalRevenue/1000).toFixed(1)+'k of $'+(MONTHLY_GOAL/1000).toFixed(0)+'k target';
  if (byId('goalRemaining')) byId('goalRemaining').textContent = '$'+Math.max(0,(MONTHLY_GOAL-totalRevenue)/1000).toFixed(1)+'k remaining · '+daysLeft+' days left';

  /* ── Export CSV ───────────────────────────────────────────────────────── */
  function exportCSV(filename) {
    // Respect whatever region/role/date filter is currently active (dashboard-pro.js
    // sets this) so a Sales Rep — or anyone with a filter applied — only ever
    // exports the orders they can actually see on screen.
    var source = window.__ovExtraFilter ? ORDERS.filter(window.__ovExtraFilter) : ORDERS;
    var rows = ['Order ID,Customer,Category,Price,Qty,Revenue,Date'];
    source.forEach(function (o) { rows.push(o.id+','+o.customer+','+o.category+','+o.price+','+o.qty+','+o.revenue+','+o.date); });
    var blob = new Blob([rows.join('\n')], {type:'text/csv'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename || 'orders-export.csv'; a.click();
    URL.revokeObjectURL(url);
  }
  window.__overviewExportCSV = exportCSV;
  var exportBtn = byId('exportOrdersBtn');
  if (exportBtn) exportBtn.addEventListener('click', function () {
    if (window.showToast) window.showToast('Preparing CSV…');
    setTimeout(exportCSV, 400);
  });
})();
