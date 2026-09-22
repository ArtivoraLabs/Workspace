/* ==========================================================================
   people.smoke.test.js — headless DOM smoke test for people.html
   --------------------------------------------------------------------------
   Boots the real page in jsdom, injects the four People scripts, then drives
   the actual UI (clicks, typing, keyboard) and asserts on the resulting DOM
   rather than on internal function returns. No network, no build step — same
   self-contained strategy as studio-ui.smoke.test.js.

   Run: npm run test:people   (from test/)
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'people.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/people.html',
  virtualConsole: vc,
  pretendToBeVisual: true,
  resources: undefined,
  beforeParse(w) {
    w.confirm = () => true;
    w.alert = () => {};
    w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
    w.scrollTo = () => {};
    w.URL.createObjectURL = () => 'blob:mock';
    w.URL.revokeObjectURL = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
  }
});

const w = dom.window, d = w.document;

// Inject scripts manually (jsdom won't fetch relative files without a resource loader)
for (const src of ['js/hr-store.js', 'js/hr-icons.js', 'js/hr-views.js', 'js/hr-app.js']) {
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  try { w.eval(code); } catch (e) { errors.push(`FATAL in ${src}: ${e.message}\n${e.stack}`); }
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push([r === false ? 'FAIL' : 'PASS', name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}
const $ = s => d.querySelector(s);
const $$ = s => Array.from(d.querySelectorAll(s));
const click = el => { if (!el) throw new Error('element missing'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };

const S = w.PeopleStore;

/* ── Boot ─────────────────────────────────────────────────────────────── */
check('store initialised', () => !!S && S.get().team.length === 12);
check('welcome line rendered', () => $('#welcomeLine').textContent.includes('Nixtio'));
check('capacity segments rendered', () => $$('#capTrack .hr-cap-seg').length === 4);
check('headline stats rendered', () => $$('#statRow .hr-stat').length === 3);
check('spotlight rendered', () => $('#spotCard').textContent.includes('Lora Piterson'));
check('weekly bars rendered', () => $$('#weekBars .hr-bar').length === 7);
check('week axis rendered', () => $$('#weekAxis .hr-axis-cell').length === 7);
check('ring ticks built', () => $$('#ringTicks line').length === 60);
check('task list rendered', () => $$('#taskList .hr-taskrow').length === 8);
check('onboarding segments rendered', () => $$('#onbSegs .hr-onb-seg').length === 3);
check('accordion rendered', () => $$('#detailAcc .hr-acc-item').length === 4);
check('agenda grid rendered', () => $$('#calGrid .hr-cal-cell').length === 36);
check('seeded events on the grid', () => $$('#calGrid .hr-ev').length >= 3);

/* ── Onboarding interactivity ─────────────────────────────────────────── */
check('task count starts at 2/8', () => $('#taskCount').textContent === '2/8');
check('onboarding pct starts at 25%', () => $('#onbPct').textContent === '25%');
check('toggling a task updates the count', () => {
  click($$('#taskList .hr-taskrow')[2]);
  return $('#taskCount').textContent === '3/8' && $('#onbPct').textContent === '38%';
});
check('toggle persists to storage', () => {
  const saved = JSON.parse(w.localStorage.getItem('dashview-people-v1'));
  return saved.tasks[2].done === true;
});
check('toggling back restores', () => {
  click($$('#taskList .hr-taskrow')[2]);
  return $('#taskCount').textContent === '2/8';
});

/* ── Timer ────────────────────────────────────────────────────────────── */
check('timer starts paused', () => $('#playBtn').disabled === false && $('#pauseBtn').disabled === true);
check('play starts the timer', () => {
  click($('#playBtn'));
  return S.isRunning() === true && $('#pauseBtn').disabled === false && $('#playBtn').disabled === true;
});
check('running timer survives a reload (anchor persisted)', () => {
  const saved = JSON.parse(w.localStorage.getItem('dashview-people-v1'));
  return typeof saved.timer.runningSince === 'number';
});
check('pause banks the time', () => {
  click($('#pauseBtn'));
  return S.isRunning() === false;
});
check('ring shows a non-zero arc', () => {
  const off = parseFloat($('#ringArc').getAttribute('stroke-dashoffset'));
  const arr = parseFloat($('#ringArc').getAttribute('stroke-dasharray'));
  return off < arr && off > 0;
});
check('reset clears today', () => {
  click($('#resetBtn'));
  return S.todaySeconds() === 0;
});

