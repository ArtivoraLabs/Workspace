/* ==========================================================================
   DashView — Cloudflare Worker (Free Odoo Proxy)
   ==========================================================================
   Ye Worker browser aur Odoo ke beech baithta hai:
     Browser  →  Cloudflare Worker  →  Odoo /jsonrpc
   
   DEPLOY KARNA (free, 2 minute):
   1. workers.cloudflare.com pe free account banao (no credit card)
   2. "Create Worker" → is poora code paste karo → Save & Deploy
   3. Worker URL copy karo (jaise: https://dashview-proxy.YOUR-NAME.workers.dev)
   4. Dashboard → Settings → Odoo integration → Proxy URL mein paste karo
   
   YE WORKER:
   ✅ Odoo ka API key browser se hide karta hai (server side proxy)
   ✅ CORS handle karta hai
   ✅ Timeout + error handling
   ✅ Bilkul free — Cloudflare Workers free tier = 100,000 req/day
   ✅ No Node.js server needed — GitHub Pages ke saath directly kaam karta hai
   ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
  'Vary':                         'Origin',
  'Cache-Control':                'no-store',
  'X-Content-Type-Options':       'nosniff',
  'Content-Type': 'application/json',
};

/* LOCK-DOWN (optional, recommended before real credentials flow through).
   Set as Worker variables (wrangler.jsonc "vars", or Dashboard → Settings → Variables):
     ALLOWED_ORIGINS     comma-separated, e.g. https://YOU.github.io
     ALLOWED_ODOO_HOSTS  comma-separated, e.g. yourcompany.odoo.com
   Both empty = previous behaviour (any site, any Odoo host). */
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export default {
  async fetch(request, env = {}) {
    const origins = list(env.ALLOWED_ORIGINS), hosts = list(env.ALLOWED_ODOO_HOSTS);
    const origin  = request.headers.get('Origin') || '';
    const blocked = origins.length > 0 && origin !== '' && !origins.includes(origin.toLowerCase());
    const cors    = { ...CORS, 'Access-Control-Allow-Origin': origins.length ? (origin && !blocked ? origin : origins[0]) : '*' };
    const reply   = (data, status = 200) => json(data, status, cors);

    /* ── Preflight ── */
    if (request.method === 'OPTIONS') return new Response(null, { status: blocked ? 403 : 204, headers: cors });
    if (blocked) return reply({ ok: false, error: 'Origin not allowed by this Worker' }, 403);

    if (request.method !== 'POST') return reply({ ok: false, error: 'POST only' }, 405);

    if ((+request.headers.get('content-length') || 0) > 200000) return reply({ ok: false, error: 'Request too large' }, 413);
    let body;
    try { body = await request.json(); }
    catch { return reply({ ok: false, error: 'Invalid JSON body' }, 400); }
    if (!body || typeof body !== 'object') return reply({ ok: false, error: 'Invalid JSON body' }, 400);

    const { url, db, username, apiKey, endpoint } = body;

    /* ── Validate required fields ── */
    const missing = ['url', 'db', 'username', 'apiKey'].filter((k) => !body[k]);
    if (missing.length) {
      return reply({ ok: false, error: 'Missing required field(s): ' + missing.join(', ') }, 400);
    }

    const odooBase = normalizeUrl(url);
    let host;
    try { host = new URL(odooBase).hostname.toLowerCase(); }
    catch { return reply({ ok: false, error: 'Odoo URL is not valid' }, 400); }
    if (hosts.length && !hosts.includes(host)) {
      return reply({ ok: false, error: 'Odoo host not allowed by this Worker: ' + host }, 403);
    }
    const action = (endpoint || 'test').replace(/^\/+/, '');
    const bad = checkArgs(body);
    if (bad) return reply({ ok: false, error: bad }, 400);

    try {
      if (action === 'test')       return reply(await odooTest(odooBase, db, username, apiKey));
      if (action === 'modules')    return reply(await odooModules(odooBase, db, username, apiKey));
      if (action === 'models')     return reply(await odooModels(odooBase, db, username, apiKey, body.module));
      if (action === 'fields')     return reply(await odooFields(odooBase, db, username, apiKey, body.model));
      if (action === 'records')    return reply(await odooRecords(odooBase, db, username, apiKey, body));
      if (action === 'read-group') return reply(await odooReadGroup(odooBase, db, username, apiKey, body));
      return reply({ ok: false, error: 'Unknown endpoint: ' + action }, 404);
    } catch (err) {
      return reply({ ok: false, error: err.message || 'Odoo call failed' }, 502);
    }
  }
};

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
/* --- Input validation (read-only proxy: only these shapes are ever forwarded) --- */
const MODEL_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ORDER_RE = /^[a-z0-9_.:]+( (asc|desc))?(, ?[a-z0-9_.:]+( (asc|desc))?)*$/i;
function checkArgs(b) {
  const names = (a, max) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === 'string' && x.length < 90);
  if (b.model !== undefined && !(typeof b.model === 'string' && b.model.length <= 80 && MODEL_RE.test(b.model))) return 'Invalid model name';
  if (b.module !== undefined && !(typeof b.module === 'string' && /^[a-z0-9_]{1,80}$/.test(b.module))) return 'Invalid module name';
  if (b.domain !== undefined && !Array.isArray(b.domain)) return 'domain must be an array';
  if (b.fields !== undefined && !names(b.fields, 80)) return 'fields must be a list of field names';
  if (b.groupby !== undefined && !names(b.groupby, 3)) return 'groupby must be a list of up to 3 field names';
  for (const k of ['order', 'orderby']) if (b[k] !== undefined && b[k] !== '' && !(typeof b[k] === 'string' && ORDER_RE.test(b[k]))) return 'Invalid ' + k;
  if (b.limit !== undefined && !(Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= 500)) return 'limit must be between 1 and 500';
  if (b.offset !== undefined && !(Number.isInteger(b.offset) && b.offset >= 0 && b.offset <= 1000000)) return 'Invalid offset';
  return '';
}

