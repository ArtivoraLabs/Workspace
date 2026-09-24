// Verifies the ```chart (bar/line/donut) and ```kpi renderers in ai.html and js/ai-embed.js.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(' ok  ', name); } else { fail++; console.log(' FAIL', name); } };

function load(file, ctxEsc) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const a = src.indexOf('function renderChartBlock(raw)');
  const b = src.indexOf('function renderMarkdown', a);
  const code = src.slice(a, b) + '\nreturn { R: renderChartBlock, K: renderKpiBlock };';
  return new Function('esc', code)(ctxEsc);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

for (const [file, e] of [['ai.html', esc], ['js/ai-embed.js', (s) => s]]) {
  const { R, K } = load(file, e);
  ok(file + ': bar chart', /ai-chart-bar-fill/.test(R('Top\nA: 5\nB: 3')));
  ok(file + ': line chart', /ai-chart-line/.test(R('type: line\nTrend\nJul: 1\nAug: 3\nSep: 2')));
  ok(file + ': donut chart', /conic-gradient/.test(R('type: donut\nMix\nA: 30\nB: 70')));
  ok(file + ': <2 rows falls through', R('type: line\nonly: 1') === null);
  const k = K('Sales: PKR 1.2M | +12%\nOverdue: 340K | -3%');
  ok(file + ': kpi cards + colour', /ai-kpi-delta up/.test(k) && /ai-kpi-delta down/.test(k));
}
ok('ai.html escapes labels', !/<script/.test(load('ai.html', esc).R('T\n<script>x: 5\nB: 2')));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