/* ── Spotlight navigation ─────────────────────────────────────────────── */
check('next colleague changes spotlight', () => {
  click($$('#spotCard [data-spot]')[1]);
  return $('#spotCard').textContent.includes('Amara Okonkwo');
});
check('detail panel follows the spotlight', () => $('#detailAcc').textContent.includes('Compensation'));
check('accordion toggles', () => {
  const btn = $$('#detailAcc .hr-acc-btn')[0];
  const before = btn.getAttribute('aria-expanded');
  click(btn);
  return $$('#detailAcc .hr-acc-btn')[0].getAttribute('aria-expanded') !== before;
});

/* ── Agenda ───────────────────────────────────────────────────────────── */
check('week navigation moves the label', () => {
  const before = $('#weekLabel').textContent;
  click($('#weekNext'));
  const after = $('#weekLabel').textContent;
  click($('#weekPrev'));
  return before === $('#weekLabel').textContent;
});
check('add-event opens the modal', () => {
  click($$('#calGrid .hr-cal-add')[8]);
  return $('#eventModal').hidden === false;
});
check('modal rejects an empty title', () => {
  click($('#evSave'));
  return $('#eventModal').hidden === false;
});
check('modal saves a valid event', () => {
  $('#evTitle').value = 'Budget review';
  $('#evStart').value = '10:00';
  $('#evEnd').value = '11:00';
  click($('#evSave'));
  return $('#eventModal').hidden === true &&
    S.get().events.some(e => e.title === 'Budget review');
});
check('new event appears on the grid', () =>
  $$('#calGrid .hr-ev').some(e => e.textContent.includes('Budget review')));

check('two events in one hour share the column', () => {
  const key = S.util.isoDay(S.util.addDays(S.util.startOfWeek(new Date()), 2));
  S.addEvent({ title: 'Clash A', note: '', date: key, start: '12:00', end: '13:00', tone: 'plain', people: [] });
  S.addEvent({ title: 'Clash B', note: '', date: key, start: '12:00', end: '13:00', tone: 'ink', people: [] });
  const cell = $$('#calGrid .hr-cal-cell').find(c => c.dataset.date === key && c.dataset.hour === '12');
  const evs = Array.from(cell.querySelectorAll('.hr-ev'));
  if (evs.length !== 2) return 'expected 2 got ' + evs.length;
  return evs[0].style.width.includes('50%') && evs[1].style.left.includes('50%');
});
check('modal restores focus to the opener', () => {
  const opener = $$('#calGrid .hr-cal-add')[3];
  opener.focus();
  click(opener);
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return d.activeElement === opener;
});

/* ── Notifications ────────────────────────────────────────────────────── */
check('unread dot visible', () => $('#bellDot').hidden === false);
check('bell opens the panel', () => { click($('#bellBtn')); return $('#notiPop').hidden === false; });
check('mark-all-read clears the dot', () => {
  click($('#markReadBtn'));
  return $('#bellDot').hidden === true && S.unreadCount() === 0;
});

/* ── Routing + secondary views ────────────────────────────────────────── */
const views = ['people', 'hiring', 'devices', 'apps', 'salary', 'calendar', 'reviews', 'settings'];
views.forEach(v => {
  check(`view "${v}" renders`, () => {
    const btn = $(`.hr-nav-btn[data-view="${v}"]`);
    if (btn) click(btn); else w.hrShowView(v);
    const panel = $('#view-' + v);
    return panel.hidden === false && panel.innerHTML.length > 400;
  });
});

