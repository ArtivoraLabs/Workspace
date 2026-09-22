/* ==========================================================================
   DashView — Task assignments
   Replaces the old "Agent tasks" tab. Each task is assigned to an employee
   from the People directory (PeopleStore), so you can see at a glance who is
   working on what. Stored in this browser (dv_task_assignments).
   ========================================================================== */
(function () {
  'use strict';
  var root = document.getElementById('view-task-assignments');
  if (!root) return;

  var KEY = 'dv_task_assignments';
  var STATUS = { todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done' };
  var PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
  var S = { mode: 'people', q: '', emp: '', status: '', priority: '', editing: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
  function toast(m) { if (window.showToast) window.showToast(m); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function team() { try { return (window.PeopleStore && window.PeopleStore.get().team) || []; } catch (e) { return []; } }
  function emp(id) { return team().filter(function (e) { return e.id === id; })[0] || null; }
  function initials(n) { return String(n || '?').split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }
  function avatar(e, name) {
    var t = (e && e.tone) || ['#e8a33d', '#c76b3c'];
    return '<span class="tk-av" style="background:linear-gradient(135deg,' + esc(t[0]) + ',' + esc(t[1]) + ')">' + esc(initials(name)) + '</span>';
  }
  function overdue(t) { return t.status !== 'done' && t.due && t.due < today(); }
  function dueLabel(t) {
    if (!t.due) return '<span class="tk-muted">No due date</span>';
    var d = new Date(t.due + 'T00:00:00'), txt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return '<span class="' + (overdue(t) ? 'tk-due late' : 'tk-due') + '">' + (overdue(t) ? 'Overdue · ' : '') + esc(txt) + '</span>';
  }
  function pill(t) { return '<span class="tk-pill ' + t.status + '">' + esc(STATUS[t.status] || t.status) + '</span>'; }
  function pri(t) { return '<span class="tk-pri ' + t.priority + '"><i></i>' + esc(PRIORITY[t.priority] || t.priority) + '</span>'; }

  function filtered() {
    var q = S.q.toLowerCase();
    return load().filter(function (t) {
      return (!S.emp || t.assigneeId === S.emp) && (!S.status || t.status === S.status) && (!S.priority || t.priority === S.priority) &&
        (!q || (t.title + ' ' + (t.assigneeName || '') + ' ' + (t.notes || '')).toLowerCase().indexOf(q) > -1);
    });
  }

  /* -- Render --------------------------------------------------------------------- */
  function stats(all) {
    var open = all.filter(function (t) { return t.status !== 'done'; }).length;
    var cells = [['Open tasks', open, ''], ['In progress', all.filter(function (t) { return t.status === 'progress'; }).length, ''],
      ['Overdue', all.filter(overdue).length, all.filter(overdue).length ? 'late' : ''], ['Completed', all.filter(function (t) { return t.status === 'done'; }).length, 'ok']];
    $('tkStats').innerHTML = cells.map(function (c) { return '<div class="tk-stat ' + c[2] + '"><span>' + c[0] + '</span><b>' + c[1] + '</b></div>'; }).join('');
  }
  function taskRow(t) {
    return '<li class="tk-item' + (t.status === 'done' ? ' is-done' : '') + '"><button type="button" class="tk-check" data-done="' + esc(t.id) + '" aria-label="Toggle done" aria-pressed="' + (t.status === 'done') + '"></button>' +
      '<div class="tk-item-main"><button type="button" class="tk-title" data-edit="' + esc(t.id) + '">' + esc(t.title) + '</button><div class="tk-meta">' + pill(t) + pri(t) + dueLabel(t) + '</div></div></li>';
  }
  function renderPeople(list) {
    var members = team(), byEmp = {};
    list.forEach(function (t) { (byEmp[t.assigneeId] = byEmp[t.assigneeId] || []).push(t); });
    var known = {}; members.forEach(function (m) { known[m.id] = 1; });
    var orphans = Object.keys(byEmp).filter(function (id) { return !known[id]; });
    var withTasks = members.filter(function (m) { return byEmp[m.id]; });
    var without = members.filter(function (m) { return !byEmp[m.id] && (!S.emp || S.emp === m.id); });
    var html = withTasks.map(function (m) { return card(m, m.name, m.role, byEmp[m.id]); }).join('') +
      orphans.map(function (id) { var t = byEmp[id]; return card(null, t[0].assigneeName + ' (removed)', 'No longer in People', t); }).join('');
    if (without.length && !S.q && !S.status && !S.priority) {
      html += '<div class="tk-free"><h4>Available · no tasks</h4><div>' + without.map(function (m) { return '<button type="button" class="tk-free-chip" data-assign="' + esc(m.id) + '">' + avatar(m, m.name) + '<span>' + esc(m.name) + '</span><em>+ Assign</em></button>'; }).join('') + '</div></div>';
    }
    return html ? '<div class="tk-cards">' + html + '</div>' : '';
  }
  function card(m, name, role, tasks) {
    var done = tasks.filter(function (t) { return t.status === 'done'; }).length, pct = Math.round(done / tasks.length * 100), open = tasks.length - done;
    var sorted = tasks.slice().sort(function (a, b) { return (a.status === 'done') - (b.status === 'done') || (a.due || '9') .localeCompare(b.due || '9'); });
    return '<article class="panel tk-card"><header>' + avatar(m, name) + '<div class="tk-who"><b>' + esc(name) + '</b><span>' + esc(role || '') + (m && m.dept ? ' · ' + esc(m.dept) : '') + '</span></div>' +
      '<div class="tk-load" title="' + open + ' open of ' + tasks.length + '"><b>' + open + '</b><span>open</span></div></header>' +
      '<div class="tk-progress"><i style="width:' + pct + '%"></i></div><ul class="tk-list">' + sorted.map(taskRow).join('') + '</ul>' +
      (m ? '<button type="button" class="tk-add-inline" data-assign="' + esc(m.id) + '">+ Assign another task</button>' : '') + '</article>';
  }
  function renderTable(list) {
    if (!list.length) return '';
    return '<div class="panel"><div class="table-wrap"><table class="dash-table"><thead><tr><th>Task</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Due</th><th></th></tr></thead><tbody>' +
      list.map(function (t) {
        var e = emp(t.assigneeId), name = e ? e.name : (t.assigneeName || 'Unassigned');
        return '<tr><td><button type="button" class="tk-title" data-edit="' + esc(t.id) + '">' + esc(t.title) + '</button></td><td><span class="tk-cell-emp">' + avatar(e, name) + esc(name) + '</span></td><td>' + pri(t) + '</td>' +
          '<td><select class="tk-status-sel ' + t.status + '" data-status="' + esc(t.id) + '" aria-label="Status">' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (k === t.status ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select></td>' +
          '<td>' + dueLabel(t) + '</td><td class="tk-actions"><button type="button" class="tk-icon" data-edit="' + esc(t.id) + '" aria-label="Edit">✎</button><button type="button" class="tk-icon danger" data-del="' + esc(t.id) + '" aria-label="Delete">×</button></td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  function badges(all) {
    var open = all.filter(function (t) { return t.status !== 'done'; }).length, late = all.filter(overdue);
    var b = $('navTaskBadge'); if (b) { b.textContent = open; b.hidden = !open; }
    var d = $('notifDot'); if (d) d.hidden = !late.length;
    var n = $('notifList');
    if (n) n.innerHTML = late.length ? late.slice(0, 5).map(function (t) { return '<div class="notif-item"><div class="notif-icon" style="background:var(--danger-10)"></div><div class="notif-body"><p>Overdue: ' + esc(t.title) + ' — ' + esc(t.assigneeName) + '</p><span>Due ' + esc(t.due) + '</span></div><div class="notif-unread"></div></div>'; }).join('') : '<div class="notif-empty" style="padding:22px 16px;color:var(--ink-50);font-size:13px;text-align:center;">You’re all caught up.</div>';
  }
  function render() {
    var all = load(), list = filtered(), members = team();
    stats(all); badges(all);
    var sel = $('tkEmp'), cur = S.emp;
    sel.innerHTML = '<option value="">All employees</option>' + members.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    sel.value = cur;
    var html = S.mode === 'people' ? renderPeople(list) : renderTable(list);
    if (!members.length) html = '<div class="tk-empty"><h3>No employees yet</h3><p>Tasks are assigned to people from your directory. Add employees in the People tab first.</p><a class="btn btn-primary btn-sm" href="people.html">Open People</a></div>';
    else if (!html || (!list.length && !all.length)) html = '<div class="tk-empty"><h3>' + (all.length ? 'No tasks match these filters' : 'No tasks assigned yet') + '</h3><p>' + (all.length ? 'Try clearing a filter.' : 'Assign the first task and it will show up here under the employee’s name.') + '</p>' + (all.length ? '' : '<button type="button" class="btn btn-primary btn-sm" data-assign="">+ Assign task</button>') + '</div>' + (all.length ? '' : renderPeople([]));
    $('tkBody').innerHTML = html;
  }

  /* -- Modal ------------------------------------------------------------------------ */
  function openModal(id, presetEmp) {
    var t = id ? load().filter(function (x) { return x.id === id; })[0] : null; S.editing = t ? t.id : null;
    $('taskModalTitle').textContent = t ? 'Edit task' : 'Assign a task';
    $('taskAssignee').innerHTML = team().map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + ' — ' + esc(m.role || '') + '</option>'; }).join('');
    $('taskTitle').value = t ? t.title : ''; $('taskAssignee').value = t ? t.assigneeId : (presetEmp || (team()[0] || {}).id || '');
    $('taskPriority').value = t ? t.priority : 'medium'; $('taskStatus').value = t ? t.status : 'todo';
    $('taskDue').value = t ? (t.due || '') : ''; $('taskNotes').value = t ? (t.notes || '') : '';
    $('taskDelete').hidden = !t; $('taskErr').textContent = '';
    $('taskModal').classList.add('open'); setTimeout(function () { $('taskTitle').focus(); }, 60);
  }
  function closeModal() { $('taskModal').classList.remove('open'); }
  function saveModal() {
    var title = $('taskTitle').value.trim(), aid = $('taskAssignee').value, e = emp(aid);
    if (!title) { $('taskErr').textContent = 'Give the task a title.'; return; }
    if (!e) { $('taskErr').textContent = 'Choose who this task is assigned to.'; return; }
    var list = load(), now = new Date().toISOString();
    var rec = { title: title.slice(0, 160), assigneeId: aid, assigneeName: e.name, priority: $('taskPriority').value, status: $('taskStatus').value, due: $('taskDue').value || '', notes: $('taskNotes').value.trim().slice(0, 600), updated: now };
    if (S.editing) list = list.map(function (t) { return t.id === S.editing ? Object.assign({}, t, rec) : t; });
    else list.unshift(Object.assign({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), created: now }, rec));
    save(list); closeModal(); render(); toast(S.editing ? 'Task updated.' : 'Task assigned to ' + e.name + '.');
  }
  function mutate(id, patch) { save(load().map(function (t) { return t.id === id ? Object.assign({}, t, patch, { updated: new Date().toISOString() }) : t; })); render(); }
  function toCsv(list, filename) {
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    if (!list.length) { toast('No tasks to export yet.'); return; }
    var rows = [['Task', 'Assigned to', 'Priority', 'Status', 'Due', 'Notes']].concat(list.map(function (t) { return [t.title, t.assigneeName, PRIORITY[t.priority], STATUS[t.status], t.due, t.notes]; }));
    var url = URL.createObjectURL(new Blob([rows.map(function (r) { return r.map(q).join(','); }).join('\n')], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 800);
  }
  function exportCsv() { toCsv(filtered(), 'task-assignments-' + today() + '.csv'); }
  function exportAllCsv(filename) { toCsv(load(), filename || 'task-assignments-' + today() + '.csv'); }

  function init() {
    $('tkAdd').addEventListener('click', function () { openModal(); });
    $('tkExport').addEventListener('click', exportCsv);
    $('tkSearch').addEventListener('input', function () { S.q = this.value.trim(); render(); });
    ['tkEmp:emp', 'tkStatus:status', 'tkPriority:priority'].forEach(function (p) { var a = p.split(':'); $(a[0]).addEventListener('change', function () { S[a[1]] = this.value; render(); }); });
    document.querySelectorAll('#tkMode button').forEach(function (b) { b.addEventListener('click', function () { S.mode = b.getAttribute('data-mode'); document.querySelectorAll('#tkMode button').forEach(function (x) { x.classList.toggle('active', x === b); }); render(); }); });
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-edit],[data-done],[data-del],[data-assign]'); if (!t) return;
      if (t.hasAttribute('data-edit')) openModal(t.getAttribute('data-edit'));
      else if (t.hasAttribute('data-assign')) openModal(null, t.getAttribute('data-assign'));
      else if (t.hasAttribute('data-done')) { var id = t.getAttribute('data-done'), cur = load().filter(function (x) { return x.id === id; })[0]; if (cur) mutate(id, { status: cur.status === 'done' ? 'todo' : 'done' }); }
      else if (t.hasAttribute('data-del')) { if (confirm('Delete this task?')) { save(load().filter(function (x) { return x.id !== t.getAttribute('data-del'); })); render(); toast('Task deleted.'); } }
    });
    root.addEventListener('change', function (e) { var s = e.target.closest('[data-status]'); if (s) mutate(s.getAttribute('data-status'), { status: s.value }); });
    $('taskSave').addEventListener('click', saveModal);
    $('taskDelete').addEventListener('click', function () { if (S.editing && confirm('Delete this task?')) { save(load().filter(function (x) { return x.id !== S.editing; })); closeModal(); render(); toast('Task deleted.'); } });
    $('taskModalClose').addEventListener('click', closeModal);
    $('taskModal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === 'dashview-people-v1') render(); });
document.querySelectorAll('[data-view="task-assignments"]').forEach(function (l) { l.addEventListener('click', render); });
    window.__tasksExportCSV = exportAllCsv; // Reports \u2192 Task Completion Report
    render();
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
