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

  var SUM_FIELD = {
    'sale.order': 'Total', 'crm.lead': 'Expected Revenue',
    'account.move': 'Total', 'purchase.order': 'Total'
  };

  // Row-level samples — good for "show me / list" style questions. Covers
  // sales, purchasing, inventory, accounting, CRM, HR and projects so
  // "fetch every kind of data" questions have something real to draw on.
  // Modules the Odoo instance doesn't have installed just come back empty
  // (caught below) — harmless.
  var fetchers = [
    { model: 'sale.order', label: 'Recent sales orders' },
    { model: 'product.template', label: 'Products' },
    { model: 'res.partner', label: 'Customers' },
    { model: 'crm.lead', label: 'CRM leads' },
    { model: 'account.move', label: 'Recent invoices / bills' },
    { model: 'purchase.order', label: 'Recent purchase orders' },
    { model: 'stock.picking', label: 'Recent inventory transfers' },
    { model: 'hr.employee', label: 'Employees' },
    { model: 'project.task', label: 'Project tasks' },
    { model: 'hr.expense', label: 'Recent expenses' }
  ];

  // Aggregate breakdowns via read_group — good for reporting/"sales-wise"
  // questions (totals by stage, by salesperson, top performers) without
  // dumping raw rows. Each entry -> one read_group call, summarized as text.
  // orderby + limit let us pull ranked "Top N" breakdowns directly from
  // Odoo instead of sorting client-side.
  var aggregates = [
    { model: 'sale.order', label: 'Sales orders by stage', groupby: ['state'], fields: ['amount_total:sum'] },
    { model: 'sale.order', label: 'Sales by salesperson', groupby: ['user_id'], fields: ['amount_total:sum'], orderby: 'amount_total desc' },
    { model: 'sale.order', label: 'Top 5 customers by revenue', groupby: ['partner_id'], fields: ['amount_total:sum'], orderby: 'amount_total desc', limit: 5 },
    { model: 'sale.order.line', label: 'Top 5 products by revenue', groupby: ['product_id'], fields: ['price_subtotal:sum'], orderby: 'price_subtotal desc', limit: 5 },
    { model: 'crm.lead', label: 'CRM leads by stage', groupby: ['stage_id'], fields: ['expected_revenue:sum'] }
  ];

  function isoDate(daysAgo) {
    var d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  // Targeted, filtered queries that surface data-quality problems and
  // process glitches directly from Odoo — not guessed, not computed from
  // truncated sample rows. Each becomes its own "⚠️" block in the context
  // so the AI can point at real broken/stuck records with IDs and names.
  var issueFetchers = [
    {
      model: 'account.move', label: '⚠️ Overdue unpaid invoices',
      domain: [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'],
               ['payment_state', 'not in', ['paid', 'in_payment', 'reversed']],
               ['invoice_date_due', '<', isoDate(0)]]
    },
    {
      model: 'sale.order', label: '⚠️ Sales orders stuck in Draft/Quotation 14+ days',
      domain: [['state', 'in', ['draft', 'sent']], ['create_date', '<', isoDate(14)]]
    },
    {
      model: 'purchase.order', label: '⚠️ Purchase orders stuck in Draft 14+ days',
      domain: [['state', '=', 'draft'], ['create_date', '<', isoDate(14)]]
    },
    {
      model: 'crm.lead', label: '⚠️ CRM leads stalled 30+ days with no progress',
      domain: [['active', '=', true], ['probability', '<', 100], ['create_date', '<', isoDate(30)]]
    },
    {
      model: 'stock.quant', label: '⚠️ Products with negative stock (data error)',
      domain: [['quantity', '<', 0]]
    }
  ];

  function fmtGroupVal(v) {
    if (v == null || v === false) return '—';
    return Array.isArray(v) ? (v[1] || v[0]) : String(v);
  }

  function summarizeGroups(label, groupField, res) {
    if (!res || !res.groups || !res.groups.length) return '';
    var lines = res.groups.slice(0, 12).map(function (g) {
      var key = fmtGroupVal(g[groupField]);
      var count = g.__count != null ? g.__count : '';
      var extra = Object.keys(g).filter(function (k) {
        return k !== groupField && k !== '__count' && k !== '__domain';
      }).map(function (k) { return k + '=' + g[k]; }).join(', ');
      return '  - ' + key + (count !== '' ? ' (' + count + ' records' + (extra ? ', ' + extra : '') + ')' : (extra ? ' — ' + extra : ''));
    });
    return label + ':\n' + lines.join('\n');
  }

  function odooContext() {
    if (!window.DVOdoo || !window.DVOdoo.isConnected()) return Promise.resolve('');

    var rowJobs = fetchers.map(function (f) {
      return window.DVOdoo.fetchModel(f.model, { limit: 15 })
        .then(function (r) { return summarizeRows(f.label, r, SUM_FIELD[f.model]); })
        .catch(function () { return ''; });
    });

    var aggJobs = (window.DVOdoo.fetchReadGroup ? aggregates : []).map(function (a) {
      return window.DVOdoo.fetchReadGroup(a.model, {
        groupby: a.groupby, fields: a.fields.concat(['__count']),
        orderby: a.orderby, limit: a.limit
      })
        .then(function (r) { return summarizeGroups(a.label, a.groupby[0], r); })
        .catch(function () { return ''; });
    });

    // Issue-detection queries run last and are labelled separately so they
    // land in their own "flagged" section below, distinct from normal data.
    var issueJobs = issueFetchers.map(function (f) {
      return window.DVOdoo.fetchModel(f.model, { limit: 10, domain: f.domain })
        .then(function (r) {
          if (!r || !r.rows || !r.rows.length) return f.label + ': none found — looks clean.';
          return summarizeRows(f.label, r, SUM_FIELD[f.model]);
        })
        .catch(function () { return ''; }); // model/module not installed, or field not present on this DB
    });

    return Promise.all([Promise.all(rowJobs.concat(aggJobs)), Promise.all(issueJobs)])
      .then(function (results) {
        var body = results[0].filter(Boolean).join('\n\n');
        var issuesBody = results[1].filter(Boolean).join('\n\n');
        if (!body && !issuesBody) return '';
        var cfg = window.DVOdoo.getConfig();
        var out = 'Live data from the connected Odoo instance (' + (cfg.url || 'Odoo') + '):\n\n' + body;
        if (issuesBody) {
          out += '\n\n--- Automated data-quality / process checks (filtered queries, not raw samples) ---\n\n' + issuesBody;
        }
        return out;
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
        ? 'You are a business analyst presenting to company leadership — answer like a dashboard, not a chat reply. Rules:\n' +
          '1. Open with 1-3 headline KPI numbers relevant to the question (e.g. total revenue, order count, average deal size) as a short bold line — not buried in a paragraph.\n' +
          '2. Whenever the question is about sales, revenue, customers or products, include a "Top 5 Customers" and/or "Top 5 Products" table if that data is available above — use real Markdown tables (header row, |---|---| separator row, data rows), ranked by revenue, columns like Rank | Name | Revenue | Orders. Never invent ranks or numbers that are not in the context — use exactly what is given, and if there are fewer than 5, show what is available.\n' +
          '3. Follow the table(s) with a short "Insights" section (2-4 bullet points) calling out what is notable: a top/at-risk customer, a best-selling or low-margin product, a stage where deals are stuck, a trend.\n' +
          '4. End with a "Recommended next step / strategy" section (1-3 bullet points) — a concrete, prioritized action for this period, not generic advice.\n' +
          '5. Use the exact figures given in the context above — never invent numbers — and say plainly if something wasn\'t in the sample/range shown.\n' +
          '6. For non-analytical questions (a lookup, a yes/no, a how-to), skip this structure and just answer directly and concisely.\n' +
          '7. If the user asks about mistakes, errors, glitches, problems or "what\'s wrong", OR if the "Automated data-quality / process checks" block above lists anything other than "none found", always add a "⚠️ Issues Found" section, one entry per problem, each with exactly three parts: **Issue** (what and how many, naming real records/customers/products from the data — never vague), **Why it matters** (the business impact in one line), **Fix** (a specific, actionable step — who should do what). If every checked area came back "none found", say plainly "No data-quality issues detected in the areas checked" instead of inventing one — do not pad the answer with a fake issue.'
        : 'Background only — mention specifics from it only if the question calls for them.';
      var text = 'Company / workspace context:\n\n' + parts.join('\n\n') + '\n\n' + instructions;
      cache = { text: text, at: Date.now() };
      return text;
    });
  }

  window.DVAICompanyContext = { build: build };
})();
