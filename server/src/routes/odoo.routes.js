/* ==========================================================================
   DashView — live Odoo proxy routes
   ==========================================================================
   Browsers can't call Odoo's /jsonrpc directly with a stored API key
   without exposing that key, so every one of these routes re-proxies the
   request to the real Odoo instance server-side, per request. Credentials
   are taken from the request body (or the x-odoo-* headers) and are never
   written to DashView's own database.

   Mount point (see index.js): /api/odoo
   ========================================================================== */
const express = require('express');
const odoo = require('../services/odooClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every Odoo route needs a signed-in DashView user (org-level admin/owner
// gate is enforced client-side today via the "manageOdoo" permission; add a
// server-side role check here too before shipping this to production).
router.use(requireAuth);

function readCfg(req) {
  const b = req.body || {};
  return {
    url: b.url || req.headers['x-odoo-url'],
    db: b.db || req.headers['x-odoo-db'],
    username: b.username || req.headers['x-odoo-user'],
    apiKey: b.apiKey || req.headers['x-odoo-key']
  };
}

function handle(res, promise) {
  return promise.catch(err => {
    const status = err.status || 500;
    res.status(status).json({ ok: false, error: err.message || 'Odoo request failed' });
  });
}

// POST /api/odoo/test — real auth + version round trip
router.post('/test', (req, res) => {
  const cfg = readCfg(req);
  handle(res, odoo.testConnection(cfg).then(r => res.json({ ok: true, ...r })));
});

// POST /api/odoo/modules — every installed app/module, live
router.post('/modules', (req, res) => {
  const cfg = readCfg(req);
  handle(res, odoo.listInstalledModules(cfg).then(modules => res.json({ ok: true, modules })));
});

// POST /api/odoo/models — data models exposed by one module, live
router.post('/models', (req, res) => {
  const cfg = readCfg(req);
  const moduleTechnicalName = req.body.module;
  if (!moduleTechnicalName) return res.status(400).json({ ok: false, error: 'module is required' });
  handle(res, odoo.listModelsForModule(cfg, moduleTechnicalName).then(models => res.json({ ok: true, models })));
});

// POST /api/odoo/fields — field metadata for a model, live (builds filters/columns)
router.post('/fields', (req, res) => {
  const cfg = readCfg(req);
  const model = req.body.model;
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
  handle(res, odoo.getFields(cfg, model).then(fields => res.json({ ok: true, fields })));
});

// POST /api/odoo/records — search_read with a filter domain, live, paginated
router.post('/records', (req, res) => {
  const cfg = readCfg(req);
  const { model, domain, fields, limit, offset, order } = req.body || {};
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
  handle(res, odoo.searchRead(cfg, model, { domain, fields, limit, offset, order })
    .then(r => res.json({ ok: true, model, ...r })));
});

module.exports = router;
