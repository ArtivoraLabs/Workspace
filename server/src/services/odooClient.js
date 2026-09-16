/* ==========================================================================
   DashView — real Odoo JSON-RPC client
   ==========================================================================
   This is the production counterpart to js/odoo-service.js's mock. It makes
   genuine HTTP calls to a live Odoo instance's /jsonrpc endpoint (Odoo
   Online, Odoo.sh, or self-hosted — same standard API). Nothing here is
   canned data.

   Credentials never touch a database: the caller (odoo.routes.js) passes
   {url, db, username, apiKey} through on every request and this module
   proxies straight to that Odoo instance, per-request, stateless.
   ========================================================================== */
'use strict';

const RPC_TIMEOUT_MS = 15000;

class OdooError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

function normalizeUrl(url) {
  if (!url) throw new OdooError('Odoo URL is required', 400);
  let u = String(url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

async function rpcCall(baseUrl, service, method, args) {
  const endpoint = normalizeUrl(baseUrl) + '/jsonrpc';
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service, method, args },
    id: Math.floor(Math.random() * 1e9)
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new OdooError('Odoo did not respond in time (timeout).', 504);
    throw new OdooError('Could not reach Odoo at ' + endpoint + ' — check the URL and network access.', 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new OdooError('Odoo responded with HTTP ' + res.status, 502);

  let json;
  try { json = await res.json(); } catch (e) { throw new OdooError('Odoo returned a non-JSON response.', 502); }

  if (json.error) {
    const data = json.error.data || {};
    throw new OdooError(data.message || json.error.message || 'Odoo RPC error', 400);
  }
  return json.result;
}

/** Authenticates and returns the numeric uid, or throws. */
async function authenticate({ url, db, username, apiKey }) {
  if (!url || !db) throw new OdooError('URL and database are required.', 400);
  if (!username || !apiKey) throw new OdooError('Username and API key are required.', 400);
  const uid = await rpcCall(url, 'common', 'authenticate', [db, username, apiKey, {}]);
  if (!uid) throw new OdooError('Authentication failed — check username/API key/database.', 401);
  return uid;
}

async function executeKw(cfg, uid, model, method, args, kwargs) {
  return rpcCall(cfg.url, 'object', 'execute_kw', [
    cfg.db, uid, cfg.apiKey, model, method, args || [], kwargs || {}
  ]);
}

/** Full round trip test: auth + version. */
async function testConnection(cfg) {
  const started = Date.now();
  const version = await rpcCall(cfg.url, 'common', 'version', []);
  const uid = await authenticate(cfg);
  return { uid, version, latencyMs: Date.now() - started };
}

/** Live list of installed apps/modules (ir.module.module, state=installed). */
async function listInstalledModules(cfg) {
  const uid = await authenticate(cfg);
  const ids = await executeKw(cfg, uid, 'ir.module.module', 'search',
    [[['state', '=', 'installed']]], { order: 'application desc, name asc' });
  if (!ids.length) return [];
  const rows = await executeKw(cfg, uid, 'ir.module.module', 'read',
    [ids], { fields: ['name', 'shortdesc', 'application', 'icon', 'summary'] });
  return rows.map(r => ({
    technicalName: r.name,
    label: r.shortdesc || r.name,
    isApp: !!r.application,
    summary: r.summary || ''
  }));
}

/** Live list of data models exposed by a given module (ir.model). */
async function listModelsForModule(cfg, moduleTechnicalName) {
  const uid = await authenticate(cfg);
  // ir.model.data links model records to the module that defines them.
  const modelDataIds = await executeKw(cfg, uid, 'ir.model.data', 'search',
    [[['module', '=', moduleTechnicalName], ['model', '=', 'ir.model.fields']]], { limit: 0 });
  // Simpler, robust approach: ir.model rows whose modules field contains it,
  // fall back to a name-prefix heuristic if the modules field isn't stored.
  let modelIds;
  try {
    modelIds = await executeKw(cfg, uid, 'ir.model', 'search',
      [[['modules', 'like', moduleTechnicalName]]], { limit: 200 });
  } catch (e) {
    modelIds = [];
  }
  if (!modelIds.length) {
    modelIds = await executeKw(cfg, uid, 'ir.model', 'search', [[]], { limit: 200 });
  }
  const rows = await executeKw(cfg, uid, 'ir.model', 'read',
    [modelIds], { fields: ['model', 'name', 'transient'] });
  return rows
    .filter(r => !r.transient)
    .map(r => ({ model: r.model, label: r.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Live field metadata for a model, used to build filter controls + columns. */
async function getFields(cfg, model) {
  const uid = await authenticate(cfg);
  const fields = await executeKw(cfg, uid, model, 'fields_get',
    [], { attributes: ['string', 'type', 'required', 'selection', 'relation'] });
  return fields;
}

/** Live records via search_read, with an optional domain (filters). */
async function searchRead(cfg, model, { domain, fields, limit, offset, order }) {
  const uid = await authenticate(cfg);
  const kwargs = {
    fields: fields && fields.length ? fields : undefined,
    limit: limit || 25,
    offset: offset || 0,
    order: order || undefined
  };
  const [rows, total] = await Promise.all([
    executeKw(cfg, uid, model, 'search_read', [domain || []], kwargs),
    executeKw(cfg, uid, model, 'search_count', [domain || []])
  ]);
  return { rows, total };
}

module.exports = {
  OdooError,
  authenticate,
  testConnection,
  listInstalledModules,
  listModelsForModule,
  getFields,
  searchRead
};
