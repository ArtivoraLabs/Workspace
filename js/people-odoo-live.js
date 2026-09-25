/* ==========================================================================
   DashView People — live Odoo sync
   --------------------------------------------------------------------------
   Replaces the seeded People/Hiring data with real records the moment Odoo
   is connected (same dashview_odoo_config / Worker proxy the rest of
   DashView uses — nothing new to configure on this page).

     Team directory  → hr.employee (+ hr.department, hr.job, best-effort hr.contract for pay)
     Hiring pipeline → hr.applicant, mapped onto the existing 5-stage board
     Header "Projects" stat → project.project (best-effort, Project app may not be installed)

   Read-only by design: the Worker proxy only exposes records/read-group, so
   nothing here ever writes back to Odoo. Devices, Apps and Reviews stay
   workspace-managed (Odoo has no standard model for them) and keep working
   exactly as before, seed data included, whether or not Odoo is connected.

   If Odoo is not connected, or a fetch fails, the page quietly falls back to
   (or keeps) its local seeded workspace — this file never blanks the screen.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.PeopleStore || !window.DVOdooClient) return;

  var S = window.PeopleStore, C = window.DVOdooClient;
  var seq = 0, pollTimer = null;

  /* Soft pastel pairs for avatar gradients — same feel as the seeded team. */
  var TONES = [
    ['#F3D15F', '#E0A93B'], ['#D8E2C8', '#94A87C'], ['#CFDCE8', '#7C9AB4'], ['#EFD3C4', '#C98B6B'],
    ['#DCD2E8', '#9682B4'], ['#F6E3A8', '#D9B44A'], ['#C9DED6', '#7BA697'], ['#EDD6DC', '#C08795'],
    ['#D5D9E3', '#8791A6'], ['#F1DCC0', '#C79D68'], ['#CBD9DD', '#7F9CA4'], ['#E4DCC9', '#A79A7C']
  ];
  function tone(id) { return TONES[Math.abs(+id || 0) % TONES.length]; }
  function label(v, none) { return Array.isArray(v) ? (v[1] || none || '—') : (v === false || v == null ? (none || '—') : String(v)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function daysBetween(iso) {
    if (!iso) return 0;
    var d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 864e5));
  }
  function friendly(e) {
    var m = (e && e.message) || 'Could not reach Odoo';
    if (/doesn.t exist|does not exist/i.test(m)) return 'That Odoo app is not installed';
    if (/access|not allowed|forbidden/i.test(m)) return 'The connected Odoo user has no access to this data';
    return m;
  }

  /* ── Status pill + connect banner (mirrors Overview / Audit log) ───────── */
  function byId(id) { return document.getElementById(id); }
  function setStatus(mode, text) {
    var p = byId('pplOdooStatus'); if (!p) return;
    p.classList.remove('is-live', 'is-error');
    if (mode === 'live') p.classList.add('is-live'); if (mode === 'error') p.classList.add('is-error');
    var t = byId('pplOdooStatusText'); if (t) t.textContent = text;
  }
  function showBanner(text) {
    var b = byId('pplOdooBanner'); if (!b) return;
    b.hidden = false;
    var t = byId('pplOdooBannerText'); if (t) t.innerHTML = text;
  }
  function hideBanner() { var b = byId('pplOdooBanner'); if (b) b.hidden = true; }

  /* ── Stage mapping: Odoo recruitment pipelines vary by install, so match
     the 5 board columns by keyword rather than assuming exact stage names. */
  function mapStage(name) {
    var n = String(name || '').toLowerCase();
    if (/hire|contract sign|signed/.test(n)) return 'Hired';
    if (/offer|proposal/.test(n)) return 'Offer';
    if (/2nd|second|interview/.test(n)) return 'Interview';
    if (/screen|qualif|1st|first/.test(n)) return 'Screening';
    return 'Applied';
  }
  function mapType(t) {
    return { employee: 'Full-time', student: 'Part-time', trainee: 'Contract', contractor: 'Contract', freelance: 'Freelance' }[t] || 'Full-time';
  }

  /* ── Loaders (each best-effort; a failure degrades gracefully) ──────────── */
  function loadEmployees() {
    return C.records('hr.employee', {
      domain: [], order: 'name asc', limit: 400,
      fields: ['name', 'work_email', 'department_id', 'job_id', 'employee_type', 'active', 'create_date']
    }).then(function (r) {
      return (r.rows || []).map(function (e) {
        return {
          id: 'o' + e.id, _odooId: e.id, name: e.name || '—',
          role: label(e.job_id, 'Employee'), dept: label(e.department_id, 'Unassigned'),
          pay: 0, type: mapType(e.employee_type), status: e.active === false ? 'Offboarded' : 'Active',
          start: String(e.create_date || '').slice(0, 10), email: e.work_email || '',
          tone: tone(e.id)
        };
      });
    });
  }
  /* hr.contract wage sits behind Payroll access in most Odoo installs — try
     it, but the directory still works fine (pay shows as —) if it 404s. */
  function loadPay(employees) {
    if (!employees.length) return Promise.resolve({});
    return C.records('hr.contract', {
      domain: [['employee_id', 'in', employees.map(function (e) { return e._odooId; })], ['state', '=', 'open']],
      fields: ['employee_id', 'wage'], limit: 500
    }).then(function (r) {
      var map = {};
      (r.rows || []).forEach(function (c) {
        var id = Array.isArray(c.employee_id) ? c.employee_id[0] : c.employee_id;
        if (id != null) map[id] = Number(c.wage) || 0;
      });
      return map;
    }).catch(function () { return {}; });
  }
  function loadCandidates() {
    return C.records('hr.applicant', {
      domain: [], order: 'create_date desc', limit: 300,
      fields: ['partner_name', 'job_id', 'stage_id', 'source_id', 'create_date']
    }).then(function (r) {
      return (r.rows || []).map(function (c) {
        return {
          id: 'oc' + c.id, name: c.partner_name || label(c.job_id, 'Candidate') + ' applicant',
          role: label(c.job_id, '—'), stage: mapStage(label(c.stage_id)),
          source: label(c.source_id, 'Direct'), days: daysBetween(c.create_date)
        };
      });
    });
  }
  function loadProjectCount() {
    return C.count('project.project', []).catch(function () { return null; });
  }

  /* ── Sync ─────────────────────────────────────────────────────────────── */
  function sync(isPoll) {
    var st = C.state();
    if (st !== 'ok') {
      window.__pplOdooLive = false;
      setStatus(st === 'none' ? 'idle' : 'error', st === 'locked' ? 'Locked' : 'Not connected');
      if (!isPoll) showBanner('<strong>' + (st === 'locked' ? 'Workspace locked.' : 'Connect Odoo to load your real headcount and hiring pipeline.') + '</strong> ' + esc(C.message(st)));
      return;
    }
    var my = ++seq;
    if (!isPoll) setStatus('connecting', 'Syncing…');
    var employeesP = loadEmployees();
    Promise.all([
      employeesP,
      employeesP.then(loadPay),
      loadCandidates(),
      loadProjectCount()
    ]).then(function (r) {
      if (my !== seq) return;
      var employees = r[0], payMap = r[1], candidates = r[2], projectCount = r[3];
      employees.forEach(function (e) { if (payMap[e._odooId] != null) e.pay = payMap[e._odooId]; });

      S.update('odoo-sync', function (s) {
        s.team = employees;
        s.candidates = candidates.length ? candidates : s.candidates;
        s._liveProjectCount = projectCount;
        s._liveHasPay = Object.keys(payMap).length > 0;
        if (!employees.some(function (e) { return e.id === s.spotlightId; })) {
          s.spotlightId = employees[0] ? employees[0].id : s.spotlightId;
        }
      });

      window.__pplOdooLive = true;
      hideBanner();
      setStatus('live', 'Live — ' + employees.length + ' employee' + (employees.length === 1 ? '' : 's') + ' · ' + (odooHost() || 'Odoo'));
      if (window.DVSec && !isPoll) window.DVSec.log('People synced from Odoo', employees.length + ' employees, ' + candidates.length + ' candidates');
    }).catch(function (err) {
      if (my !== seq) return;
      window.__pplOdooLive = false;
      setStatus('error', friendly(err));
      if (!isPoll) showBanner('<strong>Could not load People from Odoo.</strong> ' + esc(friendly(err)));
    });
  }
  function odooHost() { try { return new URL(C.cfg().url).host; } catch (e) { return ''; } }

  function start() {
    sync(false);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { if (!document.hidden && C.state() === 'ok') sync(true); }, 60000);
  }

  ['dv:odoo-config-saved', 'dv:unlocked'].forEach(function (ev) { document.addEventListener(ev, function () { C.reset(); start(); }); });
  document.addEventListener('dv:locked', function () { window.__pplOdooLive = false; sync(false); });
  window.addEventListener('storage', function (e) { if (e.key === 'dashview_odoo_config') start(); });

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(start);
})();
