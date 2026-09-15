const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

// Same no-network, self-contained strategy as studio-ui.smoke.test.js, plus we
// inline js/report-engine.js too (instead of the real CDN libs it would lazily
// pull in a real browser) and stub its two browser entry points so we can
// inspect exactly what payload the UI handed it, without touching a network.
html = html.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"><\/script>/,
  () => `<script>
    window.matchMedia = window.matchMedia || function () { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; };
    window.Chart = function (ctx, config) {
      this.ctx = ctx; this.config = config; this.width = 800; this.height = 400;
      this.destroy = function () {};
      this.toBase64Image = function () { return 'data:image/png;base64,stub'; };
    };
  </script>`
);
function inline(relPath) {
  return '<script>\n' + fs.readFileSync(path.join(ROOT, relPath), 'utf8') + '\n</script>';
}
html = html.replace('<script src="js/app.js"></script>', () => inline('js/app.js'));
html = html.replace('<script src="js/studio-core.js"></script>', () => inline('js/studio-core.js'));
html = html.replace('<script src="js/studio-ui.js"></script>', () => inline('js/studio-ui.js'));
html = html.replace('<script src="js/report-engine.js"></script>', () => inline('js/report-engine.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n       ', e.message); }
}

(async function main() {
  const dom = new JSDOM(html, { url: 'https://example.org/dashboard.html', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.URL.createObjectURL = () => 'blob://stub';
  window.URL.revokeObjectURL = () => {};
  window.print = () => {};

  await new Promise((r) => setTimeout(r, 80));

  function click(sel) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error('click(): element not found: ' + sel);
    el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('\n== Report engine loaded ==');
  check('DVReportEngine is exposed on window', () => {
    assert.strictEqual(typeof window.DVReportEngine, 'object');
    assert.strictEqual(typeof window.DVReportEngine.composeWorkbook, 'function');
    assert.strictEqual(typeof window.DVReportEngine.composePdfDocument, 'function');
  });

  console.log('\n== Import sample data + a KPI + a chart ==');
  click('#sampleDataBtn');
  await wait(30);
  // Pin a chart to Overview via a real pivot, then add a KPI, so the report has something to include.
  document.querySelector('#pivotRowsWell') && null; // (pivot wells are drag/drop-only in the UI; KPI widget path below is enough to exercise the report payload)
  click('#overviewAddWidgetTile, #emptyOverviewSuggestBtn');
  await wait(10);

  console.log('\n== Excel report modal ==');
  let capturedPayload = null;
  window.DVReportEngine.generateExcelReport = (payload) => { capturedPayload = payload; return Promise.resolve(); };
  window.DVReportEngine.generatePdfReport = (payload) => { capturedPayload = payload; return Promise.resolve(); };

  click('#exportXlsxBtn');
  await wait(10);
  check('report options modal opens with the workbook name pre-filled', () => {
    assert.ok(document.getElementById('reportOptionsModal').classList.contains('open'));
    assert.strictEqual(document.getElementById('reportTitleInput').value, document.getElementById('workbookNameInput').value);
  });

  click('#reportGenerateBtn');
  await wait(20);
  check('generating calls DVReportEngine.generateExcelReport with a well-formed payload', () => {
    assert.ok(capturedPayload, 'expected a captured payload');
    assert.ok(Array.isArray(capturedPayload.fields) && capturedPayload.fields.length > 0);
    assert.ok(Array.isArray(capturedPayload.rows) && capturedPayload.rows.length > 0);
    assert.ok(typeof capturedPayload.filteredRows === 'number' && capturedPayload.filteredRows === capturedPayload.rows.length);
    assert.ok(Array.isArray(capturedPayload.filtersSummary));
    assert.ok('kpis' in capturedPayload && 'charts' in capturedPayload && 'pivot' in capturedPayload);
  });
  check('modal closes after a successful generate', () => {
    assert.ok(!document.getElementById('reportOptionsModal').classList.contains('open'));
  });

  console.log('\n== PDF report modal ==');
  capturedPayload = null;
  click('#exportPdfBtn');
  await wait(10);
  check('PDF variant opens the same modal with a PDF-specific hint', () => {
    assert.ok(document.getElementById('reportOptionsModal').classList.contains('open'));
    assert.ok(document.getElementById('reportOptionsHint').textContent.length > 0);
  });
  click('#reportGenerateBtn');
  await wait(20);
  check('generating calls DVReportEngine.generatePdfReport', () => {
    assert.ok(capturedPayload, 'expected a captured payload for the PDF path');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
