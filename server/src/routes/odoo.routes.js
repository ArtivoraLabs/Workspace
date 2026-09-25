/* ==========================================================================
   DashView — live Odoo proxy routes
   ==========================================================================
   Browsers can't call Odoo's /jsonrpc directly without exposing the API key,
   so every route proxies the request to the real Odoo instance server-side,
   per request.  Credentials come from the request body (or x-odoo-* headers)
   and are never written to DashView's own database.

   Connectivity hardening (v2):
   ─────────────────────────────
   • The client now caches Odoo UIDs (55 min TTL) — no redundant auth calls.
   • Transient failures are retried with exponential back-off before failing.
   • A per-host circuit breaker opens after 5 consecutive failures and
     returns 503 immediately during the 30-second cooldown window.
   • GET /api/odoo/diagnostics returns cache + breaker state for monitoring.

   Mount point (see index.js): /api/odoo
   ========================================================================== */
'use strict';

const express = require('express');
const odoo    = require('../services/odooClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All Odoo routes require a signed-in DashView user.
// TODO (pre-production): add a server-side role check here so only
//   admin/owner roles can call these routes (client-side gating today).
router.use(requireAuth);

// ── credential extraction ─────────────────────────────────────────────────────
function readCfg(req) {
  const b = req.body || {};
  const cfg = {
    url:      b.url      || req.headers['x-odoo-url'],
    db:       b.db       || req.headers['x-odoo-db'],
    username: b.username || req.headers['x-odoo-user'],
    apiKey:   b.apiKey   || req.headers['x-odoo-key'],
  };
  if (!cfg.url || !cfg.db || !cfg.username || !cfg.apiKey) {
    throw Object.assign(
      new odoo.OdooError('Missing Odoo credentials (url, db, username, apiKey).', 400),
    );
  }
  return cfg;
}

// ── uniform error handler ─────────────────────────────────────────────────────
function handle(res, promise) {
  return promise.catch(err => {
    const status  = err.status || 500;
    const message = err.message || 'Odoo request failed';
    console.error(`[OdooRoute] ${status} — ${message}`);
    res.status(status).json({ ok: false, error: message });
  });
}

// ── routes ────────────────────────────────────────────────────────────────────

// POST /api/odoo/test — real auth + version round trip
router.post('/test', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  handle(res, odoo.testConnection(cfg).then(r => res.json({ ok: true, ...r })));
});

// POST /api/odoo/modules — every installed app/module, live
router.post('/modules', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  handle(res, odoo.listInstalledModules(cfg).then(modules => res.json({ ok: true, modules })));
});

// POST /api/odoo/models — data models exposed by one module, live
router.post('/models', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const moduleTechnicalName = (req.body || {}).module;
  if (!moduleTechnicalName) return res.status(400).json({ ok: false, error: 'module is required' });
  handle(res, odoo.listModelsForModule(cfg, moduleTechnicalName).then(models => res.json({ ok: true, models })));
});

// POST /api/odoo/fields — field metadata for a model (builds filter controls)
router.post('/fields', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const model = (req.body || {}).model;
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
  handle(res, odoo.getFields(cfg, model).then(fields => res.json({ ok: true, fields })));
});

// POST /api/odoo/records — search_read with optional domain, paginated
router.post('/records', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const { model, domain, fields, limit, offset, order } = req.body || {};
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
  handle(res, odoo.searchRead(cfg, model, { domain, fields, limit, offset, order })
    .then(r => res.json({ ok: true, model, ...r })));
});

// POST /api/odoo/read-group — live aggregated totals (executive KPI cards)
// e.g. { model: 'sale.order', fields: ['amount_total:sum'], groupby: ['stage_id'] }
router.post('/read-group', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const { model, domain, fields, groupby } = req.body || {};
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
  handle(res, odoo.readGroup(cfg, model, { domain, fields, groupby })
    .then(groups => res.json({ ok: true, model, groups })));
});

// GET /api/odoo/diagnostics — UID cache + circuit breaker state (no credentials needed)
router.get('/diagnostics', (req, res) => {
  res.json({ ok: true, ...odoo.diagnostics() });
});

// POST /api/odoo/flush-uid — force re-authentication for a credential set
//   (use after rotating an API key so the stale UID is evicted immediately)
router.post('/flush-uid', (req, res) => {
  let cfg;
  try { cfg = readCfg(req); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  odoo.flushUid(cfg);
  res.json({ ok: true, message: 'UID cache cleared for this credential set.' });
});

module.exports = router;
