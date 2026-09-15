/* ==========================================================================
   DashView — Auth + Role service (PROTOTYPE / MOCK)
   ==========================================================================
   This is a client-side, zero-backend mock of a real auth system, built so
   the rest of the app (widget builder, Odoo panel, sharing, TV mode) has a
   real permission model to check against today, and a clean seam to swap in
   real authentication later.

   What's real: session state, role-based permission checks (window.DVAuth.can),
   and every UI element that reads them.
   What's mock: there is no server, no password hashing, no verified identity.
   "Passwords" are checked against a plaintext seed list in localStorage —
   this is exactly as secure as it sounds, i.e. not at all. Never reuse a
   real password here.

   TO WIRE UP REAL AUTH LATER:
   - Replace `login()`'s body with a fetch() to /server (see js/dashview-api.js
     for the existing pattern — it already does real JWT auth against
     server/src/routes/auth.routes.js).
   - Replace the seeded USERS list with a real `/me` lookup.
   - Keep the same `window.DVAuth` surface (can/currentUser/login/logout) so
     nothing else in the app has to change.
   ========================================================================== */
(function () {
  'use strict';

  var USERS_KEY = 'dv_auth_users';
  var SESSION_KEY = 'dv_auth_session';

  var ROLES = { ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer' };

  var ROLE_LABEL = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
  var ROLE_COLOR = { admin: '#e8a33d', editor: '#5b8fae', viewer: '#8b93a0' };

  // What each role can do. Checked via DVAuth.can('editWidgets') etc.
  // Extend this map, not scattered role checks, when adding a new capability.
  var PERMISSIONS = {
    viewWorkspace: ['admin', 'editor', 'viewer'],
    editWidgets: ['admin', 'editor'],
    deleteWidgets: ['admin', 'editor'],
    importExport: ['admin', 'editor'],
    share: ['admin', 'editor'],
    tvMode: ['admin', 'editor', 'viewer'],
    manageOdoo: ['admin'],
    browseOdoo: ['admin', 'editor'],
    manageUsers: ['admin']
  };

  var SEED_USERS = [
    { email: 'admin@acme-corp.com', password: 'admin123', name: 'Amara Khan', role: ROLES.ADMIN, initials: 'AK' },
    { email: 'editor@acme-corp.com', password: 'editor123', name: 'Jonah Price', role: ROLES.EDITOR, initials: 'JP' },
    { email: 'viewer@acme-corp.com', password: 'viewer123', name: 'Sasha Lee', role: ROLES.VIEWER, initials: 'SL' }
  ];

  function loadJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  function seedUsers() {
    var existing = loadJSON(USERS_KEY, null);
    if (!existing || !existing.length) { saveJSON(USERS_KEY, SEED_USERS); return SEED_USERS; }
    return existing;
  }

  function getUsers() { return seedUsers(); }

  function getSession() { return loadJSON(SESSION_KEY, null); }
  function setSession(sess) { saveJSON(SESSION_KEY, sess); render(); }

  function guestSession() {
    return { email: 'guest@acme-corp.com', name: 'Guest', role: ROLES.VIEWER, initials: 'GU', guest: true };
  }

  // First-ever visit defaults to the workspace admin (Amara Khan) — this
  // matches the workspace this app already presents everywhere else (audit
  // log, team page, profile settings) so nothing else has to change. Signing
  // out drops to an explicit Guest/Viewer session instead of erasing state,
  // so the role-gating is easy to see without forcing a real login first.
  function currentUser() {
    var sess = getSession();
    if (sess) return sess;
    var def = { email: 'admin@acme-corp.com', name: 'Amara Khan', role: ROLES.ADMIN, initials: 'AK' };
    saveJSON(SESSION_KEY, def);
    return def;
  }

  function can(perm) {
    var role = currentUser().role;
    var allowed = PERMISSIONS[perm];
    return !!allowed && allowed.indexOf(role) > -1;
  }

  function login(email, password) {
    var users = getUsers();
    var match = users.filter(function (u) { return u.email.toLowerCase() === String(email).toLowerCase(); })[0];
    if (!match) return { ok: false, error: 'No account with that email in this demo workspace.' };
    if (match.password !== password) return { ok: false, error: 'Incorrect password.' };
    setSession({ email: match.email, name: match.name, role: match.role, initials: match.initials });
    return { ok: true };
  }

  function loginAsDemo(role) {
    var users = getUsers();
    var match = users.filter(function (u) { return u.role === role; })[0];
    if (!match) return { ok: false, error: 'Unknown role.' };
    setSession({ email: match.email, name: match.name, role: match.role, initials: match.initials });
    return { ok: true };
  }

  function logout() {
    setSession(guestSession());
  }

  /* ── Role gating: any element with [data-min-role] is hidden unless the
     current user's role can satisfy it. Elements can also carry
     [data-require-perm="editWidgets"] to gate on a specific capability. ── */
  function applyGates(root) {
    var scope = root || document;
    var user = currentUser();
    scope.querySelectorAll('[data-require-perm]').forEach(function (el) {
      var perm = el.getAttribute('data-require-perm');
      var ok = can(perm);
      el.classList.toggle('pro-hidden-by-role', !ok);
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') el.disabled = !ok;
    });
    scope.querySelectorAll('[data-min-role]').forEach(function (el) {
      var role = el.getAttribute('data-min-role');
      var order = { viewer: 0, editor: 1, admin: 2 };
      var ok = order[user.role] >= order[role];
      el.classList.toggle('pro-hidden-by-role', !ok);
    });
  }

  /* ── UI: sidebar user block + account menu + sign-in modal ─────────────── */
  var modalBuilt = false;
  function buildModal() {
    if (modalBuilt) return; modalBuilt = true;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'dvAuthModal';
    overlay.innerHTML =
      '<div class="modal-card">' +
      '  <button type="button" class="modal-close" id="dvAuthClose" aria-label="Close">' +
      '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
      '  </button>' +
      '  <p class="eyebrow" style="margin-bottom:var(--sp-2);">Prototype auth — not a real account system</p>' +
      '  <h3>Sign in to acme-corp</h3>' +
      '  <p>Three demo roles are seeded so you can see how the workspace changes per permission level. Pick one instantly, or sign in with its credentials below.</p>' +
      '  <div class="dv-demo-role-row" id="dvDemoRoleRow">' +
      '    <button type="button" class="dv-demo-role-btn" data-role="admin"><span class="dv-role-dot" style="background:' + ROLE_COLOR.admin + '"></span>Admin</button>' +
      '    <button type="button" class="dv-demo-role-btn" data-role="editor"><span class="dv-role-dot" style="background:' + ROLE_COLOR.editor + '"></span>Editor</button>' +
      '    <button type="button" class="dv-demo-role-btn" data-role="viewer"><span class="dv-role-dot" style="background:' + ROLE_COLOR.viewer + '"></span>Viewer</button>' +
      '  </div>' +
      '  <form id="dvAuthForm" novalidate>' +
      '    <div class="field"><label for="dvAuthEmail">Email</label><input type="email" id="dvAuthEmail" placeholder="admin@acme-corp.com" autocomplete="username"/></div>' +
      '    <div class="field"><label for="dvAuthPassword">Password</label><input type="password" id="dvAuthPassword" placeholder="••••••••" autocomplete="current-password"/></div>' +
      '    <p class="formula-error" id="dvAuthError" style="display:none;"></p>' +
      '    <button type="submit" class="btn btn-primary btn-block btn-lg" style="margin-top:var(--sp-3);">Sign in</button>' +
      '  </form>' +
      '  <p class="settings-note" style="margin-top:var(--sp-4);">Demo credentials: <code>admin@acme-corp.com / admin123</code>, <code>editor@acme-corp.com / editor123</code>, <code>viewer@acme-corp.com / viewer123</code>.</p>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() { overlay.classList.remove('open'); byId('dvAuthError').style.display = 'none'; }
    function byId(id) { return document.getElementById(id); }
    byId('dvAuthClose').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.querySelectorAll('#dvDemoRoleRow .dv-demo-role-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        loginAsDemo(btn.getAttribute('data-role'));
        if (window.showToast) window.showToast('Signed in as ' + ROLE_LABEL[btn.getAttribute('data-role')] + ' (demo).');
        close();
      });
    });
    byId('dvAuthForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = login(byId('dvAuthEmail').value.trim(), byId('dvAuthPassword').value);
      if (!res.ok) { byId('dvAuthError').textContent = res.error; byId('dvAuthError').style.display = 'block'; return; }
      if (window.showToast) window.showToast('Signed in as ' + currentUser().name + '.');
      close();
    });
    window.__dvOpenAuthModal = function () { overlay.classList.add('open'); byId('dvAuthEmail').focus(); };
  }

  var menuBuilt = false;
  function buildMenu() {
    if (menuBuilt) return; menuBuilt = true;
    var menu = document.createElement('div');
    menu.className = 'dv-account-menu';
    menu.id = 'dvAccountMenu';
    document.body.appendChild(menu);
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#dvAccountMenu') && !e.target.closest('#dashUserBlock')) {
        menu.classList.remove('open');
      }
    });
  }

  function renderMenu() {
    var menu = document.getElementById('dvAccountMenu');
    if (!menu) return;
    var user = currentUser();
    menu.innerHTML =
      '<div class="dv-account-menu-head">' +
      '  <div class="dash-side-user" style="background:' + ROLE_COLOR[user.role] + '22;color:' + ROLE_COLOR[user.role] + ';">' + user.initials + '</div>' +
      '  <div><p>' + escapeHtml(user.name) + '</p><span>' + escapeHtml(user.email) + '</span></div>' +
      '</div>' +
      '<div class="dv-account-menu-role"><span class="dv-role-dot" style="background:' + ROLE_COLOR[user.role] + '"></span>' + ROLE_LABEL[user.role] + (user.guest ? ' · Guest session' : '') + '</div>' +
      '<button type="button" class="dv-account-menu-item" id="dvMenuSwitch">Switch demo account…</button>' +
      (user.guest ? '' : '<button type="button" class="dv-account-menu-item" id="dvMenuSignout">Sign out</button>');
    var switchBtn = document.getElementById('dvMenuSwitch');
    if (switchBtn) switchBtn.addEventListener('click', function () { menu.classList.remove('open'); buildModal(); window.__dvOpenAuthModal(); });
    var signoutBtn = document.getElementById('dvMenuSignout');
    if (signoutBtn) signoutBtn.addEventListener('click', function () { menu.classList.remove('open'); logout(); if (window.showToast) window.showToast('Signed out — back to guest (Viewer) access.'); });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }

  function renderSidebar() {
    var user = currentUser();
    var block = document.getElementById('dashUserBlock');
    if (block) {
      var avatar = block.querySelector('#dashUserAvatar');
      var name = block.querySelector('#dashUserName');
      var meta = block.querySelector('#dashUserMeta');
      if (avatar) { avatar.textContent = user.initials; avatar.style.background = ROLE_COLOR[user.role] + '22'; avatar.style.color = ROLE_COLOR[user.role]; }
      if (name) name.textContent = user.name;
      if (meta) meta.innerHTML = 'acme-corp · <span class="dv-role-pill" style="color:' + ROLE_COLOR[user.role] + ';border-color:' + ROLE_COLOR[user.role] + '55;">' + ROLE_LABEL[user.role] + '</span>' + (user.guest ? ' · Guest' : '');
    }
    var topAvatar = document.getElementById('dashTopUserAvatar');
    if (topAvatar) { topAvatar.textContent = user.initials; topAvatar.style.background = ROLE_COLOR[user.role] + '22'; topAvatar.style.color = ROLE_COLOR[user.role]; }
  }

  function render() {
    renderSidebar();
    renderMenu();
    applyGates(document);
    var banner = document.getElementById('dvGuestBanner');
    if (banner) banner.style.display = currentUser().guest ? 'flex' : 'none';
    document.dispatchEvent(new CustomEvent('dv:session-changed', { detail: currentUser() }));
  }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    buildModal();
    buildMenu();
    render();
    var block = document.getElementById('dashUserBlock');
    if (block) block.addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = document.getElementById('dvAccountMenu');
      var rect = block.getBoundingClientRect();
      menu.style.left = (rect.right + 8) + 'px';
      menu.style.bottom = (window.innerHeight - rect.bottom) + 'px';
      menu.classList.toggle('open');
    });
    var topAvatar = document.getElementById('dashTopUserAvatar');
    if (topAvatar) topAvatar.addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = document.getElementById('dvAccountMenu');
      var rect = topAvatar.getBoundingClientRect();
      menu.style.right = (window.innerWidth - rect.right) + 'px';
      menu.style.top = (rect.bottom + 8) + 'px';
      menu.style.left = 'auto'; menu.style.bottom = 'auto';
      menu.classList.toggle('open');
    });
    var signInBtn = document.getElementById('dashSignInBtn');
    if (signInBtn) signInBtn.addEventListener('click', function () { window.__dvOpenAuthModal(); });
  });

  window.DVAuth = {
    ROLES: ROLES, ROLE_LABEL: ROLE_LABEL, ROLE_COLOR: ROLE_COLOR,
    currentUser: currentUser, can: can, login: login, loginAsDemo: loginAsDemo, logout: logout,
    applyGates: applyGates, getUsers: getUsers
  };
})();
