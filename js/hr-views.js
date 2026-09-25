/* ==========================================================================
   DashView People — secondary sections
   --------------------------------------------------------------------------
   People, Hiring, Devices, Apps, Salary, Calendar, Reviews and Settings.
   Each renders from the same store the dashboard uses, so a change made here
   shows up on the dashboard immediately and survives a reload.
   ========================================================================== */
(function (global) {
  'use strict';

  var S = global.PeopleStore;
  var U = S.util;
  var I = global.HRIcon;

  function byId(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (global.hrToast) global.hrToast(m); }
  function av(e, s) { return global.hrAvatar ? global.hrAvatar(e, s) : ''; }

  /* Per-view UI state that shouldn't live in the persisted store. */
  var ui = {
    peopleQuery: '', peopleDept: 'All', peopleSort: 'name', peopleView: 'list',
    deviceFilter: 'All',
    calMonth: null
  };

  function head(title, sub, tools) {
    return '<div class="hr-viewhead"><div>' +
      '<h1 class="hr-viewtitle">' + esc(title) + '</h1>' +
      (sub ? '<div class="hr-viewsub">' + esc(sub) + '</div>' : '') +
      '</div>' + (tools ? '<div class="hr-toolbar">' + tools + '</div>' : '') + '</div>';
  }

  function tile(label, val, note) {
    return '<div class="hr-tile"><div class="hr-tile-label">' + esc(label) + '</div>' +
      '<div class="hr-tile-val">' + esc(val) + '</div>' +
      (note ? '<div class="hr-tile-note">' + esc(note) + '</div>' : '') + '</div>';
  }

  function card(inner) { return '<div class="hr-card">' + inner + '</div>'; }

  function downloadCSV(name, rows) {
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var v = String(c == null ? '' : c);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Exported ' + name);
  }

  /* ══ People ════════════════════════════════════════════════════════════ */
  function renderPeople() {
    var st = S.get();
    var depts = ['All'].concat(st.team.map(function (e) { return e.dept; })
      .filter(function (d, i, a) { return a.indexOf(d) === i; }).sort());

    var rows = st.team.filter(function (e) {
      var q = ui.peopleQuery.toLowerCase();
      var hit = !q || (e.name + ' ' + e.role + ' ' + e.dept + ' ' + e.email).toLowerCase().indexOf(q) > -1;
      return hit && (ui.peopleDept === 'All' || e.dept === ui.peopleDept);
    }).sort(function (a, b) {
      if (ui.peopleSort === 'pay') return b.pay - a.pay;
      if (ui.peopleSort === 'start') return a.start.localeCompare(b.start);
      return a.name.localeCompare(b.name);
    });

    var viewToggle =
      '<div class="hr-viewtoggle" role="group" aria-label="Directory view">' +
        '<button type="button" class="hr-viewtoggle-btn" id="pplViewList" data-pplview="list" aria-pressed="' + (ui.peopleView !== 'grid') + '" aria-label="List view" title="List view">' + I.svg('list') + '</button>' +
        '<button type="button" class="hr-viewtoggle-btn" id="pplViewGrid" data-pplview="grid" aria-pressed="' + (ui.peopleView === 'grid') + '" aria-label="Grid view" title="Grid view">' + I.svg('grid') + '</button>' +
      '</div>';

    var tools = viewToggle +
      '<input class="hr-field" id="pplSearch" type="search" placeholder="Search name or role" value="' + esc(ui.peopleQuery) + '"/>' +
      '<select class="hr-field" id="pplDept" aria-label="Filter by department">' +
        depts.map(function (d) { return '<option value="' + esc(d) + '"' + (d === ui.peopleDept ? ' selected' : '') + '>' + (d === 'All' ? 'All departments' : esc(d)) + '</option>'; }).join('') +
      '</select>' +
      '<select class="hr-field" id="pplSort" aria-label="Sort people">' +
        [['name', 'Sort: Name'], ['pay', 'Sort: Highest paid'], ['start', 'Sort: Longest serving']].map(function (o) {
          return '<option value="' + o[0] + '"' + (ui.peopleSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') +
      '</select>' +
      '<button class="hr-btn hr-btn--quiet" id="pplExport">' + I.svg('download') + 'Export</button>';

    var empty = '<div class="hr-empty"><div class="hr-empty-title">No one matches that search</div>' +
        '<div class="hr-empty-note">Clear the filters to see the full directory.</div></div>';

    var body;
    if (!rows.length) {
      body = empty;
    } else if (ui.peopleView === 'grid') {
      body = '<div class="hr-people-grid">' + rows.map(function (e) {
        var tag = e.status === 'Active' ? 'hr-tag--ok' : e.status === 'On leave' ? 'hr-tag--warn' : '';
        return '<div class="hr-people-card">' +
          '<div class="hr-people-card-top">' + av(e, 44) + '<span class="hr-tag ' + tag + '">' + esc(e.status) + '</span></div>' +
          '<div><div class="hr-people-card-name">' + esc(e.name) + '</div>' +
          '<div class="hr-people-card-role">' + esc(e.role) + '</div></div>' +
          '<div class="hr-people-card-meta"><span>' + esc(e.dept) + '</span><span>' + esc(e.type) + '</span></div>' +
          '<div class="hr-people-card-foot"><span class="hr-people-card-pay">' + U.money(e.pay) + '</span>' +
          '<button class="hr-btn hr-btn--quiet" data-spot="' + e.id + '">Spotlight</button></div>' +
          '</div>';
      }).join('') + '</div>';
    } else {
      body =
        '<div class="hr-tablewrap"><table class="hr-table">' +
        '<thead><tr><th>Name</th><th>Department</th><th>Contract</th><th>Status</th><th class="hr-num">Monthly</th><th></th></tr></thead><tbody>' +
        rows.map(function (e) {
          var tag = e.status === 'Active' ? 'hr-tag--ok' : e.status === 'On leave' ? 'hr-tag--warn' : '';
          return '<tr>' +
            '<td><span class="hr-person">' + av(e, 34) +
              '<span><span class="hr-person-name">' + esc(e.name) + '</span>' +
              '<span class="hr-person-sub">' + esc(e.role) + '</span></span></span></td>' +
            '<td>' + esc(e.dept) + '</td>' +
            '<td>' + esc(e.type) + '</td>' +
            '<td><span class="hr-tag ' + tag + '">' + esc(e.status) + '</span></td>' +
            '<td class="hr-num">' + U.money(e.pay) + '</td>' +
            '<td class="hr-num"><button class="hr-btn hr-btn--quiet" data-spot="' + e.id + '">Spotlight</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>';
    }

    var active = st.team.filter(function (e) { return e.status === 'Active'; }).length;
    var payroll = st.team.reduce(function (a, e) { return a + e.pay; }, 0);

    var pplSub = st.team.length + ' people in the directory' + (global.__pplOdooLive ? ' · Live from Odoo' : '');
    byId('view-people').innerHTML =
      head('People', pplSub, tools) +
      '<div class="hr-tiles">' +
        tile('Directory', String(st.team.length), 'tracked in this workspace') +
        tile('Active', String(active), st.team.length - active + ' on leave or notice') +
        tile('Monthly payroll', U.money(payroll), U.money(payroll * 12) + ' annualised') +
        tile('Departments', String(depts.length - 1), 'across the company') +
      '</div>' + card(body);

    on(byId('pplSearch'), 'input', function (e) {
      /* Re-rendering replaces the input, so carry the caret across rather
         than dumping it at the end — otherwise editing mid-word is unusable. */
      var caret = e.target.selectionStart;
      ui.peopleQuery = e.target.value;
      renderPeople();
      var f = byId('pplSearch');
      f.focus();
      try { f.setSelectionRange(caret, caret); } catch (err) {}
    });
    on(byId('pplDept'), 'change', function (e) { ui.peopleDept = e.target.value; renderPeople(); });
    on(byId('pplSort'), 'change', function (e) { ui.peopleSort = e.target.value; renderPeople(); });
    byId('view-people').querySelectorAll('[data-pplview]').forEach(function (b) {
      on(b, 'click', function () {
        if (ui.peopleView === b.dataset.pplview) return;
        ui.peopleView = b.dataset.pplview;
        renderPeople();
      });
    });
    on(byId('pplExport'), 'click', function () {
      downloadCSV('people.csv', [['Name', 'Role', 'Department', 'Contract', 'Status', 'Monthly', 'Started', 'Email']]
        .concat(rows.map(function (e) { return [e.name, e.role, e.dept, e.type, e.status, e.pay, e.start, e.email]; })));
    });
    byId('view-people').querySelectorAll('[data-spot]').forEach(function (b) {
      on(b, 'click', function () {
        S.setSpotlight(b.dataset.spot);
        global.hrShowView('dashboard');
        toast('Spotlight: ' + S.employee(b.dataset.spot).name);
      });
    });
  }

  /* ══ Hiring ════════════════════════════════════════════════════════════ */
  function renderHiring() {
    var st = S.get();
    var stages = S.STAGES;

    var board = stages.map(function (stage) {
      var items = st.candidates.filter(function (c) { return c.stage === stage; });
      return '<div class="hr-col" data-stage="' + esc(stage) + '">' +
        '<div class="hr-col-head"><span>' + esc(stage) + '</span>' +
        '<span class="hr-col-count">' + items.length + '</span></div>' +
        items.map(function (c) {
          var i = stages.indexOf(c.stage);
          return '<div class="hr-cand" draggable="true" data-cand="' + c.id + '">' +
            '<div class="hr-cand-name">' + esc(c.name) + '</div>' +
            '<div class="hr-cand-role">' + esc(c.role) + '</div>' +
            '<div class="hr-cand-foot"><span>' + esc(c.source) + ' · ' + c.days + 'd</span>' +
            '<span class="hr-cand-move">' +
              '<button data-move="-1" data-id="' + c.id + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move back">&#8249;</button>' +
              '<button data-move="1" data-id="' + c.id + '"' + (i === stages.length - 1 ? ' disabled' : '') + ' aria-label="Move forward">&#8250;</button>' +
            '</span></div></div>';
        }).join('') +
        '</div>';
    }).join('');

    var offers = st.candidates.filter(function (c) { return c.stage === 'Offer'; }).length;
    var hired = st.candidates.filter(function (c) { return c.stage === 'Hired'; }).length;
    var avgDays = Math.round(st.candidates.reduce(function (a, c) { return a + c.days; }, 0) / st.candidates.length);

    var hireSub = global.__pplOdooLive
      ? 'Live from Odoo (hr.applicant) · read-only — move a candidate\u2019s stage in Odoo'
      : 'Drag a card between columns, or use the arrows';
    byId('view-hiring').innerHTML =
      head('Hiring', hireSub) +
      '<div class="hr-tiles">' +
        tile('In pipeline', String(st.candidates.length - hired), 'active candidates') +
        tile('At offer', String(offers), 'awaiting signature') +
        tile('Hired', String(hired), 'this cycle') +
        tile('Avg. time in stage', avgDays + ' d', 'across the pipeline') +
      '</div>' +
      '<div class="hr-board">' + board + '</div>';

    /* In live mode the board is read-only: candidates come from Odoo and any
       local move would just be overwritten by the next 60s sync, which is
       more confusing than not letting the drag start in the first place. */
    if (global.__pplOdooLive) {
      byId('view-hiring').querySelectorAll('[data-cand]').forEach(function (el) { el.removeAttribute('draggable'); });
      return;
    }

    byId('view-hiring').querySelectorAll('[data-move]').forEach(function (b) {
      on(b, 'click', function (e) {
        e.stopPropagation();
        var c = st.candidates.filter(function (x) { return x.id === b.dataset.id; })[0];
        var next = stages[stages.indexOf(c.stage) + (+b.dataset.move)];
        if (next) { S.moveCandidate(c.id, next); toast(c.name + ' → ' + next); }
      });
    });

    /* Drag and drop between columns. */
    var dragId = null;
    byId('view-hiring').querySelectorAll('[data-cand]').forEach(function (el) {
      on(el, 'dragstart', function (e) {
        dragId = el.dataset.cand;
        el.classList.add('is-drag');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
      });
      on(el, 'dragend', function () { el.classList.remove('is-drag'); dragId = null; });
    });
    byId('view-hiring').querySelectorAll('[data-stage]').forEach(function (col) {
      on(col, 'dragover', function (e) { e.preventDefault(); col.classList.add('is-over'); });
      on(col, 'dragleave', function () { col.classList.remove('is-over'); });
      on(col, 'drop', function (e) {
        e.preventDefault();
        col.classList.remove('is-over');
        var id = dragId || e.dataTransfer.getData('text/plain');
        if (!id) return;
        var c = st.candidates.filter(function (x) { return x.id === id; })[0];
        if (c && c.stage !== col.dataset.stage) {
          S.moveCandidate(id, col.dataset.stage);
          toast(c.name + ' → ' + col.dataset.stage);
        }
      });
    });
  }

  /* ══ Devices ═══════════════════════════════════════════════════════════ */
  function renderDevices() {
    var st = S.get();
    var STATUSES = ['Issued', 'In stock', 'Repair', 'Retired'];
    var list = st.devices.filter(function (d) {
      return ui.deviceFilter === 'All' || d.status === ui.deviceFilter;
    });

    var tools = '<select class="hr-field" id="devFilter" aria-label="Filter devices">' +
      ['All'].concat(STATUSES).map(function (s) {
        return '<option' + (ui.deviceFilter === s ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('') + '</select>' +
      '<button class="hr-btn hr-btn--quiet" id="devExport">' + I.svg('download') + 'Export</button>';

    var body = list.length ? (
      '<div class="hr-tablewrap"><table class="hr-table">' +
      '<thead><tr><th>Device</th><th>Serial</th><th>Assigned to</th><th>Status</th></tr></thead><tbody>' +
      list.map(function (d) {
        var owner = d.assigned ? S.employee(d.assigned) : null;
        var tag = d.status === 'Issued' ? 'hr-tag--ok' : d.status === 'Repair' ? 'hr-tag--stop' :
                  d.status === 'Retired' ? '' : 'hr-tag--warn';
        return '<tr>' +
          '<td><span class="hr-person"><span class="hr-devthumb"></span>' +
            '<span><span class="hr-person-name">' + esc(d.name) + '</span>' +
            '<span class="hr-person-sub">' + esc(d.meta) + '</span></span></span></td>' +
          '<td style="font-variant-numeric:tabular-nums">' + esc(d.serial) + '</td>' +
          '<td><select class="hr-field" data-assign="' + d.id + '" aria-label="Assign ' + esc(d.name) + '">' +
            '<option value="">— Unassigned —</option>' +
            st.team.map(function (e) {
              return '<option value="' + e.id + '"' + (owner && owner.id === e.id ? ' selected' : '') + '>' + esc(e.name) + '</option>';
            }).join('') + '</select></td>' +
          '<td><span class="hr-statuscell"><span class="hr-tag ' + tag + '">' + esc(d.status) + '</span>' +
            '<select class="hr-field hr-tagsel" data-status="' + d.id + '" aria-label="Change status for ' + esc(d.name) + '">' +
            STATUSES.map(function (s) {
              return '<option' + (d.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
            }).join('') + '</select></span></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>'
    ) : '<div class="hr-empty"><div class="hr-empty-title">Nothing in this state</div>' +
        '<div class="hr-empty-note">Switch the filter to see the rest of the inventory.</div></div>';

    var issued = st.devices.filter(function (d) { return d.status === 'Issued'; }).length;
    var stock = st.devices.filter(function (d) { return d.status === 'In stock'; }).length;
    var repair = st.devices.filter(function (d) { return d.status === 'Repair'; }).length;

    byId('view-devices').innerHTML =
      head('Devices', 'Hardware issued across the company · tracked in this workspace (not from Odoo)', tools) +
      '<div class="hr-tiles">' +
        tile('Total units', String(st.devices.length), 'in the asset register') +
        tile('Issued', String(issued), 'with a named owner') +
        tile('In stock', String(stock), 'ready to assign') +
        tile('In repair', String(repair), repair ? 'chase the vendor' : 'nothing outstanding') +
      '</div>' + card(body);

    on(byId('devFilter'), 'change', function (e) { ui.deviceFilter = e.target.value; renderDevices(); });
    on(byId('devExport'), 'click', function () {
      downloadCSV('devices.csv', [['Device', 'Detail', 'Serial', 'Assigned', 'Status']]
        .concat(list.map(function (d) {
          var o = d.assigned ? S.employee(d.assigned) : null;
          return [d.name, d.meta, d.serial, o ? o.name : '', d.status];
        })));
    });
    byId('view-devices').querySelectorAll('[data-assign]').forEach(function (sel) {
      on(sel, 'change', function () {
        S.assignDevice(sel.dataset.assign, sel.value || null);
        toast(sel.value ? 'Device assigned to ' + S.employee(sel.value).name : 'Device returned to stock');
      });
    });
    byId('view-devices').querySelectorAll('[data-status]').forEach(function (sel) {
      on(sel, 'change', function () {
        S.setDeviceStatus(sel.dataset.status, sel.value);
        toast('Status set to ' + sel.value);
      });
    });
  }

  /* ══ Apps ══════════════════════════════════════════════════════════════ */
  function renderApps() {
    var st = S.get();
    var monthly = st.apps.reduce(function (a, x) { return a + x.cost; }, 0);
    var seats = st.apps.reduce(function (a, x) { return a + x.seats; }, 0);
    var used = st.apps.reduce(function (a, x) { return a + x.used; }, 0);
    var waste = st.apps.reduce(function (a, x) {
      return a + Math.round((x.cost / x.seats) * (x.seats - x.used));
    }, 0);

    var body = '<div class="hr-tablewrap"><table class="hr-table">' +
      '<thead><tr><th>App</th><th>Category</th><th>Seat use</th><th class="hr-num">Seats</th><th class="hr-num">Monthly</th></tr></thead><tbody>' +
      st.apps.slice().sort(function (a, b) { return b.cost - a.cost; }).map(function (a) {
        var pct = Math.round((a.used / a.seats) * 100);
        var cls = pct >= 100 ? ' hr-meter--full' : pct >= 85 ? ' hr-meter--warn' : '';
        return '<tr>' +
          '<td><span class="hr-person">' +
            '<span class="hr-mono" style="background:' + a.tone + ';color:#16160F">' + esc(a.name.slice(0, 2)) + '</span>' +
            '<span class="hr-person-name">' + esc(a.name) + '</span></span></td>' +
          '<td>' + esc(a.cat) + '</td>' +
          '<td><span class="hr-meter' + cls + '"><span style="width:' + Math.min(100, pct) + '%"></span></span></td>' +
          '<td class="hr-num">' + a.used + ' / ' + a.seats + '</td>' +
          '<td class="hr-num">' + U.money(a.cost) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    byId('view-apps').innerHTML =
      head('Apps', 'Subscriptions and seat utilisation · tracked in this workspace (not from Odoo)') +
      '<div class="hr-tiles">' +
        tile('Monthly spend', U.money(monthly), U.money(monthly * 12) + ' a year') +
        tile('Seats owned', String(seats), used + ' currently assigned') +
        tile('Utilisation', Math.round((used / seats) * 100) + '%', 'across all tools') +
        tile('Idle spend', U.money(waste), 'recoverable by trimming seats') +
      '</div>' + card(body);
  }

  /* ══ Salary ════════════════════════════════════════════════════════════ */
  function renderSalary() {
    var st = S.get();
    var team = st.team.slice().sort(function (a, b) { return b.pay - a.pay; });
    var total = team.reduce(function (a, e) { return a + e.pay; }, 0);
    var median = (function () {
      var v = team.map(function (e) { return e.pay; }).sort(function (a, b) { return a - b; });
      var m = Math.floor(v.length / 2);
      return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
    })();

    var byDept = {};
    team.forEach(function (e) { byDept[e.dept] = (byDept[e.dept] || 0) + e.pay; });
    var deptRows = Object.keys(byDept).sort(function (a, b) { return byDept[b] - byDept[a]; });
    var deptMax = byDept[deptRows[0]] || 1;

    var body = '<div class="hr-tablewrap"><table class="hr-table">' +
      '<thead><tr><th>Name</th><th>Department</th><th>Contract</th><th class="hr-num">Monthly</th><th class="hr-num">Annual</th></tr></thead><tbody>' +
      team.map(function (e) {
        return '<tr>' +
          '<td><span class="hr-person">' + av(e, 34) +
            '<span><span class="hr-person-name">' + esc(e.name) + '</span>' +
            '<span class="hr-person-sub">' + esc(e.role) + '</span></span></span></td>' +
          '<td>' + esc(e.dept) + '</td><td>' + esc(e.type) + '</td>' +
          '<td class="hr-num">' + U.money(e.pay) + '</td>' +
          '<td class="hr-num">' + U.money(e.pay * 12) + '</td></tr>';
      }).join('') +
      '<tr><td colspan="3" style="font-weight:500">Total</td>' +
      '<td class="hr-num" style="font-weight:500">' + U.money(total) + '</td>' +
      '<td class="hr-num" style="font-weight:500">' + U.money(total * 12) + '</td></tr>' +
      '</tbody></table></div>';

    var deptCard = '<h2 class="hr-card-title" style="margin:0 0 16px">Cost by department</h2>' +
      deptRows.map(function (d) {
        return '<div style="display:flex;align-items:center;gap:14px;padding:8px 0">' +
          '<span style="width:104px;font-size:14px">' + esc(d) + '</span>' +
          '<span class="hr-meter" style="flex:1"><span style="width:' + Math.round((byDept[d] / deptMax) * 100) + '%"></span></span>' +
          '<span style="font-size:14px;font-variant-numeric:tabular-nums;width:76px;text-align:right">' + U.money(byDept[d]) + '</span>' +
          '</div>';
      }).join('');

    var salSub = global.__pplOdooLive
      ? (st._liveHasPay ? 'Live from Odoo (hr.contract wage)' : 'Live headcount from Odoo — wage needs Payroll access for this API user, so pay shows as \u2014')
      : 'Payroll for the tracked directory';
    byId('view-salary').innerHTML =
      head('Salary', salSub,
        '<button class="hr-btn hr-btn--quiet" id="salExport">' + I.svg('download') + 'Export</button>') +
      '<div class="hr-tiles">' +
        tile('Monthly payroll', U.money(total), U.money(total * 12) + ' annualised') +
        tile('Median', U.money(median), 'monthly, all contracts') +
        tile('Average', U.money(Math.round(total / team.length)), 'monthly, all contracts') +
        tile('Headcount', String(team.length), 'in the directory') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1.6fr 1fr;gap:16px;align-items:start" class="hr-salgrid">' +
      card(body) + card(deptCard) + '</div>';

    on(byId('salExport'), 'click', function () {
      downloadCSV('payroll.csv', [['Name', 'Role', 'Department', 'Contract', 'Monthly', 'Annual']]
        .concat(team.map(function (e) { return [e.name, e.role, e.dept, e.type, e.pay, e.pay * 12]; })));
    });
  }

  /* ══ Calendar (month view) ═════════════════════════════════════════════ */
  function renderCalendar() {
    var base = ui.calMonth ? new Date(ui.calMonth) : new Date();
    base.setDate(1);
    var y = base.getFullYear(), m = base.getMonth();
    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;            // Monday-first
    var days = new Date(y, m + 1, 0).getDate();
    var todayKey = U.isoDay(new Date());

    var cells = [];
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push(new Date(y, m, d));
    while (cells.length % 7) cells.push(null);

    var grid = '<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px">' +
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) {
        return '<div style="font-size:13px;color:var(--ink-45);padding-bottom:4px">' + d + '</div>';
      }).join('') +
      cells.map(function (dt) {
        if (!dt) return '<div></div>';
        var key = U.isoDay(dt);
        var evs = S.eventsOn(key);
        var isToday = key === todayKey;
        return '<div style="min-height:96px;border-radius:16px;padding:9px;' +
          'background:' + (isToday ? 'var(--butter-15)' : 'rgba(255,255,255,.44)') + ';' +
          'border:1px solid ' + (isToday ? 'var(--butter)' : 'var(--card-line)') + '">' +
          '<div style="font-size:13px;font-variant-numeric:tabular-nums;' +
            (isToday ? 'font-weight:600' : 'color:var(--ink-45)') + '">' + dt.getDate() + '</div>' +
          evs.slice(0, 3).map(function (ev) {
            return '<div style="margin-top:5px;font-size:11.5px;padding:4px 8px;border-radius:9px;' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
              (ev.tone === 'ink' ? 'background:var(--ink);color:#FBFAF6'
                : ev.tone === 'butter' ? 'background:var(--butter)'
                : 'background:#FFFDF7;border:1px solid var(--card-line)') + '">' +
              esc(ev.start) + ' ' + esc(ev.title) + '</div>';
          }).join('') +
          (evs.length > 3 ? '<div style="font-size:11px;color:var(--ink-45);margin-top:4px">+' + (evs.length - 3) + ' more</div>' : '') +
          '</div>';
      }).join('') + '</div>';

    var monthEvents = S.get().events.filter(function (e) {
      return e.date.slice(0, 7) === y + '-' + String(m + 1).padStart(2, '0');
    });

    byId('view-calendar').innerHTML =
      head(first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        monthEvents.length + ' event' + (monthEvents.length === 1 ? '' : 's') + ' this month',
        '<button class="hr-btn hr-btn--quiet" id="calPrev">Previous</button>' +
        '<button class="hr-btn hr-btn--quiet" id="calToday">Today</button>' +
        '<button class="hr-btn hr-btn--quiet" id="calNext">Next</button>') +
      card(grid);

    on(byId('calPrev'), 'click', function () { ui.calMonth = new Date(y, m - 1, 1).toISOString(); renderCalendar(); });
    on(byId('calNext'), 'click', function () { ui.calMonth = new Date(y, m + 1, 1).toISOString(); renderCalendar(); });
    on(byId('calToday'), 'click', function () { ui.calMonth = null; renderCalendar(); });
  }

  /* ══ Reviews ═══════════════════════════════════════════════════════════ */
  function renderReviews() {
    var st = S.get();
    var done = st.reviews.filter(function (r) { return r.state === 'Complete'; });
    var avg = done.length ? (done.reduce(function (a, r) { return a + r.score; }, 0) / done.length) : 0;

    var body = '<div class="hr-tablewrap"><table class="hr-table">' +
      '<thead><tr><th>Employee</th><th>Reviewer</th><th>Cycle</th><th>Status</th><th class="hr-num">Score</th></tr></thead><tbody>' +
      st.reviews.map(function (r) {
        var who = S.employee(r.who), by = S.employee(r.reviewer);
        if (!who) return '';
        var tag = r.state === 'Complete' ? 'hr-tag--ok' : r.state === 'In progress' ? 'hr-tag--warn' : '';
        return '<tr>' +
          '<td><span class="hr-person">' + av(who, 34) +
            '<span><span class="hr-person-name">' + esc(who.name) + '</span>' +
            '<span class="hr-person-sub">' + esc(who.role) + '</span></span></span></td>' +
          '<td>' + esc(by ? by.name : '—') + '</td>' +
          '<td>' + esc(r.cycle) + '</td>' +
          '<td><span class="hr-tag ' + tag + '">' + esc(r.state) + '</span></td>' +
          '<td class="hr-num">' + (r.score ? r.score.toFixed(1) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    byId('view-reviews').innerHTML =
      head('Reviews', 'H1 2026 performance cycle · tracked in this workspace (not from Odoo)') +
      '<div class="hr-tiles">' +
        tile('In cycle', String(st.reviews.length), 'reviews scheduled') +
        tile('Complete', String(done.length), st.reviews.length - done.length + ' still open') +
        tile('Average score', avg ? avg.toFixed(2) : '—', 'out of 5.0') +
        tile('Closes', '30 Sep', 'reminders go out Friday') +
      '</div>' + card(body);
  }

  /* ══ Settings ══════════════════════════════════════════════════════════ */
  function renderSettings() {
    var st = S.get();

    var capRows = st.capacity.map(function (c) {
      return '<div class="hr-cap-row">' +
        '<span class="hr-cap-label">' + esc(c.label) + '</span>' +
        '<input type="range" min="0" max="100" value="' + c.pct + '" data-cap="' + c.id + '" class="hr-cap-range" aria-label="' + esc(c.label) + ' percentage"/>' +
        '<span class="hr-cap-val" data-capval="' + c.id + '">' + c.pct + '%</span>' +
        '</div>';
    }).join('');

    byId('view-settings').innerHTML =
      head('Settings', 'Everything here saves to this browser') +
      '<div class="hr-salgrid hr-settings-grid">' +
      card(
        '<div class="hr-settings-head"><span class="hr-settings-icon">' + I.svg('box') + '</span>' +
        '<div><h2 class="hr-card-title">Workspace</h2><p class="hr-viewsub">How your org shows up across the app</p></div></div>' +
        '<div class="hr-form">' +
          '<div><label class="hr-label" for="setOrg">Organisation name</label>' +
          '<input class="hr-field" id="setOrg" value="' + esc(st.profile.org) + '"/></div>' +
          '<div><label class="hr-label" for="setWs">Greeting name</label>' +
          '<input class="hr-field" id="setWs" value="' + esc(st.profile.workspace) + '"/></div>' +
          '<div><label class="hr-label" for="setGoal">Working-day target (hours)</label>' +
          '<input class="hr-field" id="setGoal" type="number" min="1" max="16" step="0.5" value="' + st.profile.dayGoalHours + '"/></div>' +
        '</div>' +
        '<div class="hr-settings-actions"><button class="hr-btn" id="setSave">' + I.svg('check') + 'Save changes</button></div>'
      ) +
      card(
        '<div class="hr-settings-head"><span class="hr-settings-icon">' + I.svg('clock') + '</span>' +
        '<div><h2 class="hr-card-title">Capacity split</h2><p class="hr-viewsub">Sets the bar under the welcome line</p></div></div>' +
        capRows +
        '<div class="hr-cap-sum" id="capSum"></div>'
      ) +
      card(
        '<div class="hr-settings-head"><span class="hr-settings-icon hr-settings-icon--danger">' + I.svg('folder') + '</span>' +
        '<div><h2 class="hr-card-title">Data</h2><p class="hr-viewsub">The directory lives only in this browser</p></div></div>' +
        '<p class="hr-settings-note">Export keeps a CSV backup you can reopen elsewhere. Resetting clears every change made here — hires, edits, salary and device assignments — and restores the sample directory.</p>' +
        '<div class="hr-settings-actions">' +
          '<button class="hr-btn hr-btn--quiet" id="setExport">' + I.svg('download') + 'Export directory (CSV)</button>' +
          '<button class="hr-btn hr-btn--quiet hr-btn--danger" id="setReset">' + I.svg('trash') + 'Reset workspace</button>' +
        '</div>'
      ) +
      '</div>';

    function sumCaps() {
      var total = S.get().capacity.reduce(function (a, c) { return a + c.pct; }, 0);
      byId('capSum').textContent = total === 100
        ? 'Adds up to 100%.'
        : 'Adds up to ' + total + '% — the bar scales proportionally either way.';
    }
    sumCaps();

    on(byId('setSave'), 'click', function () {
      var goal = parseFloat(byId('setGoal').value);
      S.update('profile', function (s) {
        s.profile.org = byId('setOrg').value.trim() || 'Crextio';
        s.profile.workspace = byId('setWs').value.trim() || 'Nixtio';
        s.profile.dayGoalHours = (goal > 0 && goal <= 16) ? goal : 8;
      });
      toast('Settings saved');
    });
    on(byId('setExport'), 'click', function () {
      var team = S.get().team;
      downloadCSV('people.csv', [['Name', 'Role', 'Department', 'Contract', 'Status', 'Monthly', 'Started', 'Email']]
        .concat(team.map(function (e) { return [e.name, e.role, e.dept, e.type, e.status, e.pay, e.start, e.email]; })));
      toast('Directory exported');
    });
    on(byId('setReset'), 'click', function () {
      if (confirm('Reset every change back to the seeded workspace?')) { S.reset(); toast('Workspace reset'); }
    });

    byId('view-settings').querySelectorAll('[data-cap]').forEach(function (r) {
      on(r, 'input', function () {
        byId('view-settings').querySelector('[data-capval="' + r.dataset.cap + '"]').textContent = r.value + '%';
      });
      on(r, 'change', function () {
        S.update('capacity', function (s) {
          var c = s.capacity.filter(function (x) { return x.id === r.dataset.cap; })[0];
          if (c) c.pct = +r.value;
        });
        sumCaps();
      });
    });
  }

  /* ══ Dispatch ══════════════════════════════════════════════════════════ */
  var RENDER = {
    people: renderPeople, hiring: renderHiring, devices: renderDevices,
    apps: renderApps, salary: renderSalary, calendar: renderCalendar,
    reviews: renderReviews, settings: renderSettings
  };

  global.HRViews = {
    render: function (name) { if (RENDER[name]) RENDER[name](); },
    ui: ui
  };

  /* Keep an open secondary view live when the store changes underneath it. */
  S.subscribe(function (state, reason) {
    var active = document.querySelector('.hr-view:not([hidden])');
    if (!active) return;
    var name = active.id.replace('view-', '');
    if (name === 'dashboard') return;
    if (reason === 'timer') return;               // the timer doesn't affect these
    if (RENDER[name]) RENDER[name]();
  });
})(window);
