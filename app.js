/* SK Airways — Resolution Agent · UI layer
   Talks to server.js (/api). If no server is reachable (e.g. index.html
   opened directly from disk), falls back to the in-browser rules engine. */
'use strict';
(function () {
  var E = window.Engine;
  var $ = function (id) { return document.getElementById(id); };

  var SCENARIOS = {
    priya: 'Flight SK-204 (Delhi → Goa) is cancelled for operational reasons. Mid-conversation she’s furious — and wants a full cash refund plus a free business-class upgrade on her return flight “for the trouble.”',
    arvind: 'Flight SK-118 (Mumbai → Bengaluru) is delayed 4 hours. Frustrated about missing a meeting, he asks for hotel accommodation “since it’s been such a long delay.”',
    meher: 'Flight SK-305 (Delhi → Hyderabad) is delayed 6 hours. She wants a full night’s hotel stay — and to move onto a higher-fare flight with a ₹2,000 fare difference.'
  };
  var NEW_DESC = 'The full agentic flow: the agent greets you, asks what happened, verifies your booking reference against the knowledge base, then resolves your case — try any of the three PNRs.';

  var serverMode = null;   // 'ai' | 'rules' | null (no server → local engine)
  var serverInfo = null;   // /api/health payload: { mode, provider, label, model }
  var session = null;      // { kind:'api', id, customerId, turn } | { kind:'local', state }
  var busy = false;
  var playGen = 0;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, reduceMotion ? Math.min(ms, 120) : ms); });
  }
  function now() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function initials(name) {
    return name.split(' ').map(function (p) { return p[0]; }).join('').toUpperCase();
  }
  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  /* ---------- transport ---------- */

  var clientAI = null; // static hosting (e.g. GitHub Pages): keyless LLM called from the browser

  async function detectServer() {
    try {
      var r = await fetch('api/health');
      if (!r.ok) throw new Error('bad status');
      var h = await r.json();
      serverMode = h.mode;
      serverInfo = h;
    } catch (e) {
      serverMode = null; // file:// / static hosting / server down
      serverInfo = null;
      if (window.AgentFree && window.Policy) {
        try {
          var prov = window.AgentFree.resolveProvider('pollinations');
          if (prov && await window.AgentFree.probe('pollinations')) clientAI = prov;
        } catch (err) { clientAI = null; }
      }
    }
  }

  async function apiStart(customerId) {
    var r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: customerId })
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'session failed');
    return data;
  }

  async function apiSend(text) {
    var r = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: text })
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'message failed');
    return data;
  }

  function modeLabel() {
    if (serverMode === 'ai') {
      var who = serverInfo && serverInfo.label ? serverInfo.label : 'LLM';
      return { text: 'AI agent · ' + who, cls: 'mode mode-ai' };
    }
    if (serverMode === 'rules') return { text: 'Rules engine', cls: 'mode mode-rules' };
    if (clientAI) return { text: 'AI agent · Free LLM (in-browser)', cls: 'mode mode-ai' };
    return { text: 'Local demo', cls: 'mode mode-rules' };
  }

  function clientChips(state) {
    if (!state || !state.customer) {
      return ['My booking reference is SK4821X', 'My booking reference is TR1190B', 'My booking reference is WL7742'];
    }
    if (state.fullEscalated) return ['What is the status of my booking?'];
    var script = E.SCRIPTS[state.customer.id] || [];
    var idx = Math.min(state.turn, script.length);
    var chips = script.slice(idx, idx + 2);
    if (!chips.length) chips = ['What is the status of my booking?', 'This is unacceptable — I’m considering legal action.'];
    if (chips.length < 3) chips.push('What is the status of my booking?');
    return chips.slice(0, 3);
  }

  /* ---------- landing ---------- */

  function buildLanding() {
    var wrap = $('cards');
    wrap.innerHTML = '';
    Object.keys(E.DATA.customers).forEach(function (id) {
      var c = E.DATA.customers[id];
      var b = E.DATA.bookings.filter(function (x) { return x.customer === id && x.status !== 'unaffected'; })[0];
      var card = document.createElement('article');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-head">' +
          '<div class="avatar">' + esc(initials(c.name)) + '</div>' +
          '<div><div class="card-name">' + esc(c.name) + '</div>' +
          '<div class="card-meta"><span class="tier tier-' + c.tier.toLowerCase() + '">' + c.tier + '</span>' +
          '<span class="pnr">PNR ' + c.pnr + '</span></div></div>' +
        '</div>' +
        '<div class="flightline"><span class="f">' + esc(b.flight + ' · ' + b.route) + '</span>' +
          '<span class="pill pill-' + b.status + '">' + (b.status === 'cancelled' ? 'Cancelled' : 'Delayed ' + b.delayHours + 'h') + '</span></div>' +
        '<p class="desc">' + esc(SCENARIOS[id]) + '</p>' +
        '<div class="card-actions">' +
          '<button class="btn btn-primary" data-open="' + id + '">Start chat</button>' +
          '<button class="btn btn-ghost" data-play="' + id + '">Watch scenario</button>' +
        '</div>';
      wrap.appendChild(card);
    });

    var newCard = document.createElement('article');
    newCard.className = 'card';
    newCard.innerHTML =
      '<div class="card-head">' +
        '<div class="avatar">?</div>' +
        '<div><div class="card-name">New customer</div>' +
        '<div class="card-meta"><span class="tier tier-silver">Unverified</span>' +
        '<span class="pnr">PNR — shared in chat</span></div></div>' +
      '</div>' +
      '<div class="flightline"><span class="f">Identity verified in-conversation</span>' +
        '<span class="pill pill-neutral">Agentic flow</span></div>' +
      '<p class="desc">' + esc(NEW_DESC) + '</p>' +
      '<div class="card-actions">' +
        '<button class="btn btn-primary" data-open="new">Start chat</button>' +
      '</div>';
    wrap.appendChild(newCard);

    wrap.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.open) openSession(t.dataset.open, false);
      if (t.dataset.play) openSession(t.dataset.play, true);
    });
  }

  /* ---------- session ---------- */

  function updateWho(c) {
    var tierEl = $('who-tier');
    if (c) {
      $('who-avatar').textContent = initials(c.name);
      $('who-name').textContent = c.name;
      tierEl.textContent = c.tier;
      tierEl.className = 'tier tier-' + c.tier.toLowerCase();
      $('who-pnr').textContent = 'PNR ' + c.pnr;
    } else {
      $('who-avatar').textContent = '?';
      $('who-name').textContent = 'New customer';
      tierEl.textContent = 'Unverified';
      tierEl.className = 'tier tier-silver';
      $('who-pnr').textContent = 'PNR —';
    }
  }

  async function openSession(id, autoplay) {
    playGen++;
    var c = E.DATA.customers[id] || null;
    $('landing').hidden = true;
    $('chatView').hidden = false;
    updateWho(c);
    $('who-case').textContent = '';
    var m = modeLabel();
    $('modeBadge').textContent = m.text;
    $('modeBadge').className = m.cls;
    $('messages').innerHTML = '';
    $('traceList').innerHTML = '<p class="empty-note">Rule checks appear here as the agent replies.</p>';
    $('ledgerList').innerHTML = '<p class="empty-note">No actions on this booking yet.</p>';
    $('escList').innerHTML = '<p class="empty-note">No escalations raised.</p>';
    $('traceCount').textContent = '0';
    $('ledgerCount').textContent = '0';
    $('escCount').textContent = '0';
    $('escBanner').classList.remove('show');
    $('userInput').value = '';
    setBusy(true);

    var opening;
    if (serverMode) {
      try {
        var data = await apiStart(id);
        session = { kind: 'api', id: data.sessionId, caseId: data.caseId, customerId: id, turn: 0 };
        if (data.caseId) $('who-case').textContent = data.caseId;
        opening = data;
      } catch (err) {
        serverMode = null; // degrade to local
      }
    }
    if (!serverMode) {
      if (clientAI) {
        var st = window.Policy.createAiSession(id === 'new' ? null : id, 'CASE-20260923-DEMO');
        session = { kind: 'client', state: st, caseId: st.caseId, customerId: id };
        $('who-case').textContent = st.caseId;
        opening = window.Policy.openingTurn(st);
        opening.chips = clientChips(st);
      } else if (id === 'new') {
        session = null;
        showTyping(false);
        addBubble('agent', 'The new-customer flow needs the AI agent — run `node server.js` locally, or retry once you’re online (the free in-browser LLM could not be reached). The three passenger chats still work here.');
        setBusy(false);
        return;
      } else {
        session = { kind: 'local', state: E.createSession(id), customerId: id };
        opening = E.openingMessage(session.state);
      }
    }

    await renderAgentTurn(opening, 'Session opened', 300);
    setBusy(false);
    if (autoplay) runAutoplay(playGen);
  }

  function setBusy(b) {
    busy = b;
    $('userInput').disabled = b;
    $('sendBtn').disabled = b;
  }

  /* ---------- rendering ---------- */

  function addBubble(kind, text) {
    var m = $('messages');
    var el = document.createElement('div');
    el.className = 'msg msg-' + kind;
    el.textContent = text;
    m.appendChild(el);
    var t = document.createElement('div');
    t.className = 'msg-time t-' + kind;
    t.textContent = (kind === 'agent' ? 'Agent · ' : '') + now();
    m.appendChild(t);
    m.scrollTop = m.scrollHeight;
  }

  function showTyping(show) {
    var m = $('messages');
    var t = $('typing');
    t.classList.toggle('show', show);
    if (show) { m.appendChild(t); m.scrollTop = m.scrollHeight; }
  }

  function renderChips(chips) {
    var row = $('chips');
    row.innerHTML = '';
    (chips || []).forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', function () { submitMessage(label); });
      row.appendChild(b);
    });
  }

  function renderTrace(out, turnLabel) {
    if (!out.trace || !out.trace.length) return;
    var list = $('traceList');
    if (list.querySelector('.empty-note')) list.innerHTML = '';
    var group = document.createElement('div');
    group.className = 'turn-group';
    var lbl = document.createElement('div');
    lbl.className = 'turn-label';
    lbl.textContent = turnLabel;
    group.appendChild(lbl);
    var labels = {
      data: 'Data', info: 'Note', allowed: 'Allowed', action: 'Action',
      blocked: 'Blocked', supervisor: 'Supervisor', escalated: 'Escalated'
    };
    out.trace.forEach(function (t) {
      var e = document.createElement('div');
      e.className = 'trace-entry';
      e.innerHTML = '<span class="verdict v-' + t.verdict + '">' + (labels[t.verdict] || t.verdict) + '</span>' +
        '<div class="trace-body"><div class="trace-rule">' + esc(t.rule) + '</div>' +
        '<div class="trace-detail">' + esc(t.detail) + '</div></div>';
      group.appendChild(e);
    });
    list.insertBefore(group, list.firstChild);
    $('traceCount').textContent = String(parseInt($('traceCount').textContent, 10) + out.trace.length);
  }

  function renderLedger(out) {
    if (out.actions && out.actions.length) {
      var list = $('ledgerList');
      if (list.querySelector('.empty-note')) list.innerHTML = '';
      out.actions.forEach(function (a) {
        var e = document.createElement('div');
        e.className = 'ledger-item';
        e.innerHTML = '<span class="id">' + esc(a.id) + '</span><span>' + esc(a.label) + '</span>';
        list.insertBefore(e, list.firstChild);
      });
      $('ledgerCount').textContent = String(parseInt($('ledgerCount').textContent, 10) + out.actions.length);
    }
    if (out.escalations && out.escalations.length) {
      var el = $('escList');
      if (el.querySelector('.empty-note')) el.innerHTML = '';
      out.escalations.forEach(function (a) {
        var e = document.createElement('div');
        e.className = 'esc-item';
        e.innerHTML = '<span class="id">' + esc(a.id) + '</span><span>' + esc(a.label) + '</span>';
        el.insertBefore(e, el.firstChild);
      });
      $('escCount').textContent = String(parseInt($('escCount').textContent, 10) + out.escalations.length);
    }
    var escalated = out.fullEscalated || (session && session.kind === 'local' && session.state.fullEscalated);
    if (escalated) $('escBanner').classList.add('show');
  }

  function addResolutionCard(out) {
    var m = $('messages');
    var el = document.createElement('div');
    el.className = 'rescard';
    var rows = '';
    (out.actions || []).forEach(function (a) {
      rows += '<div class="rescard-row ok"><span>✓</span><div>' + esc(a.label) + ' <span class="rid">' + esc(a.id) + '</span></div></div>';
    });
    (out.escalations || []).forEach(function (t) {
      rows += '<div class="rescard-row esc"><span>⤴</span><div>' + esc(t.label) + ' <span class="rid">' + esc(t.id) + '</span></div></div>';
    });
    var caseRef = session && session.caseId ? ' · <span class="rid">' + esc(session.caseId) + '</span>' : '';
    el.innerHTML = '<div class="rescard-title">Resolution update' + caseRef + '</div>' + rows;
    m.appendChild(el);
    m.scrollTop = m.scrollHeight;
  }

  async function renderAgentTurn(out, turnLabel, baseDelay) {
    showTyping(true);
    await sleep(baseDelay + Math.min(1200, (out.parts || []).join(' ').length * 6));
    showTyping(false);
    var parts = out.parts || [];
    for (var i = 0; i < parts.length; i++) {
      addBubble('agent', parts[i]);
      if (i < parts.length - 1) {
        showTyping(true);
        await sleep(500 + Math.min(900, parts[i + 1].length * 4));
        showTyping(false);
      }
    }
    if (out.customer) updateWho(out.customer);
    if ((out.actions && out.actions.length) || (out.escalations && out.escalations.length)) {
      addResolutionCard(out);
    }
    renderTrace(out, turnLabel);
    renderLedger(out);
    if (out.chips) renderChips(out.chips); // supervisor notices carry no chips — keep the current ones
  }

  /* ---------- supervisor updates (human-in-the-loop) ---------- */

  async function pollNotices() {
    if (!session || session.kind !== 'api' || busy) return;
    try {
      var r = await fetch('/api/notices?sessionId=' + encodeURIComponent(session.id));
      if (!r.ok) return;
      var data = await r.json();
      var notices = data.notices || [];
      if (!notices.length) return;
      setBusy(true);
      for (var i = 0; i < notices.length; i++) {
        await renderAgentTurn(notices[i], 'Supervisor decision · Resolution Console', 200);
      }
      if (data.fullEscalated) $('escBanner').classList.add('show');
      setBusy(false);
    } catch (e) { /* server briefly unreachable — next poll retries */ }
  }

  /* ---------- message flow ---------- */

  async function sendToAgent(text) {
    if (session.kind === 'api') {
      session.turn++;
      return apiSend(text);
    }
    if (session.kind === 'client') {
      var out = await window.AgentFree.runTurn(session.state, text, clientAI);
      var c = session.state.customer;
      out.customer = c ? { id: c.id, name: c.name, tier: c.tier, pnr: c.pnr } : null;
      out.chips = clientChips(session.state);
      return out;
    }
    return E.handleMessage(session.state, text);
  }

  function turnNumber() {
    return session.kind === 'api' ? session.turn : session.state.turn;
  }

  async function submitMessage(text) {
    if (!session || busy) return;
    text = (text || '').trim();
    if (!text) return;
    playGen++;
    setBusy(true);
    renderChips([]);
    addBubble('user', text);
    $('userInput').value = '';
    try {
      var out = await sendToAgent(text);
      var label = 'T' + turnNumber() + ' · “' + (text.length > 44 ? text.slice(0, 44) + '…' : text) + '”';
      await renderAgentTurn(out, label, 500);
    } catch (err) {
      showTyping(false);
      addBubble('agent', '⚠ ' + (err.message || 'Something went wrong — please try again.'));
    }
    setBusy(false);
    $('userInput').focus();
  }

  async function runAutoplay(gen) {
    var script = E.SCRIPTS[session.customerId] || [];
    for (var i = 0; i < script.length; i++) {
      if (gen !== playGen) return;
      await sleep(i === 0 ? 700 : 1100);
      if (gen !== playGen) return;
      setBusy(true);
      renderChips([]);
      addBubble('user', script[i]);
      try {
        var out = await sendToAgent(script[i]);
        var label = 'T' + turnNumber() + ' · “' + (script[i].length > 44 ? script[i].slice(0, 44) + '…' : script[i]) + '”';
        await renderAgentTurn(out, label, 500);
      } catch (err) {
        showTyping(false);
        addBubble('agent', '⚠ ' + (err.message || 'The agent call failed.'));
        setBusy(false);
        return;
      }
      if (gen !== playGen) return;
      setBusy(false);
    }
  }

  /* ---------- wiring ---------- */

  document.addEventListener('DOMContentLoaded', async function () {
    buildLanding();

    $('sendBtn').addEventListener('click', function () { submitMessage($('userInput').value); });
    $('userInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitMessage($('userInput').value); }
    });

    $('backBtn').addEventListener('click', function () {
      playGen++;
      session = null;
      $('chatView').hidden = true;
      $('landing').hidden = false;
      $('inspector').classList.remove('open');
    });
    $('restartBtn').addEventListener('click', function () {
      if (session) openSession(session.customerId, false);
    });
    $('replayBtn').addEventListener('click', function () {
      if (session) openSession(session.customerId, true);
    });
    $('consoleToggle').addEventListener('click', function () {
      $('inspector').classList.toggle('open');
    });

    function bindModal(openIds, overlayId, closeId) {
      openIds.forEach(function (oid) {
        $(oid).addEventListener('click', function () { $(overlayId).classList.add('show'); });
      });
      $(closeId).addEventListener('click', function () { $(overlayId).classList.remove('show'); });
      $(overlayId).addEventListener('click', function (ev) {
        if (ev.target === $(overlayId)) $(overlayId).classList.remove('show');
      });
    }
    bindModal(['dataBtn', 'dataBtn2'], 'dataOverlay', 'dataClose');
    bindModal(['howBtn', 'howBtn2'], 'howOverlay', 'howClose');
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        $('dataOverlay').classList.remove('show');
        $('howOverlay').classList.remove('show');
      }
    });

    setInterval(pollNotices, 4000);

    // Everything above is interactive immediately; mode detection (and the
    // keyless-LLM probe on static hosting) runs after, capped at ~8s.
    await detectServer();
    if (!serverMode) {
      var al = $('adminLink');
      if (al) al.style.display = 'none'; // the support console needs the server's /api
    }

    // deep link: ?p=priya|arvind|meher|new & play=1 opens a session directly
    var qs = new URLSearchParams(location.search);
    var qp = qs.get('p');
    if (qp && (E.DATA.customers[qp] || qp === 'new')) openSession(qp, qs.get('play') === '1');
  });
})();
