/* ==========================================================================
   DashView — AI Assistant config store
   --------------------------------------------------------------------------
   Single source of truth for which AI provider the app talks to, and how.
   Reads/writes localStorage key 'dashview_ai_config' — the same store the
   Settings → AI Assistant panel (dashboard.html) edits — so ai.html, the
   embedded dashboard AI view, and the settings panel all agree on one
   config without a page reload.

   Falls back to js/ai-api-config.js (window.DASHVIEW_AI_CONFIG) for anyone
   who set a key by editing that file directly and never opened Settings.

   Exposes window.DVAIConfig:
     get()                          → current effective config
     set(partial)                   → merge + save, returns new config
     isConfigured()                 → true if the active provider is ready
     activeModel(cfg?)              → model id currently in effect
     callAI(messages, systemPrompt) → Promise<string> reply text
   ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'dashview_ai_config';

  var PROVIDERS = {
    offline: {
      label: 'Offline demo engine',
      needsKey: false
    },
    grok: {
      label: 'Grok (xAI)',
      needsKey: true,
      apiUrl: 'https://api.x.ai/v1/chat/completions',
      defaultModel: 'grok-4-fast',
      models: ['grok-4-fast', 'grok-4', 'grok-3', 'grok-3-mini']
    },
    anthropic: {
      label: 'Claude (Anthropic)',
      needsKey: true,
      apiUrl: 'https://api.anthropic.com/v1/messages',
      defaultModel: 'claude-sonnet-4-5',
      models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']
    }
  };

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveStore(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) {} }

  // Anyone who only ever edited js/ai-api-config.js gets that as a starting
  // point — same behavior as before this store existed.
  function legacyDefaults() {
    var legacy = window.DASHVIEW_AI_CONFIG || {};
    return {
      provider: legacy.apiKey ? 'anthropic' : 'offline',
      apiKey: legacy.apiKey || '',
      model: legacy.model || '',
      systemPrompt: legacy.systemPrompt || '',
      includeCompanyContext: true
    };
  }

  function get() {
    var stored = loadStore();
    if (Object.keys(stored).length) {
      return Object.assign(
        { provider: 'offline', apiKey: '', model: '', systemPrompt: '', includeCompanyContext: true },
        stored
      );
    }
    return legacyDefaults();
  }

  function set(partial) {
    var merged = Object.assign({}, get(), partial || {});
    saveStore(merged);
    return merged;
  }

  function isConfigured() {
    var cfg = get();
    var p = PROVIDERS[cfg.provider];
    return !!(p && (!p.needsKey || cfg.apiKey));
  }

  function activeModel(cfg) {
    cfg = cfg || get();
    var p = PROVIDERS[cfg.provider];
    return cfg.model || (p && p.defaultModel) || '';
  }

  function toRole(r) { return (r === 'ai' || r === 'assistant') ? 'assistant' : 'user'; }

  function parseAnthropic(json) {
    var block = (json.content || []).find(function (b) { return b.type === 'text'; });
    return block ? block.text : '(No text in response.)';
  }
  function parseOpenAiLike(json) {
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '(No text in response.)';
  }

  function readJsonSafe(res) {
    return res.json().catch(function () { return {}; }).then(function (json) { return { res: res, json: json }; });
  }

  function callAnthropic(messages, systemPrompt, cfg) {
    var body = {
      model: activeModel(cfg),
      max_tokens: 2048,
      messages: messages.map(function (m) { return { role: toRole(m.role), content: m.content }; })
    };
    if (systemPrompt) body.system = systemPrompt;

    return fetch(PROVIDERS.anthropic.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(readJsonSafe).then(function (r) {
      if (!r.res.ok) throw new Error((r.json && r.json.error && r.json.error.message) || ('Request failed with status ' + r.res.status));
      return parseAnthropic(r.json);
    });
  }

  function callGrok(messages, systemPrompt, cfg) {
    var chatMessages = messages.map(function (m) { return { role: toRole(m.role), content: m.content }; });
    if (systemPrompt) chatMessages.unshift({ role: 'system', content: systemPrompt });

    return fetch(PROVIDERS.grok.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({ model: activeModel(cfg), messages: chatMessages })
    }).then(readJsonSafe).then(function (r) {
      if (!r.res.ok) throw new Error((r.json && r.json.error && (r.json.error.message || r.json.error)) || ('Request failed with status ' + r.res.status));
      return parseOpenAiLike(r.json);
    });
  }

  function callAI(messages, systemPrompt) {
    var cfg = get();
    if (!isConfigured()) return Promise.reject(new Error('No AI provider is configured yet. Add a key in Settings → AI Assistant.'));
    if (cfg.provider === 'grok') return callGrok(messages, systemPrompt, cfg);
    if (cfg.provider === 'anthropic') return callAnthropic(messages, systemPrompt, cfg);
    return Promise.reject(new Error('Unknown AI provider "' + cfg.provider + '".'));
  }

  window.DVAIConfig = {
    PROVIDERS: PROVIDERS,
    get: get,
    set: set,
    isConfigured: isConfigured,
    activeModel: activeModel,
    callAI: callAI
  };
})();