function json(data, status = 200, headers = CORS) {
  return new Response(JSON.stringify(data), { status, headers });
}
function normalizeUrl(u) {
  u = String(u).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    /* Pasted browser URLs (…/odoo/action-1, …/web#id=5) → site root; JSON-RPC lives at /jsonrpc */
    const p = new URL(u);
    /* Odoo Online / Odoo.sh are https-only; a plain http:// URL just bounces (and a bounced POST becomes a GET → HTTP 400) */
    if (p.protocol === 'http:' && /\.(odoo\.com|odoo\.sh)$/i.test(p.hostname)) p.protocol = 'https:';
    const path = /^\/(web|odoo|jsonrpc)(\/|$)/i.test(p.pathname) ? '' : p.pathname.replace(/\/+$/, '');
    return p.origin + path;
  } catch { return u; }
}

const UA = 'Mozilla/5.0 (compatible; DashView-Proxy/1.0)';

async function rpc(baseUrl, service, method, args, hop = 0) {
  const target = baseUrl + '/jsonrpc';
  const res = await fetch(target, {
    method: 'POST',
    /* Follow redirects ourselves: the default turns a redirected POST into a GET,
       and Odoo answers a GET on /jsonrpc with HTTP 400/405. */
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.random(),
      params: { service, method, args }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('Location');
    if (!loc || hop >= 3) throw new Error('Odoo redirected the request (HTTP ' + res.status + ') and it could not be followed — check the Odoo URL.');
    const next = new URL(loc, target);
    if (next.hostname.toLowerCase() !== new URL(target).hostname.toLowerCase()) {
      throw new Error('Odoo redirected to ' + next.origin + ' — use that address as the Odoo URL.');
    }
    return rpc(next.origin, service, method, args, hop + 1);
  }

  if (!res.ok) {
    let snip = '';
    try { snip = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); } catch {}
    throw new Error('Odoo HTTP ' + res.status + (snip ? ': ' + snip : '') + ' — check the Odoo URL and database name.');
  }
  const data = await res.json();
  if (data.error) throw new Error((data.error.data && data.error.data.message) || data.error.message || 'Odoo RPC error');
  return data.result;
}

