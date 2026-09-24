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
      var PALETTE = ['#e8a33d', '#5b8fae', '#c76b3c', '#7aa874', '#a78bc4', '#d4b95e', '#5fb3b3', '#b0798a'];

      // Optional first line "type: bar | line | donut" (default bar).
      var kind = 'bar';
      if (lines.length && /^type\s*:\s*(bar|line|donut)$/i.test(lines[0])) {
        kind = lines.shift().split(':')[1].trim().toLowerCase();
      }
      var title = '';
      if (lines.length && !rowRe.test(lines[0])) title = lines.shift();

      var rows = lines.map(function (l) {
        var m = l.match(rowRe);
        if (!m) return null;
        return { label: m[1].trim(), value: parseFloat(m[2].replace(/,/g, '')) };
      }).filter(function (r) { return r && isFinite(r.value); }).slice(0, kind === 'line' ? 24 : 8);

      if (rows.length < 2) return null;

      function fmt(v) {
        var rounded = Math.round(v);
        return (Math.abs(v - rounded) < 0.005 ? rounded : v).toLocaleString();
      }
      var titleHtml = title ? '<div class="ai-chart-title">' + (title) + '</div>' : '';
      var vals = rows.map(function (r) { return r.value; });

      if (kind === 'line') {
        var W = 560, H = 190, L = 10, R = 14, T = 22, B = 26;
        var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
        var span = (mx - mn) || 1;
        var n = rows.length;
        var pts = rows.map(function (r, i) {
          return { x: L + i * (W - L - R) / (n - 1), y: T + (1 - (r.value - mn) / span) * (H - T - B) };
        });
        var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
        var area = d + ' L' + pts[n - 1].x.toFixed(1) + ' ' + (H - B) + ' L' + pts[0].x.toFixed(1) + ' ' + (H - B) + ' Z';
        var step = Math.ceil(n / 6);
        var xl = rows.map(function (r, i) {
          if (i % step && i !== n - 1) return '';
          return '<text x="' + pts[i].x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle')) + '">' + (r.label) + '</text>';
        }).join('');
        var iMax = vals.indexOf(mx), iLast = n - 1;
        var tags = [iMax].concat(iLast !== iMax ? [iLast] : []).map(function (i) {
          return '<text class="ai-chart-pt" x="' + Math.min(Math.max(pts[i].x, 30), W - 30).toFixed(1) + '" y="' + (pts[i].y - 8).toFixed(1) + '" text-anchor="middle">' + (fmt(rows[i].value)) + '</text>';
        }).join('');
        var dots = pts.map(function (p) { return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3"/>'; }).join('');
        return '<div class="ai-chart">' + titleHtml +
          '<svg class="ai-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (title || 'Line chart') + '">' +
          '<line class="ai-chart-axis" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '"/>' +
          '<path class="ai-chart-area" d="' + area + '"/><path class="ai-chart-line" d="' + d + '"/>' + dots + xl + tags + '</svg></div>';
      }

      if (kind === 'donut') {
        var total = vals.reduce(function (a, v) { return a + Math.abs(v); }, 0) || 1;
        var acc = 0;
        var stops = rows.map(function (r, i) {
          var from = acc / total * 100; acc += Math.abs(r.value); var to = acc / total * 100;
          return PALETTE[i % PALETTE.length] + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%';
        }).join(', ');
        var legend = rows.map(function (r, i) {
          return '<div class="ai-donut-item"><span class="ai-donut-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
            '<span class="ai-donut-label">' + (r.label) + '</span>' +
            '<span class="ai-chart-value">' + (fmt(r.value)) + ' · ' + (Math.abs(r.value) / total * 100).toFixed(1) + '%</span></div>';
        }).join('');
        return '<div class="ai-chart">' + titleHtml + '<div class="ai-donut-wrap"><div class="ai-donut" style="background:conic-gradient(' + stops + ')"><span></span></div>' +
          '<div class="ai-donut-legend">' + legend + '</div></div></div>';
      }

      var max = Math.max.apply(null, vals.map(Math.abs)) || 1;
      var barsHtml = rows.map(function (r) {
        var pct = Math.max((Math.abs(r.value) / max) * 100, 3);
        return '<div class="ai-chart-row">' +
          '<span class="ai-chart-label">' + (r.label) + '</span>' +
          '<span class="ai-chart-bar-track"><span class="ai-chart-bar-fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
          '<span class="ai-chart-value">' + (fmt(r.value)) + '</span></div>';
      }).join('');
      return '<div class="ai-chart">' + titleHtml + barsHtml + '</div>';
    }

    // ```kpi block: one card per line, "Label: value | change" (change optional, e.g. "+12.4% vs last month").
    function renderKpiBlock(raw) {
      var cards = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 6).map(function (l) {
        var i = l.indexOf(':');
        if (i < 1) return null;
        var parts = l.slice(i + 1).split('|').map(function (s) { return s.trim(); });
        if (!parts[0]) return null;
        var delta = parts[1] || '';
        var cls = /^[+▲↑]/.test(delta) ? ' up' : (/^[-−▼↓]/.test(delta) ? ' down' : '');
        return '<div class="ai-kpi"><div class="ai-kpi-label">' + (l.slice(0, i).trim()) + '</div>' +
          '<div class="ai-kpi-value">' + (parts[0]) + '</div>' +
          (delta ? '<div class="ai-kpi-delta' + cls + '">' + (delta) + '</div>' : '') + '</div>';
      }).filter(Boolean);
      return cards.length ? '<div class="ai-kpi-grid">' + cards.join('') + '</div>' : null;
    }

    // Same shape as ai.html's renderer, kept in sync deliberately — anything
    // that goes through DashViewAI.respond() should look the same wherever
    // it's rendered.
    function renderMarkdown(text) {
      return esc(text)
        .replace(/```kpi\n?([\s\S]*?)```/g, function (match, body) { return renderKpiBlock(body) || match; })
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
