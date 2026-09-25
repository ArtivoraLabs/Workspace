/* ==========================================================================
   DashView — production Odoo JSON-RPC client
   ==========================================================================
   Genuine HTTP calls to a live Odoo instance's /jsonrpc endpoint (Odoo
   Online, Odoo.sh, or self-hosted).  Nothing here is canned data.

   Improvements over v1:
   ─────────────────────
   • UID caching  — authenticate() result is reused for 55 min per
     credential fingerprint instead of re-authenticating on every request.
   • Retry logic  — transient network errors and timeouts are retried up
     to 3 times with exponential back-off (400 ms / 800 ms / 1 600 ms).
   • Circuit breaker — after BREAKER_THRESHOLD consecutive failures to the
     same host the client suspends calls for BREAKER_COOLDOWN_MS and
     returns a 503 immediately, preventing log floods and thundering-herds
     during Odoo downtime.
   • Keep-alive  — 'Connection: keep-alive' header is sent so the node
     runtime can reuse TCP sockets for bursts of calls to the same host.
   • Parallel where possible — searchRead fetches rows + count in one
     Promise.all; testConnection issues version + auth concurrently.
   • Cache invalidation — a 401 from Odoo (bad UID) invalidates the cached
     entry and retries the auth once before surfacing the error.

   Credentials never touch a database: the caller (odoo.routes.js) passes
   {url, db, username, apiKey} through on every request, per-request, stateless.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

// ── tunables ──────────────────────────────────────────────────────────────────
const RPC_TIMEOUT_MS       = 20_000;   // per single attempt
const RETRY_DELAYS_MS      = [400, 800, 1_600];   // exponential back-off
const UID_TTL_MS           = 55 * 60 * 1_000;     // 55 min (Odoo session ≈ 1 h)
const BREAKER_THRESHOLD    = 5;        // failures before opening circuit
const BREAKER_COOLDOWN_MS  = 30_000;   // 30 s cooldown window

// ── in-process state (process-scoped; wiped on server restart) ───────────────
/** @type {Map<string, {uid: number, expires: number}>} */
const _uidCache = new Map();

/** @type {Map<string, {failures: number, openUntil: number}>} */
const _breaker  = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────
class OdooError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OdooError';
    this.status = status || 502;
  }
}

