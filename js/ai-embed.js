/* ==========================================================================
   DashView — AI Assistant, embedded SPA view (item #10)
   --------------------------------------------------------------------------
   Drives #view-ai inside dashboard.html using the same offline engine as the
   full-page ai.html (js/ai-engine.js) — no page reload, no network calls.
   Kept intentionally small: a single active thread, not full multi-
   conversation management (that richer experience still lives at ai.html,
   linked from the footnote in this view for anyone who wants it).
   ========================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var messagesEl = document.getElementById('aiEmbedMessages');
    var emptyEl = document.getElementById('aiEmbedEmpty');
    var inputEl = document.getElementById('aiEmbedInput');
    var sendBtn = document.getElementById('aiEmbedSendBtn');
    var newChatBtn = document.getElementById('aiEmbedNewChatBtn');
    var exportBtn = document.getElementById('aiEmbedExportBtn');
    if (!messagesEl || !inputEl) return; // view-ai isn't on this page

    var sessionSeed = 's' + Date.now();
    var thread = []; // { role: 'user'|'ai', content, tag, time }
    var thinkingRow = null;

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // Turns one ```chart fenced block into a horizontal bar chart. Expected
    // shape (see js/ai-company-context.js's reporting instructions):
    //   ```chart
    //   Optional title
    //   Label one: 12345
    //   Label two: 9876
    //   ```
    // Returns an HTML string, or null if fewer than 2 lines parse as
    // "label <: or |> number", in which case the caller leaves the block
    // untouched so it still renders as plain code instead of vanishing.
    // NOTE: this runs on text esc() has already escaped once (see below) —
    // do not esc() the label/value again here, or entities double-escape.
    function renderChartBlock(raw) {
      var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      var rowRe = /^(.+?)\s*[:|]\s*[$€£₹]?\s*([+-]?[\d,]*\.?\d+)\s*%?$/;

      var title = '';
      if (lines.length && !rowRe.test(lines[0])) title = lines.shift();

      var rows = lines.map(function (l) {
        var m = l.match(rowRe);
        if (!m) return null;
        return { label: m[1].trim(), value: parseFloat(m[2].replace(/,/g, '')) };
      }).filter(function (r) { return r && isFinite(r.value); }).slice(0, 8);

      if (rows.length < 2) return null;

      var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.value); })) || 1;
      var barsHtml = rows.map(function (r) {
        var pct = Math.max((Math.abs(r.value) / max) * 100, 3);
        var rounded = Math.round(r.value);
        var valText = (Math.abs(r.value - rounded) < 0.005 ? rounded : r.value).toLocaleString();
        return '<div class="ai-chart-row">' +
          '<span class="ai-chart-label">' + r.label + '</span>' +
          '<span class="ai-chart-bar-track"><span class="ai-chart-bar-fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
          '<span class="ai-chart-value">' + valText + '</span>' +
          '</div>';
      }).join('');
      var titleHtml = title ? '<div class="ai-chart-title">' + title + '</div>' : '';
      return '<div class="ai-chart">' + titleHtml + barsHtml + '</div>';
    }

    // Same shape as ai.html's renderer, kept in sync deliberately — anything
    // that goes through DashViewAI.respond() should look the same wherever
    // it's rendered.
    function renderMarkdown(text) {
      return esc(text)
        .replace(/```chart\n?([\s\S]*?)```/g, function (match, body) { return renderChartBlock(body) || match; })
        .replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) { return '<pre><code>' + code.trim() + '</code></pre>'; })
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
        .replace(/^---$/gm, '<hr/>')
        .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, function (m) { return '<ul>' + m + '</ul>'; })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br/>');
    }
    // esc() already ran inside renderMarkdown, so plain user text just needs esc().

    function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

    function appendMessage(role, content, tag) {
      if (emptyEl && emptyEl.parentNode) emptyEl.remove();
      var row = document.createElement('div');
      row.className = 'ai-embed-msg ' + role;
      var tagHtml = (role === 'ai' && tag) ? '<span class="ai-embed-tag">' + esc(tag) + '</span>' : '';
      var bodyHtml = role === 'ai' ? renderMarkdown(content) : '<p>' + esc(content) + '</p>';
      row.innerHTML =
        '<div class="ai-embed-avatar ' + role + '">' + (role === 'ai'
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 13l3-5 2 3 2-4 3 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : 'You') + '</div>' +
        '<div class="ai-embed-bubble">' + tagHtml + '<div class="ai-embed-content">' + bodyHtml + '</div>' +
        '<div class="ai-embed-time">' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div></div>';
      messagesEl.appendChild(row);
      scrollToBottom();
      return row;
    }

    function showThinking() {
      thinkingRow = document.createElement('div');
      thinkingRow.className = 'ai-embed-msg ai ai-embed-thinking';
      thinkingRow.innerHTML =
        '<div class="ai-embed-avatar ai"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 13l3-5 2 3 2-4 3 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '<div class="ai-embed-bubble"><div class="ai-embed-dots"><span></span><span></span><span></span></div></div>';
      messagesEl.appendChild(thinkingRow);
      scrollToBottom();
    }
    function clearThinking() {
      if (thinkingRow && thinkingRow.parentNode) thinkingRow.parentNode.removeChild(thinkingRow);
      thinkingRow = null;
    }

    function send(text) {
      text = (text || inputEl.value || '').trim();
      if (!text || !window.DashViewAI) return;
      thread.push({ role: 'user', content: text });
      appendMessage('user', text);
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;
      showThinking();
      // Small delay mirrors the full-page assistant's pacing so a reply
      // doesn't feel like it's just a synchronous string lookup.
      setTimeout(function () {
        var result;
        try { result = window.DashViewAI.respond(text, { seed: sessionSeed }); }
        catch (e) { result = { content: 'Something went wrong reading that — try rephrasing?', tag: null }; }
        clearThinking();
        thread.push({ role: 'ai', content: result.content, tag: result.tag });
        appendMessage('ai', result.content, result.tag);
      }, 350 + Math.min(600, text.length * 4));
    }

    inputEl.addEventListener('input', function () {
      sendBtn.disabled = !inputEl.value.trim();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(160, inputEl.scrollHeight) + 'px';
    });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) send(); }
    });
    sendBtn.addEventListener('click', function () { send(); });

    document.querySelectorAll('.ai-embed-suggest-card').forEach(function (card) {
      card.addEventListener('click', function () { send(card.dataset.prompt); });
    });

    if (newChatBtn) newChatBtn.addEventListener('click', function () {
      thread = [];
      messagesEl.innerHTML = '';
      if (emptyEl) messagesEl.appendChild(emptyEl);
      inputEl.value = '';
      sendBtn.disabled = true;
      if (window.showToast) window.showToast('Started a new chat.');
    });

    if (exportBtn) exportBtn.addEventListener('click', function () {
      if (!thread.length) { if (window.showToast) window.showToast('Nothing to export yet.'); return; }
      var text = thread.map(function (m) { return (m.role === 'user' ? 'You' : 'DashView AI') + ':\n' + m.content; }).join('\n\n');
      var blob = new Blob([text], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'dashview-ai-chat.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (window.showToast) window.showToast('Chat exported.');
    });
  });
})();
