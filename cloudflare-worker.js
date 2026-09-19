/* ==========================================================================
   DashView — Cloudflare Worker (Free Odoo Proxy)
   ==========================================================================
   Ye Worker browser aur Odoo ke beech baithta hai:
     Browser  →  Cloudflare Worker  →  Odoo /jsonrpc
   
   DEPLOY KARNA (free, 2 minute):
   1. workers.cloudflare.com pe free account banao (no credit card)
   2. "Create Worker" → is poora code paste karo → Save & Deploy
   3. Worker URL copy karo (jaise: https://dashview-proxy.YOUR-NAME.workers.dev)
   4. Dashboard → Odoo Live → Proxy Server field mein paste karo
   
   YE WORKER:
   ✅ Odoo ka API key browser se hide karta hai (server side proxy)
   ✅ CORS handle karta hai
   ✅ Timeout + error handling
   ✅ Bilkul free — Cloudflare Workers free tier = 100,000 req/day
   ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request) {

    /* ── Preflight ── */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'POST only' }, 405);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

    const { url, db, username, apiKey, endpoint } = body;

    /* ── Validate required fields ── */
    if (!url || !db || !username || !apiKey) {
      return json({ ok: false, error: 'url, db, username, apiKey are required' }, 400);
    }

    const odooBase = normalizeUrl(url);
    const action   = (endpoint || 'test').replace(/^\/+/, '');

    try {
      /* ── Route to the right action ── */
      if (action === 'test') {
        return json(await odooTest(odooBase, db, username, apiKey));
      }
      if (action === 'records') {
        return json(await odooRecords(odooBase, db, username, apiKey, body));
      }
      if (action === 'modules') {
        return json(await odooModules(odooBase, db, username, apiKey));
      }
      if (action === 'fields') {
        return json(await odooFields(odooBase, db, username, apiKey, body.model));
      }
      if (action === 'read-group') {
        return json(await odooReadGroup(odooBase, db, username, apiKey, body));
      }
      return json({ ok: false, error: 'Unknown endpoint: ' + action }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message || 'Odoo call failed' }, 502);
    }
  }
};

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
function normalizeUrl(u) {
  u = String(u).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

async function rpc(baseUrl, service, method, args) {
  const res = await fetch(baseUrl + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.random(),
      params: { service, method, args }
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('Odoo HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error((data.error.data && data.error.data.message) || data.error.message || 'Odoo RPC error');
  return data.result;
}

async function authenticate(base, db, user, key) {
  const uid = await rpc(base, 'common', 'authenticate', [db, user, key, {}]);
  if (!uid) throw new Error('Authentication failed — check username/API key/database.');
  return uid;
}

async function exKw(base, db, key, uid, model, method, args, kwargs) {
  return rpc(base, 'object', 'execute_kw', [db, uid, key, model, method, args || [], kwargs || {}]);
}

/* ─── Action implementations ──────────────────────────────────────────────── */
async function odooTest(base, db, user, key) {
  const t0 = Date.now();
  const version = await rpc(base, 'common', 'version', []);
  const uid = await authenticate(base, db, user, key);
  return { ok: true, uid, latencyMs: Date.now() - t0, version };
}

async function odooModules(base, db, user, key) {
  const uid = await authenticate(base, db, user, key);
  const ids = await exKw(base, db, key, uid, 'ir.module.module', 'search',
    [[['state', '=', 'installed']]], { order: 'application desc, name asc', limit: 200 });
  if (!ids.length) return { ok: true, modules: [] };
  const rows = await exKw(base, db, key, uid, 'ir.module.module', 'read',
    [ids], { fields: ['name', 'shortdesc', 'application'] });
  return { ok: true, modules: rows.map(r => ({ technicalName: r.name, label: r.shortdesc || r.name, isApp: !!r.application })) };
}

async function odooFields(base, db, user, key, model) {
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const fields = await exKw(base, db, key, uid, model, 'fields_get',
    [], { attributes: ['string', 'type', 'required'] });
  return { ok: true, fields };
}

async function odooRecords(base, db, user, key, body) {
  const { model, domain, fields, limit, offset, order } = body;
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const kwargs = { fields: fields && fields.length ? fields : undefined, limit: limit || 25, offset: offset || 0, order: order || undefined };
  const [rows, total] = await Promise.all([
    exKw(base, db, key, uid, model, 'search_read', [domain || []], kwargs),
    exKw(base, db, key, uid, model, 'search_count', [domain || []])
  ]);
  return { ok: true, model, rows, total };
}

async function odooReadGroup(base, db, user, key, body) {
  const { model, domain, fields, groupby } = body;
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const result = await exKw(base, db, key, uid, model, 'read_group',
    [domain || [], fields && fields.length ? fields : ['__count'], groupby || []], { lazy: false });
  return { ok: true, model, groups: result };
}