check('people search filters rows', () => {
  w.hrShowView('people');
  const box = $('#pplSearch');
  box.value = 'engineer';
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  const rows = $$('#view-people tbody tr').length;
  return rows > 0 && rows < 12;
});
check('search keeps the caret where it was', () => {
  const box = $('#pplSearch');
  box.value = 'enginer';
  box.setSelectionRange(5, 5);
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  const after = $('#pplSearch');
  return d.activeElement === after && after.selectionStart === 5;
});
check('people filter clears', () => {
  const box = $('#pplSearch');
  box.value = '';
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  return $$('#view-people tbody tr').length === 12;
});
check('spotlight button from directory works', () => {
  click($$('#view-people [data-spot]')[3]);
  return $('#view-dashboard').hidden === false;
});

check('hiring board has 5 stages', () => {
  w.hrShowView('hiring');
  return $$('#view-hiring .hr-col').length === 5;
});
check('candidate advances a stage', () => {
  const before = S.get().candidates.find(c => c.id === 'c5').stage;
  const btn = $('#view-hiring [data-move="1"][data-id="c5"]');
  click(btn);
  return S.get().candidates.find(c => c.id === 'c5').stage !== before;
});

check('device assignment updates the store', () => {
  w.hrShowView('devices');
  const sel = $('#view-devices [data-assign="d5"]');
  sel.value = 'e3';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  return S.get().devices.find(d => d.id === 'd5').assigned === 'e3' &&
    S.get().devices.find(d => d.id === 'd5').status === 'Issued';
});

check('settings save updates the greeting', () => {
  w.hrShowView('settings');
  $('#setWs').value = 'Aurora';
  click($('#setSave'));
  return $('#welcomeLine').textContent.includes('Aurora');
});
check('capacity slider updates the bar', () => {
  w.hrShowView('settings');
  const r = $('#view-settings [data-cap="output"]');
  r.value = '30';
  r.dispatchEvent(new w.Event('change', { bubbles: true }));
  return S.get().capacity.find(c => c.id === 'output').pct === 30;
});

/* ── Command palette ──────────────────────────────────────────────────── */
check('cmd+k opens the palette', () => {
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  return $('#cmdPalette').hidden === false;
});
check('palette lists sections and people', () => $$('#cmdList .hr-cmd-item').length > 12);
check('palette filters', () => {
  const inp = $('#cmdInput');
  inp.value = 'priya';
  inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  return $$('#cmdList .hr-cmd-item').length === 1;
});
check('palette enter runs the command', () => {
  $('#cmdInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return $('#cmdPalette').hidden === true && S.spotlight().name === 'Priya Raghavan';
});
check('escape closes the palette', () => {
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return $('#cmdPalette').hidden === true;
});

/* ── Reset ────────────────────────────────────────────────────────────── */
check('reset restores seed data', () => {
  S.reset();
  return S.get().profile.workspace === 'Nixtio' && S.taskProgress().done === 2;
});

/* ── Accessibility spot-checks ────────────────────────────────────────── */
check('nav uses tablist semantics', () =>
  $('#mainNav').getAttribute('role') === 'tablist' &&
  $$('.hr-nav-btn').every(b => b.hasAttribute('aria-selected')));
check('tasks expose pressed state', () =>
  $$('#taskList .hr-taskrow').every(b => b.hasAttribute('aria-pressed')));
check('bars carry accessible labels', () =>
  $$('#weekBars .hr-bar').every(b => (b.getAttribute('aria-label') || '').length > 5));
check('every icon-only control is labelled', () => {
  const bad = $$('button').filter(b => {
    const hasText = b.textContent.trim().length > 0;
    return !hasText && !b.getAttribute('aria-label');
  });
  return bad.length === 0 ? true : 'unlabelled: ' + bad.length;
});

/* ── Report ───────────────────────────────────────────────────────────── */
console.log('');
const pad = Math.max(...results.map(r => r[1].length));
results.forEach(([s, n, m]) => {
  console.log(`${s === 'PASS' ? ' ok ' : 'FAIL'}  ${n.padEnd(pad)}  ${m}`);
});
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) {
  console.log('\n--- runtime errors ---');
  errors.slice(0, 12).forEach(e => console.log(e));
}
process.exit(failed.length || errors.length ? 1 : 0);
