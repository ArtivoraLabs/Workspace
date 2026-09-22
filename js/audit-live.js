/* ==========================================================================
   DashView — Audit log (live from Odoo)
   Sources
     activity  → mail.message   who did what on which Odoo record (chatter + tracked changes)
     signins   → res.users.log  Odoo sign-ins (falls back to res.users.login_date)
     local     → DVSec log      security events recorded by this workspace (lock/unlock, exports…)
   ========================================================================== */
(function () {
  'use strict';
  var root = document.getElementById('view-audit-log');
  if (!root || !window.DVOdooClient) return;

  var C = window.DVOdooClient, F = window.DVFmt, esc = F.esc;
  function $(id) { return document.getElementById(id); }
  var S = { src: 'activity', page: 0, size: 25, total: 0, rows: [], models: {}, seq: 0 };
  var TYPE = { comment: ['Message', 'active'], notification: ['System', 'review'], email: ['Email', 'review'], user_notification: ['Notification', 'review'], auto_comment: ['Automated', 'review'] };
  var LOCAL = { ok: ['Success', 'active'], review: ['Flagged', 'review'], blocked: ['Denied', 'blocked'] };
  var NOTE = {
    activity: 'Chatter messages and tracked field changes across every Odoo record your API user can read.',
    signins: 'Odoo sign-in history. Needs an Odoo user with Settings access; otherwise the last sign-in per user is shown.',
    local: 'Security events recorded by this DashView workspace on this device (passcode, locks, exports, credential changes).'
  };

  function period() { return +$('auditPeriod').value; }
  function needsOdoo() { return S.src !== 'local'; }
  function setStatus(mode, text) {
    var p = $('auditStatus'); p.classList.remove('is-live', 'is-error');
    if (mode === 'live') p.classList.add('is-live'); if (mode === 'error') p.classList.add('is-error');
    $('auditStatusText').textContent = text;
  }
  function msg(html, err) { $('auditBody').innerHTML = '<tr><td colspan="6" class="odoo-live-table-state' + (err ? ' is-error' : '') + '">' + html + '</td></tr>'; }
  function odooHost() { try { return new URL(C.cfg().url).host; } catch (e) { return ''; } }
  function recordLink(model, id) {
    var base = C.cfg().url || ''; if (!/^https?:\/\//i.test(base) || !model || !id) return '';
    return '<a class="audit-link" target="_blank" rel="noopener noreferrer" title="Open in Odoo" href="' + esc(base.replace(/\/+$/, '') + '/web#model=' + encodeURIComponent(model) + '&id=' + encodeURIComponent(id) + '&view_type=form') + '">↗</a>';
  }

  /* -- Normalised fetchers: each resolves { rows, total } ----------------------- */
  function fetchActivity(limit, offset) {
    var dom = [['model', '!=', false]], q = $('auditSearch').value.trim(), t = $('auditType').value;
    if (period()) dom.push(['date', '>=', F.isoDaysAgo(period())]);
    if (t) dom.push(['message_type', '=', t]);
    if (q) dom = dom.concat(['|', '|', ['record_name', 'ilike', q], ['subject', 'ilike', q], ['author_id', 'ilike', q]]);
    return C.records('mail.message', { domain: dom, fields: ['date', 'author_id', 'message_type', 'subtype_id', 'model', 'res_id', 'record_name', 'subject', 'body', 'tracking_value_ids', 'email_from'], limit: limit, offset: offset, order: 'date desc' }).then(function (r) {
      var need = []; (r.rows || []).forEach(function (m) { if (m.model && !S.models[m.model] && need.indexOf(m.model) < 0) need.push(m.model); });
      var lab = need.length ? C.records('ir.model', { domain: [['model', 'in', need]], fields: ['model', 'name'], limit: 100 }).then(function (x) { (x.rows || []).forEach(function (m) { S.models[m.model] = m.name; }); }).catch(function () {}) : Promise.resolve();
      return lab.then(function () {
        return { total: r.total || 0, rows: (r.rows || []).map(function (m) {
          var text = F.stripHtml(m.body), n = (m.tracking_value_ids || []).length, ty = TYPE[m.message_type] || [m.message_type || 'Other', 'review'];
          var details = text || (n ? n + ' field change' + (n > 1 ? 's' : '') + ' tracked' : (m.subject || '–'));
          return { time: m.date, user: Array.isArray(m.author_id) ? m.author_id[1] : (m.email_from || 'System'), action: Array.isArray(m.subtype_id) ? m.subtype_id[1] : ty[0],
            record: m.record_name || (S.models[m.model] || m.model), sub: S.models[m.model] || m.model, link: recordLink(m.model, m.res_id), details: details, type: ty[0], cls: ty[1] };
        }) };
      });
    });
  }
  function fetchSignins(limit, offset) {
    var dom = [], q = $('auditSearch').value.trim();
    if (period()) dom.push(['create_date', '>=', F.isoDaysAgo(period())]);
    if (q) dom.push(['create_uid', 'ilike', q]);
    return C.records('res.users.log', { domain: dom, fields: ['create_uid', 'create_date'], limit: limit, offset: offset, order: 'create_date desc' }).then(function (r) {
      return { total: r.total || 0, rows: (r.rows || []).map(function (l) { return { time: l.create_date, user: Array.isArray(l.create_uid) ? l.create_uid[1] : '–', action: 'Signed in', record: 'Odoo web client', sub: odooHost(), link: '', details: 'Session started', type: 'Sign-in', cls: 'active' }; }) };
    }).catch(function () {
      var d2 = [['login_date', '!=', false]]; if (q) d2.push(['name', 'ilike', q]); if (period()) d2.push(['login_date', '>=', F.isoDaysAgo(period())]);
      return C.records('res.users', { domain: d2, fields: ['name', 'login', 'login_date'], limit: limit, offset: offset, order: 'login_date desc' }).then(function (r) {
        return { total: r.total || 0, note: 'Detailed sign-in history needs Settings access in Odoo — showing each user’s most recent sign-in instead.', rows: (r.rows || []).map(function (u) { return { time: u.login_date, user: u.name, action: 'Last sign-in', record: u.login || '', sub: odooHost(), link: '', details: 'Most recent session', type: 'Sign-in', cls: 'active' }; }) };
      });
    });
  }
  function fetchLocal(limit, offset) {
    var q = $('auditSearch').value.trim().toLowerCase(), since = period() ? Date.now() - period() * 864e5 : 0;
    var all = (window.DVSec ? window.DVSec.getLog() : []).filter(function (e) { return e.t >= since && (!q || (e.u + ' ' + e.a + ' ' + e.d).toLowerCase().indexOf(q) > -1); });
    return Promise.resolve({ total: all.length, rows: all.slice(offset, offset + limit).map(function (e) {
      var st = LOCAL[e.s] || LOCAL.ok;
      return { time: new Date(e.t).toISOString().slice(0, 19).replace('T', ' '), user: e.u || 'You', action: e.a, record: 'DashView workspace', sub: location.host, link: '', details: e.d || '–', type: st[0], cls: st[1] };
    }) });
  }
  function fetcher() { return S.src === 'activity' ? fetchActivity : S.src === 'signins' ? fetchSignins : fetchLocal; }

  /* -- Render ---------------------------------------------------------------------- */
  function render() {
    var from = S.total ? S.page * S.size + 1 : 0, to = Math.min(S.total, S.page * S.size + S.rows.length);
    $('auditPageInfo').textContent = S.total ? from + '–' + to + ' of ' + S.total.toLocaleString() : '0 of 0';
    $('auditPrev').disabled = S.page === 0; $('auditNext').disabled = to >= S.total;
    if (!S.rows.length) return msg('No log entries match these filters.');
    $('auditBody').innerHTML = S.rows.map(function (r) {
      return '<tr><td class="mono">' + esc(F.when(r.time)) + '</td><td>' + esc(r.user) + '</td><td>' + esc(r.action) + '</td>' +
        '<td><span class="audit-rec">' + esc(r.record) + ' ' + (r.link || '') + '</span><span class="audit-sub">' + esc(r.sub) + '</span></td>' +
        '<td class="audit-details" title="' + esc(r.details) + '">' + esc(r.details.length > 140 ? r.details.slice(0, 140) + '…' : r.details) + '</td>' +
        '<td><span class="status-pill ' + r.cls + '">' + esc(r.type) + '</span></td></tr>';
    }).join('');
  }
  function load() {
    var seq = ++S.seq, src = S.src;
    $('auditNote').textContent = NOTE[src];
    $('auditTypeWrap').hidden = src !== 'activity';
    $('auditSub').textContent = src === 'local' ? 'Security events recorded by this workspace' : (odooHost() ? 'Live from ' + odooHost() : 'Live from your Odoo');
    var st = C.state();
    if (needsOdoo() && st !== 'ok') {
      $('auditBanner').hidden = false; $('auditBannerText').innerHTML = '<strong>' + (st === 'locked' ? 'Workspace locked.' : 'Odoo not connected.') + '</strong> ' + esc(C.message(st));
      setStatus('error', st === 'locked' ? 'Locked' : 'Not connected'); S.rows = []; S.total = 0; render(); msg('Connect Odoo to see its audit trail — or open the “Workspace security” tab.'); return;
    }
    $('auditBanner').hidden = true; setStatus('connecting', 'Loading…'); msg('Fetching live log…');
    var t0 = Date.now();
    fetcher()(S.size, S.page * S.size).then(function (r) {
      if (seq !== S.seq) return;
      S.rows = r.rows; S.total = r.total; render();
      if (r.note) $('auditNote').textContent = r.note;
      setStatus(src === 'local' ? 'live' : 'live', src === 'local' ? 'This device' : 'Live · ' + (Date.now() - t0) + ' ms');
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.rows = []; S.total = 0; setStatus('error', 'Error');
      var m = e.message || 'Request failed';
      msg(esc(/doesn.t exist|does not exist/i.test(m) ? 'This Odoo database does not expose that log (the Discuss/Mail app is required).' : /access/i.test(m) ? 'The connected Odoo user is not allowed to read this log.' : m), true);
      $('auditPageInfo').textContent = '0 of 0';
    });
  }
  function exportCsv() {
    var btn = $('exportAuditBtn'); btn.disabled = true;
    var go = needsOdoo() && C.state() !== 'ok' ? Promise.resolve({ rows: [] }) : fetcher()(500, 0);
    go.then(function (r) {
      var rows = [['Time', 'User', 'Action', 'Record', 'Model', 'Details', 'Type']].concat(r.rows.map(function (x) { return [x.time, x.user, x.action, x.record, x.sub, x.details, x.type]; }));
      F.download('audit-' + S.src + '-' + new Date().toISOString().slice(0, 10) + '.csv', F.csv(rows));
      if (window.DVSec) window.DVSec.log('Exported audit log', S.src + ' · ' + r.rows.length + ' rows');
      if (window.showToast) window.showToast('Exported ' + r.rows.length + ' rows.');
    }).catch(function (e) { if (window.showToast) window.showToast(e.message); }).then(function () { btn.disabled = false; });
  }

  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function reset() { S.page = 0; load(); }
  function init() {
    document.querySelectorAll('#auditTabs button').forEach(function (b) {
      b.addEventListener('click', function () { document.querySelectorAll('#auditTabs button').forEach(function (x) { x.classList.toggle('active', x === b); }); S.src = b.getAttribute('data-src'); reset(); });
    });
    $('auditSearch').addEventListener('input', debounce(reset, 350));
    $('auditPeriod').addEventListener('change', reset); $('auditType').addEventListener('change', reset);
    $('auditRefresh').addEventListener('click', function () { C.reset(); load(); });
    $('exportAuditBtn').addEventListener('click', exportCsv);
    $('auditPrev').addEventListener('click', function () { if (S.page > 0) { S.page--; load(); } });
    $('auditNext').addEventListener('click', function () { S.page++; load(); });
    ['dv:odoo-config-saved', 'dv:unlocked', 'dv:locked'].forEach(function (ev) { document.addEventListener(ev, function () { if (root.classList.contains('active')) reset(); }); });
    document.querySelectorAll('[data-view="audit-log"]').forEach(function (l) { l.addEventListener('click', function () { setTimeout(reset, 0); }); });
    if (root.classList.contains('active')) load();
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
