/* ==========================================================================
   DashView Pro — Team, Reports and Settings wiring for the workspace shell.
   (Overview, Odoo Live, Audit log and Task assignments now live in their own
   modules: overview-live.js, odoo-live.js, audit-live.js, tasks.js.)
   ========================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var byId = function (id) { return document.getElementById(id); };
    var toast = function (msg) { if (window.showToast) window.showToast(msg); };
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var can = function (perm) { return window.DVAuth ? window.DVAuth.can(perm) : true; };

    var state = { role: 'admin' };

    var AVATAR_COLORS = ['#e8a33d', '#5b8fae', '#4fb477', '#f0c06a', '#e5654f', '#c76b3c', '#4a8c86', '#9a9552', '#8b5cf6'];
    function initials(name) { return name.split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }
    function hashColor(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }

    /* ── Team ─────────────────────────────────────────────────────────────────
       Same treatment as Projects: persisted to localStorage (dv_team), real
       CRUD instead of a demo toast, and matching import/export. */
    var TEAM_KEY = 'dv_team';
    function saveTeam(list) { try { localStorage.setItem(TEAM_KEY, JSON.stringify(list)); } catch (e) { toast('Could not save — local storage may be full.'); } }
    function seedTeam() {
      var seed = [
        { name: 'Amara Khan', role: 'Founder & Admin', status: 'online', projects: 8, email: '' },
        { name: 'Daniyal Raza', role: 'Engineering Lead', status: 'online', projects: 5, email: '' },
        { name: 'Sara Ahmed', role: 'Product Manager', status: 'away', projects: 4, email: '' },
        { name: 'Bilal Hussain', role: 'DevOps Engineer', status: 'online', projects: 3, email: '' },
        { name: 'Zara Farooq', role: 'UI/UX Designer', status: 'offline', projects: 2, email: '' },
        { name: 'Hamza Tariq', role: 'Data Engineer', status: 'online', projects: 3, email: '' },
        { name: 'Mahnoor Iqbal', role: 'QA Engineer', status: 'away', projects: 4, email: '' },
        { name: 'Omer Sheikh', role: 'Customer Success', status: 'online', projects: 1, email: '' }
      ];
      seed.forEach(function (m, i) { m.id = 't_' + i + '_' + Date.now().toString(36); });
      saveTeam(seed);
      return seed;
    }
    function loadTeam() {
      try { var raw = JSON.parse(localStorage.getItem(TEAM_KEY)); if (raw && raw.length) return raw; } catch (e) {}
      return seedTeam();
    }
    var TEAM = loadTeam();
    var editingTeamId = null;

    function renderTeam() {
      var canEdit = can('manageTeam');
      byId('teamGrid').innerHTML = TEAM.map(function (m) {
        return '<div class="team-card">'
          + '<div class="team-avatar-wrap"><div class="team-avatar" style="background:' + hashColor(m.name) + '">' + initials(m.name) + '</div><span class="team-status-dot ' + m.status + '"></span></div>'
          + '<div style="flex:1;min-width:0;"><p class="team-card-name">' + esc(m.name) + '</p><p class="team-card-role">' + esc(m.role) + '</p><p class="team-card-meta">' + m.projects + ' project' + (m.projects === 1 ? '' : 's') + '</p></div>'
          + (canEdit ? '<span class="project-card-actions"><button type="button" class="dv-widget-icon-btn" data-edit-team="' + m.id + '" title="Edit" aria-label="Edit team member"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button><button type="button" class="dv-widget-icon-btn danger" data-delete-team="' + m.id + '" title="Remove" aria-label="Remove team member"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></span>' : '')
          + '</div>';
      }).join('');
      if (byId('teamSubhead')) byId('teamSubhead').textContent = TEAM.length + ' member' + (TEAM.length === 1 ? '' : 's') + ' in acme-corp';
      byId('teamGrid').querySelectorAll('[data-edit-team]').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); openTeamModal(TEAM.filter(function (m) { return m.id === b.getAttribute('data-edit-team'); })[0]); });
      });
      byId('teamGrid').querySelectorAll('[data-delete-team]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var m = TEAM.filter(function (x) { return x.id === b.getAttribute('data-delete-team'); })[0];
          if (!m || !confirm('Remove "' + m.name + '" from the team?')) return;
          TEAM = TEAM.filter(function (x) { return x.id !== m.id; });
          saveTeam(TEAM);
          renderTeam();
          toast('Team member removed.');
        });
      });
    }
    renderTeam();

    function openTeamModal(member) {
      if (!can('manageTeam')) { toast('You do not have permission to manage the team.'); return; }
      editingTeamId = member ? member.id : null;
      byId('teamModalTitle').textContent = member ? 'Edit member' : 'Invite a member';
      byId('teamNameInput').value = member ? member.name : '';
      byId('teamRoleInput').value = member ? member.role : '';
      byId('teamStatusSelect').value = member ? member.status : 'online';
      byId('teamProjectsInput').value = member ? member.projects : 0;
      byId('teamEmailInput').value = member && member.email ? member.email : '';
      byId('teamModal').classList.add('open');
    }
    function closeTeamModal() { byId('teamModal').classList.remove('open'); }
    function saveTeamFromModal() {
      var name = byId('teamNameInput').value.trim();
      if (!name) { toast('Give the member a name.'); return; }
      var fields = {
        name: name, role: byId('teamRoleInput').value.trim() || 'Team member',
        status: byId('teamStatusSelect').value,
        projects: Math.max(0, parseInt(byId('teamProjectsInput').value, 10) || 0),
        email: byId('teamEmailInput').value.trim()
      };
      if (editingTeamId) {
        var idx = TEAM.findIndex(function (m) { return m.id === editingTeamId; });
        if (idx > -1) Object.keys(fields).forEach(function (k) { TEAM[idx][k] = fields[k]; });
      } else {
        fields.id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        TEAM.push(fields);
      }
      saveTeam(TEAM);
      closeTeamModal();
      renderTeam();
      toast(editingTeamId ? 'Member updated.' : 'Member added.');
    }
    if (byId('inviteTeamBtn')) byId('inviteTeamBtn').addEventListener('click', function () { openTeamModal(null); });
    if (byId('teamSaveBtn')) byId('teamSaveBtn').addEventListener('click', saveTeamFromModal);
    if (byId('teamModalClose')) byId('teamModalClose').addEventListener('click', closeTeamModal);
    if (byId('teamModal')) byId('teamModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeTeamModal(); });

    /* Import / export */
    function exportTeamJSON() {
      var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), team: TEAM }, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'dashview-team-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      URL.revokeObjectURL(url);
      toast('Team exported.');
    }
    function importTeamJSON(file) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var list = parsed.team || parsed;
          if (!Array.isArray(list)) throw new Error('bad shape');
          list.forEach(function (m) { if (!m.id) m.id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); });
          TEAM = list;
          saveTeam(TEAM);
          renderTeam();
          toast('Imported ' + list.length + ' team members.');
        } catch (e) { toast('That file is not a valid team export.'); }
      };
      reader.readAsText(file);
    }
    function exportPeopleCSV(filename) {
      var team = (window.PeopleStore && window.PeopleStore.get().team) || [];
      var candidates = (window.PeopleStore && window.PeopleStore.get().candidates) || [];
      if (!team.length) { toast('No one in the People directory yet — connect Odoo or add people first.'); return; }
      var F = window.DVFmt;
      var rows = [['Directory']]
        .concat([['Name', 'Role', 'Department', 'Contract', 'Status', 'Monthly pay', 'Started', 'Email']])
        .concat(team.map(function (e) { return [e.name, e.role, e.dept, e.type, e.status, e.pay, e.start, e.email]; }))
        .concat([[]], [['Hiring pipeline']], [['Name', 'Role', 'Stage', 'Source', 'Days in pipeline']])
        .concat(candidates.map(function (c) { return [c.name, c.role, c.stage, c.source, c.days]; }));
      if (F) F.download(filename, F.csv(rows));
      else {
        var csv = rows.map(function (r) { return r.map(function (c) { var v = String(c == null ? '' : c); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
        var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
      }
      toast('People directory report exported.');
      if (window.DVSec) window.DVSec.log('Exported report', 'People Directory Report');
    }
    function exportXLSX(filename, sheetName) {
      if (!window.XLSX) { toast('Excel export library did not load.'); return; }
      var orders = (window.DASHVIEW_OV && window.DASHVIEW_OV.ORDERS) || [];
      if (!orders.length) { toast('Connect Odoo first — nothing to export yet.'); return; }
      var ws = XLSX.utils.json_to_sheet(orders.map(function (o) {
        return { Order: o.id, Customer: o.customer, Status: o.state, Revenue: o.revenue, Date: o.date };
      }));
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Orders').slice(0, 31));
      XLSX.writeFile(wb, filename || 'dashview-orders.xlsx');
    }
    function exportTeamXLSX() {
      if (!window.XLSX) { toast('Excel export library did not load.'); return; }
      var ws = XLSX.utils.json_to_sheet(TEAM.map(function (m) {
        return { Name: m.name, Role: m.role, Status: m.status, Projects: m.projects, Email: m.email || '' };
      }));
      ws['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 26 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Team');
      XLSX.writeFile(wb, 'dashview-team-' + new Date().toISOString().slice(0, 10) + '.xlsx');
      toast('Excel workbook exported.');
    }
    function exportTeamPDF() {
      if (!window.DVReportEngine) { toast('Report engine did not load.'); return; }
      toast('Building PDF report…');
      window.DVReportEngine.generatePdfReport({
        title: 'Team Report',
        workbookName: 'DashView Team',
        sourceFileName: 'DashView workspace',
        generatedAt: new Date(),
        filteredRows: TEAM.length, totalRows: TEAM.length,
        filtersSummary: [],
        includeKpis: true,
        kpis: [
          { label: 'Team size', value: String(TEAM.length) },
          { label: 'Online now', value: String(TEAM.filter(function (m) { return m.status === 'online'; }).length) },
          { label: 'Total projects staffed', value: String(TEAM.reduce(function (s, m) { return s + (m.projects || 0); }, 0)) }
        ],
        includeCharts: false,
        includeData: true,
        fields: [{ name: 'name', type: 'string' }, { name: 'role', type: 'string' }, { name: 'status', type: 'string' }, { name: 'projects', type: 'number' }, { name: 'email', type: 'string' }],
        rows: TEAM.map(function (m) { return { name: m.name, role: m.role, status: m.status, projects: m.projects, email: m.email || '—' }; }),
        formatCell: function (v) { return String(v == null ? '' : v); },
        includePivot: false
      }).then(function () { toast('PDF report downloaded.'); }).catch(function () { toast('Could not build the PDF report.'); });
    }
    if (byId('teamImportBtn')) byId('teamImportBtn').addEventListener('click', function () {
      if (!can('importExport')) { toast('You do not have permission to import.'); return; }
      byId('teamImportFile').click();
    });
    if (byId('teamImportFile')) byId('teamImportFile').addEventListener('change', function (e) { if (e.target.files[0]) importTeamJSON(e.target.files[0]); e.target.value = ''; });
    if (byId('teamExportBtn') && byId('teamExportMenu')) {
      byId('teamExportBtn').addEventListener('click', function (e) { e.stopPropagation(); byId('teamExportMenu').classList.toggle('open'); });
      document.addEventListener('click', function (e) { if (!byId('teamExportMenu').contains(e.target) && e.target !== byId('teamExportBtn') && !byId('teamExportBtn').contains(e.target)) byId('teamExportMenu').classList.remove('open'); });
      byId('teamExportMenu').addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-export]') : null;
        if (!btn) return;
        if (!can('importExport')) { toast('You do not have permission to export.'); return; }
        byId('teamExportMenu').classList.remove('open');
        var type = btn.getAttribute('data-export');
        if (type === 'json') exportTeamJSON();
        else if (type === 'xlsx') exportTeamXLSX();
        else if (type === 'pdf') exportTeamPDF();
      });
    }

    /* ── Reports ──────────────────────────────────────────────────────────── */
    var REPORTS = [
      { title: 'Sales Overview Report', desc: 'Revenue, orders and recent activity from your connected Odoo.', fmt: 'CSV', generated: 'Live', action: 'csv', src: 'overview' },
      { title: 'People Directory Report', desc: 'Headcount, department, contract type and hiring pipeline — live from Odoo once People is connected.', fmt: 'CSV', generated: 'Live', action: 'csv', src: 'people' },
      { title: 'Task Completion Report', desc: 'Every assigned task, its owner, status and due date.', fmt: 'CSV', generated: 'Live', action: 'csv', src: 'tasks' },
      { title: 'Recent Orders Workbook', desc: 'The latest confirmed sales orders as an Excel file.', fmt: 'XLSX', generated: 'Live', action: 'xlsx' },
      { title: 'Monthly Sales Summary', desc: 'Full PDF — KPIs, charts and an AI-written narrative, built from live Odoo data.', fmt: 'PDF', generated: 'Live', action: 'pdf-overview' },
      { title: 'Finance P&L Statement', desc: 'Print or save the current tab as a PDF.', fmt: 'PDF', generated: 'On demand', action: 'pdf' },
      { title: 'Marketing Campaign ROI', desc: 'Print or save the current tab as a PDF.', fmt: 'PDF', generated: 'On demand', action: 'pdf' }
    ];
    var FMT_COLOR = { PDF: '#e5654f', XLSX: '#4fb477', CSV: '#5b8fae' };
    byId('reportsGrid').innerHTML = REPORTS.map(function (r) {
      return '<div class="report-card">'
        + '<div class="report-card-icon" style="background:' + FMT_COLOR[r.fmt] + '22;color:' + FMT_COLOR[r.fmt] + '">' + r.fmt + '</div>'
        + '<p class="report-card-title">' + r.title + '</p><p class="report-card-desc">' + r.desc + '</p>'
        + '<p class="report-card-meta">' + r.generated + '</p>'
        + '<div class="report-card-actions"><button class="btn btn-outline btn-sm" data-run="' + r.action + '" data-title="' + r.title + '" data-src="' + (r.src || '') + '">Generate now</button></div>'
        + '</div>';
    }).join('');
    function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
    byId('reportsGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-run]'); if (!btn) return;
      var type = btn.dataset.run;
      var title = btn.dataset.title || 'Report';
      var src = btn.dataset.src;
      // Item #3: Excel export is Admin/Manager-only, same restriction as the export menu.
      if (type === 'xlsx' && state.role === 'rep') { toast('Excel export is restricted for the Sales Rep view.'); return; }
      // Each report card names the report it's actually producing — both in the
      // toast and in the downloaded file. CSV/XLSX cards read live data (the Odoo
      // overview snapshot or the Task assignments store); PDF cards open the
      // browser print dialog so the person can print or "Save as PDF" the tab.
      var slug = 'dashview-' + slugify(title) + '-' + new Date().toISOString().slice(0, 10);
      if (type === 'csv') {
        toast('Preparing "' + title + '"…');
        setTimeout(function () {
          if (src === 'tasks' && window.__tasksExportCSV) window.__tasksExportCSV(slug + '.csv');
          else if (src === 'people') exportPeopleCSV(slug + '.csv');
          else if (window.__overviewExportCSV) window.__overviewExportCSV(slug + '.csv');
          else toast('This report needs Odoo connected — open Settings to connect it.');
        }, 300);
      } else if (type === 'xlsx') {
        toast('Preparing "' + title + '"…');
        setTimeout(function () { exportXLSX(slug + '.xlsx', title); }, 300);
      } else if (type === 'pdf-overview') {
        if (window.__overviewExportPDF) { window.__overviewExportPDF(); }
        else toast('Open the Overview tab once first, then generate this report.');
      } else if (type === 'pdf') {
        toast('Opening the print dialog for "' + title + '"…');
        setTimeout(function () { window.print(); }, 300);
      }
    });
    if (byId('newReportBtn')) byId('newReportBtn').addEventListener('click', function () { toast('Custom report builder is a demo action — use Data Studio to build one from scratch.'); });

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
      var redact = !window.DVSec || window.DVSec.getConf().redact !== false;
      if (redact && window.DVSec) dump = window.DVSec.redactBackup(dump);
      if (window.DVSec) window.DVSec.log('Backup exported', redact ? 'Secrets excluded' : 'Includes secrets — store this file safely', redact ? 'ok' : 'review');
      var blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: dump }, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'dashview-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      URL.revokeObjectURL(url);
      toast(redact ? 'Backup exported (API keys and tokens excluded).' : 'Backup exported — it contains secrets, keep it somewhere safe.');
    });
    if (byId('importBackupBtn')) byId('importBackupBtn').addEventListener('click', function () { byId('importBackupFile').click(); });
    if (byId('importBackupFile')) byId('importBackupFile').addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var data = parsed.data || parsed;
          Object.keys(data).forEach(function (k) { if (k === 'dv_sec' || k === 'dv_sec_log') return; localStorage.setItem(k, data[k]); });
          if (window.DVSec) window.DVSec.log('Backup imported', file.name, 'review');
          toast('Backup restored — reloading…');
          setTimeout(function () { location.reload(); }, 700);
        } catch (err) { toast('That file could not be read as a DashView backup.'); }
      };
      reader.readAsText(file);
    });
    if (byId('clearLocalBtn')) byId('clearLocalBtn').addEventListener('click', function () {
      if (!confirm('Clear all locally saved DashView data (workbooks, chat history, preferences)? This cannot be undone unless you have a backup file.')) return;
      if (window.DVSec) window.DVSec.log('All local data cleared', '', 'review');
      localStorage.clear();
      toast('Local data cleared — reloading…');
      setTimeout(function () { location.reload(); }, 600);
    });

    // Odoo integration — connect/test wiring, the mock RPC client, and the
    // "Odoo Data" browser view now live in js/odoo-service.js (window.DVOdoo),
    // so this block just leaves ODOO_KEY declared above for any legacy reads.

    // AI Assistant provider/key status is now handled by js/ai-settings-ui.js
    // (Settings → AI Assistant), which supports Grok and Claude via
    // window.DVAIConfig instead of just the legacy static-file key.
  });
})();