/* Logs in; on failure tries to tell you exactly what is wrong (database vs login). */
async function authenticate(base, db, user, key) {
  let uid = null, authErr = null;
  try { uid = await rpc(base, 'common', 'authenticate', [db, user, key, {}]); }
  catch (e) { authErr = e; }
  if (uid) return uid;

  let dbs = null;
  try { dbs = await rpc(base, 'db', 'list', []); } catch { /* disabled on Odoo Online / hardened servers */ }
  if (Array.isArray(dbs) && dbs.length) {
    if (!dbs.includes(db)) throw new Error('Database "' + db + '" not found on this server. Available: ' + dbs.join(', '));
    if (!authErr) throw new Error('Login failed — database "' + db + '" exists, so the username or API key is wrong.');
  }
  if (authErr) throw authErr;
  throw new Error('Authentication failed — check database name, username and API key. (Odoo Online: the database is usually the subdomain, e.g. acme.odoo.com → acme.)');
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
    [ids], { fields: ['name', 'shortdesc', 'application', 'summary'] });
  return {
    ok: true,
    modules: rows.map(r => ({
      technicalName: r.name,
      label: r.shortdesc || r.name,
      isApp: !!r.application,
      summary: r.summary || ''
    }))
  };
}

/* NEW: list data models exposed by a specific installed module */
async function odooModels(base, db, user, key, moduleName) {
  if (!moduleName) throw new Error('module is required');
  const uid = await authenticate(base, db, user, key);
  /* Models defined by this module (ir.model.data xml-ids), then a technical-name prefix. Never "all models". */
  let modelIds = [];
  try {
    const data = await exKw(base, db, key, uid, 'ir.model.data', 'search_read',
      [[['module', '=', moduleName], ['model', '=', 'ir.model']]], { fields: ['res_id'], limit: 300 });
    modelIds = data.map((d) => d.res_id).filter(Boolean);
  } catch (e) { modelIds = []; }
  if (!modelIds.length) {
    const prefix = moduleName.replace(/_/g, '.').split('.')[0];
    modelIds = await exKw(base, db, key, uid, 'ir.model', 'search',
      [[['model', '=like', prefix + '.%'], ['transient', '=', false]]], { limit: 80 });
  }
  const rows = await exKw(base, db, key, uid, 'ir.model', 'read',
    [modelIds], { fields: ['model', 'name', 'transient'] });
  const models = rows
    .filter(r => !r.transient)
    .map(r => ({ model: r.model, label: r.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { ok: true, models };
}

async function odooFields(base, db, user, key, model) {
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const fields = await exKw(base, db, key, uid, model, 'fields_get',
    [], { attributes: ['string', 'type', 'required', 'selection', 'relation'] });
  return { ok: true, fields };
}

async function odooRecords(base, db, user, key, body) {
  const { model, domain, fields, limit, offset, order } = body;
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const kwargs = {
    fields: fields && fields.length ? fields : undefined,
    limit: limit || 25,
    offset: offset || 0,
    order: order || undefined
  };
  const [rows, total] = await Promise.all([
    exKw(base, db, key, uid, model, 'search_read', [domain || []], kwargs),
    exKw(base, db, key, uid, model, 'search_count', [domain || []])
  ]);
  return { ok: true, model, rows, total };
}

async function odooReadGroup(base, db, user, key, body) {
  const { model, domain, fields, groupby, orderby, limit } = body;
  if (!model) throw new Error('model is required');
  const uid = await authenticate(base, db, user, key);
  const kw = { lazy: false };
  if (orderby) kw.orderby = orderby;
  if (limit) kw.limit = limit;
  const result = await exKw(base, db, key, uid, model, 'read_group',
    [domain || [], fields && fields.length ? fields : ['__count'], groupby || []], kw);
  return { ok: true, model, groups: result };
}
