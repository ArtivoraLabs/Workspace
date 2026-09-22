/* ==========================================================================
   DashView People — shared shell chrome (sidebar + theme)
   --------------------------------------------------------------------------
   Mirrors the theme-toggle and sidebar-collapse behaviour from js/shell.js
   (used on dashboard.html) so both pages stay in sync via the same
   'dashview-theme' key. Deliberately leaves out shell.js's view-switching:
   this page's nav buttons already carry their own data-view wiring for
   hr-app.js's internal tabs, and reusing shell.js's [data-view] handler
   here would hijack that click instead of letting hr-app.js run it.
   ========================================================================== */
(function () {
  'use strict';
  function byId(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  /* ── Theme ─────────────────────────────────────────────────────────────── */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('dashview-theme', theme); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f6f3' : '#0a0c0b');
    var btn = byId('themeToggleBtn');
    if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  }
  on(byId('themeToggleBtn'), 'click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });
  window.addEventListener('storage', function (e) {
    if (e.key === 'dashview-theme' && (e.newValue === 'light' || e.newValue === 'dark')) applyTheme(e.newValue);
  });

  /* ── Sidebar collapse (desktop) + off-canvas (mobile) ─────────────────── */
  on(byId('sidebarCollapseBtn'), 'click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    byId('shell').classList.toggle('collapsed');
  });
  on(byId('mobileSideToggle'), 'click', function () {
    byId('sidebar').classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (window.innerWidth > 800) return;
    if (!e.target.closest('#sidebar') && !e.target.closest('#mobileSideToggle')) {
      byId('sidebar').classList.remove('open');
    }
  });

  /* ── Sidebar "Settings" link jumps into this page's own Settings tab ──── */
  on(byId('sidebarSettingsLink'), 'click', function (e) {
    e.preventDefault();
    if (window.hrShowView) window.hrShowView('settings');
    byId('sidebar').classList.remove('open');
  });
})();
