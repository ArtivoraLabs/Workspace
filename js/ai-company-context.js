/* ==========================================================================
   DashView — Company context for the AI Assistant
   --------------------------------------------------------------------------
   Builds a short, factual briefing out of data already sitting in this
   browser: the dashboard's tracked projects / GitHub connection, plus live
   Odoo records when Odoo is connected (Settings → Odoo). This text is
   folded into the AI's system prompt so questions like "how many open sales
   orders do we have?" or "what's in our product catalog?" get answered from
   real data instead of guessed — as long as "Include company context" is
   left on in Settings → AI Assistant.

   Nothing here is fetched or sent anywhere except to the AI provider you
   configure, as part of the request you're already sending it.

   Exposes window.DVAICompanyContext.build({ force }) → Promise<string>
   ========================================================================== */
(function () {
  'use strict';

  var CACHE_MS = 2 * 60 * 1000;
  var cache = { text: '', at: 0 };

  function dashboardContext() {
    var parts = [];
    try {
      var gh = JSON.parse(localStorage.getItem('al_github_connection') || 'null');
      if (gh && gh.login) parts.push('GitHub account/org connected to the dashboard: "' + gh.login + '".');
    } catch (e) {}
    try {
      var own = JSON.parse(localStorage.getItem('al_own_projects') || '[]');
      if (own.length) {
        var list = own.slice(0, 8).map(function (p) {
          var stats = p.stats || {};
          return '- "' + p.title + '" (#' + p.number + ', ' + (stats.open || 0) + ' open / ' + (stats.closed || 0) + ' closed, ' + (stats.pct || 0) + '% complete)';
        }).join('\n');
        parts.push('Tracked projects on the dashboard:\n' + list);
      }
    } catch (e) {}
    return parts.join('\n\n');
  }

  // Pulls the first number out of a formatted field like "$12,430.00" or
  // "PKR 4,200" so small totals/averages can be computed client-side —
  // more reliable than asking the model to add up formatted strings itself.
  function parseNumber(v) {
    if (v == null || v === '—') return null;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }

  function fmtMoney(n) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function summarizeRows(label, res, sumField) {
    if (!res || !res.rows || !res.rows.length) return label + ': none found.';
    var fields = res.fields || [];
    var total = res.total != null ? res.total : res.rows.length;

    var aggLine = '';
    if (sumField) {
      var idx = fields.indexOf(sumField);
      if (idx > -1) {
        var sum = 0, counted = 0;
        res.rows.forEach(function (row) {
          var n = parseNumber(row[idx]);
          if (n != null) { sum += n; counted++; }
        });
        if (counted) aggLine = '  Computed from the ' + counted + ' shown: sum of ' + sumField + ' = ' + fmtMoney(sum) + ', average = ' + fmtMoney(sum / counted) + '.\n';
      }
    }

    var lines = res.rows.slice(0, 8).map(function (row) {
      return '  - ' + fields.map(function (f, i) { return f + ': ' + row[i]; }).join(', ');
    });
    var totalNote = total > res.rows.length ? ' (' + total + ' total, showing ' + res.rows.length + ')' : ' (' + total + ' total)';
    return label + totalNote + ':\n' + aggLine + lines.join('\n');
  }

  var SUM_FIELD = { 'sale.order': 'Total', 'crm.lead': 'Expected Revenue' };

  function odooContext() {
    if (!window.DVOdoo || !window.DVOdoo.isConnected()) return Promise.resolve('');
    var fetchers = [
      { model: 'sale.order', label: 'Recent sales orders' },
      { model: 'product.template', label: 'Products' },
      { model: 'res.partner', label: 'Customers' },
      { model: 'crm.lead', label: 'CRM leads' }
    ];
    var jobs = fetchers.map(function (f) {
      return window.DVOdoo.fetchModel(f.model, { limit: 15 })
        .then(function (r) { return summarizeRows(f.label, r, SUM_FIELD[f.model]); })
        .catch(function () { return ''; });
    });
    return Promise.all(jobs).then(function (blocks) {
      var body = blocks.filter(Boolean).join('\n\n');
      if (!body) return '';
      var cfg = window.DVOdoo.getConfig();
      return 'Live data from the connected Odoo instance (' + (cfg.url || 'Odoo') + '):\n\n' + body;
    });
  }

  function build(opts) {
    opts = opts || {};
    if (!opts.force && cache.text && (Date.now() - cache.at) < CACHE_MS) {
      return Promise.resolve(cache.text);
    }
    return odooContext().then(function (odoo) {
      var parts = [dashboardContext(), odoo].filter(Boolean);
      if (!parts.length) { cache = { text: '', at: Date.now() }; return ''; }
      var instructions = odoo
        ? 'When the user asks about their company, sales, products, customers or leads, answer like a short analyst report, not a data dump: open with the headline number(s) they care about, note the computed sums/averages above where relevant, call out anything notable (a top customer, a stalled lead, a low-margin product), and end with one concrete next step or recommendation. Use the exact figures given — never invent numbers that aren\'t in this context — and say plainly if something wasn\'t in the sample shown.'
        : 'Background only — mention specifics from it only if the question calls for them.';
      var text = 'Company / workspace context:\n\n' + parts.join('\n\n') + '\n\n' + instructions;
      cache = { text: text, at: Date.now() };
      return text;
    });
  }

  window.DVAICompanyContext = { build: build };
})();