/** Strip trailing slash, ensure a scheme. */
function normalizeUrl(url) {
  if (!url) throw new OdooError('Odoo URL is required.', 400);
  let u = String(url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/** Hostname extracted from a URL string (no parsing cost at call time). */
function hostOf(url) {
  try { return new URL(normalizeUrl(url)).hostname; }
  catch { return url; }
}

/**
 * 24-char hex fingerprint of credential set.
 * Used as key for UID cache and circuit breaker.
 */
function cfgFingerprint({ url, db, username, apiKey }) {
  return crypto
    .createHash('sha256')
    .update([normalizeUrl(url), db, username, apiKey].join('|'))
    .digest('hex')
    .slice(0, 24);
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ── circuit breaker ───────────────────────────────────────────────────────────
function _breakerCheck(host) {
  const st = _breaker.get(host);
  if (!st || st.failures < BREAKER_THRESHOLD) return;
  const remaining = st.openUntil - Date.now();
  if (remaining > 0) {
    throw new OdooError(
      `Connection to ${host} is suspended after ${st.failures} consecutive failures. ` +
      `Retry in ${Math.ceil(remaining / 1_000)}s.`, 503);
  }
  // Cooldown expired — half-open: allow one probe through (reset failure count)
  _breaker.set(host, { failures: 0, openUntil: 0 });
}

function _breakerFail(host) {
  const st = _breaker.get(host) || { failures: 0, openUntil: 0 };
  st.failures += 1;
  if (st.failures >= BREAKER_THRESHOLD) {
    st.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(
      `[OdooClient] Circuit OPEN for ${host} after ${st.failures} failures. ` +
      `Suspended for ${BREAKER_COOLDOWN_MS / 1_000}s.`);
  }
  _breaker.set(host, st);
}

function _breakerSuccess(host) {
  if (_breaker.has(host)) _breaker.delete(host);
}

// ── UID cache ─────────────────────────────────────────────────────────────────
function _uidGet(fp) {
  const entry = _uidCache.get(fp);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _uidCache.delete(fp); return null; }
  return entry.uid;
}

function _uidSet(fp, uid) {
  _uidCache.set(fp, { uid, expires: Date.now() + UID_TTL_MS });
}

function _uidInvalidate(fp) {
  _uidCache.delete(fp);
}

// ── transport ─────────────────────────────────────────────────────────────────
/**
 * Single JSON-RPC attempt (no retry).
 * Throws OdooError; caller decides whether to retry.
 */
async function _rpcOnce(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError')
      throw new OdooError('Odoo did not respond in time (timeout).', 504);
    throw new OdooError(
      `Could not reach Odoo at ${endpoint} — check the URL and network access.`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok)
    throw new OdooError(`Odoo responded with HTTP ${res.status}.`, 502);

  let json;
  try { json = await res.json(); }
  catch { throw new OdooError('Odoo returned a non-JSON response.', 502); }

  if (json.error) {
    const data  = json.error.data || {};
    const msg   = data.message || json.error.message || 'Odoo RPC error';
    const clean = String(msg).trim().split('\n')[0].slice(0, 400);
    // Surface auth failures distinctly so the caller can bust the UID cache
    const isAuth = /access denied|authentication failed|invalid/i.test(clean);
    throw new OdooError(clean, isAuth ? 401 : 400);
  }
  return json.result;
}

/**
 * Resilient JSON-RPC call with circuit-breaker check, retry on transient
 * errors, and circuit-breaker bookkeeping.
 *
 * @param {string} baseUrl
 * @param {'common'|'object'} service
 * @param {string} method
 * @param {Array} args
 */
async function rpcCall(baseUrl, service, method, args) {
  const endpoint = normalizeUrl(baseUrl) + '/jsonrpc';
  const host     = hostOf(baseUrl);

  // Check circuit breaker before even trying
  _breakerCheck(host);

  const body = {
    jsonrpc: '2.0',
    method:  'call',
    params:  { service, method, args },
    id:      crypto.randomInt(1, 1e9),
  };

  // All read operations are idempotent — safe to retry.
  // Writes (not exposed in this module) should NOT be retried.
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await _sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const result = await _rpcOnce(endpoint, body);
      _breakerSuccess(host);
      return result;
    } catch (err) {
      lastErr = err;
      // Don't retry on definitive client errors (auth, validation, 404-style)
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        _breakerFail(host);
        throw err;
      }
      // Transient: 502/503/504 — record and try again (unless last attempt)
      if (attempt < maxAttempts - 1) {
        console.warn(
          `[OdooClient] ${host} attempt ${attempt + 1}/${maxAttempts} failed: ${err.message}`);
        _breakerFail(host);
        continue;
      }
      _breakerFail(host);
    }
  }
  throw lastErr;
}

// ── auth layer ────────────────────────────────────────────────────────────────
/**
 * Authenticate and return numeric uid.  Caches result for UID_TTL_MS.
 * Pass invalidate=true to skip the cache (e.g. after a 401).
 */
async function authenticate({ url, db, username, apiKey }, { invalidate = false } = {}) {
  if (!url || !db)            throw new OdooError('URL and database are required.', 400);
  if (!username || !apiKey)   throw new OdooError('Username and API key are required.', 400);

  const fp = cfgFingerprint({ url, db, username, apiKey });
  if (!invalidate) {
    const cached = _uidGet(fp);
    if (cached !== null) return cached;
  } else {
    _uidInvalidate(fp);
  }

  const uid = await rpcCall(url, 'common', 'authenticate', [db, username, apiKey, {}]);
  if (!uid) throw new OdooError('Authentication failed — check username / API key / database.', 401);
  _uidSet(fp, uid);
  return uid;
}

/**
 * execute_kw wrapper — re-authenticates once on 401 (stale cached UID).
 */
