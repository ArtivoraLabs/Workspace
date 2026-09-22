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

  function summarizeRows(label, res) {
    if (!res || !res.rows || !res.rows.length) return label + ': none found.';
    var fields = res.fields || [];
    var lines = res.rows.slice(0, 8).map(function (row) {
      return '  - ' + fields.map(function (f, i) { return f + ': ' + row[i]; }).join(', ');
    });
    var totalNote = (res.total != null && res.total > res.rows.length) ? ' (showing ' + res.rows.length + ' of ' + res.total + ')' : '';
    return label + totalNote + ':\n' + lines.join('\n');
  }

  function odooContext() {
    if (!window.DVOdoo || !window.DVOdoo.isConnected()) return Promise.resolve('');
    var fetchers = [
      { model: 'sale.order', label: 'Recent sales orders' },
      { model: 'product.template', label: 'Products' },
      { model: 'res.partner', label: 'Customers' },
      { model: 'crm.lead', label: 'CRM leads' }
    ];
    var jobs = fetchers.map(function (f) {
      return window.DVOdoo.fetchModel(f.model, { limit: 8 })
        .then(function (r) { return summarizeRows(f.label, r); })
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
      var text = parts.length
        ? 'Company / workspace context (background only — use this to answer questions about the user\'s company, projects and Odoo data; only mention specifics when the question calls for them, and don\'t assume data that isn\'t listed here):\n\n' + parts.join('\n\n')
        : '';
      cache = { text: text, at: Date.now() };
      return text;
    });
  }

  window.DVAICompanyContext = { build: build };
})();