async function executeKw(cfg, uid, model, method, args, kwargs) {
  try {
    return await rpcCall(cfg.url, 'object', 'execute_kw',
      [cfg.db, uid, cfg.apiKey, model, method, args || [], kwargs || {}]);
  } catch (err) {
    if (err.status === 401) {
      // Cached UID is stale — re-authenticate and retry once
      const freshUid = await authenticate(cfg, { invalidate: true });
      return rpcCall(cfg.url, 'object', 'execute_kw',
        [cfg.db, freshUid, cfg.apiKey, model, method, args || [], kwargs || {}]);
    }
    throw err;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/** Full round-trip: version + auth in parallel, returns uid + version + latency. */
async function testConnection(cfg) {
  const started = Date.now();
  const [version, uid] = await Promise.all([
    rpcCall(cfg.url, 'common', 'version', []),
    authenticate(cfg),
  ]);
  return { uid, version, latencyMs: Date.now() - started };
}

/** Live list of installed apps/modules. */
async function listInstalledModules(cfg) {
  const uid = await authenticate(cfg);
  const ids = await executeKw(cfg, uid, 'ir.module.module', 'search',
    [[['state', '=', 'installed']]], { order: 'application desc, name asc' });
  if (!ids.length) return [];
  const rows = await executeKw(cfg, uid, 'ir.module.module', 'read',
    [ids], { fields: ['name', 'shortdesc', 'application', 'icon', 'summary'] });
  return rows.map(r => ({
    technicalName: r.name,
    label:         r.shortdesc || r.name,
    isApp:         !!r.application,
    summary:       r.summary || '',
  }));
}

/** Live data models exposed by a module. */
async function listModelsForModule(cfg, moduleTechnicalName) {
  const uid = await authenticate(cfg);
  let modelIds;
  try {
    modelIds = await executeKw(cfg, uid, 'ir.model', 'search',
      [[['modules', 'like', moduleTechnicalName]]], { limit: 200 });
  } catch {
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

/** Field metadata for a model (builds filter controls + columns). */
async function getFields(cfg, model) {
  const uid = await authenticate(cfg);
  return executeKw(cfg, uid, model, 'fields_get',
    [], { attributes: ['string', 'type', 'required', 'selection', 'relation'] });
}

/** Records via search_read + search_count in parallel. */
async function searchRead(cfg, model, { domain, fields, limit, offset, order }) {
  const uid = await authenticate(cfg);
  const kwargs = {
    fields: fields && fields.length ? fields : undefined,
    limit:  limit  || 25,
    offset: offset || 0,
    order:  order  || undefined,
  };
  const [rows, total] = await Promise.all([
    executeKw(cfg, uid, model, 'search_read',  [domain || []], kwargs),
    executeKw(cfg, uid, model, 'search_count', [domain || []]),
  ]);
  return { rows, total };
}

/** Aggregated totals via read_group (executive KPI cards, server-side). */
async function readGroup(cfg, model, { domain, fields, groupby }) {
  const uid = await authenticate(cfg);
  return executeKw(cfg, uid, model, 'read_group', [
    domain || [],
    fields && fields.length ? fields : ['__count'],
    groupby || [],
  ], { lazy: false });
}

// ── diagnostics ───────────────────────────────────────────────────────────────

/** Return current cache + circuit-breaker state (for /api/health or debug). */
function diagnostics() {
  const now = Date.now();
  return {
    uidCache: _uidCache.size,
    circuitBreakers: Object.fromEntries(
      [..._breaker.entries()].map(([host, st]) => [host, {
        failures:   st.failures,
        open:       st.openUntil > now,
        opensIn:    st.openUntil > now ? Math.ceil((st.openUntil - now) / 1_000) + 's' : null,
      }])
    ),
  };
}

/** Pre-warm the UID cache for a given credential set (call on server start). */
async function warmUp(cfg) {
  try {
    await authenticate(cfg);
    console.info(`[OdooClient] UID warm-up OK for ${hostOf(cfg.url)}`);
  } catch (e) {
    console.warn(`[OdooClient] UID warm-up failed for ${hostOf(cfg.url)}: ${e.message}`);
  }
}

/** Flush UID cache for a credential set (e.g. after password rotation). */
function flushUid(cfg) {
  _uidInvalidate(cfgFingerprint(cfg));
}

module.exports = {
  OdooError,
  // Core
  authenticate,
  testConnection,
  listInstalledModules,
  listModelsForModule,
  getFields,
  searchRead,
  readGroup,
  // Ops
  diagnostics,
  warmUp,
  flushUid,
};
