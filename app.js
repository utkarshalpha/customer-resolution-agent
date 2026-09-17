/* SK Airways — Customer Resolution Agent · UI
   Views: login → dashboard → chat with Aria (+ voice mode).
   Talks to server.js (/api). With no server it falls back to the in-browser
   agent (keyless LLM) or the deterministic rules engine. */
'use strict';
(function () {
  var E = window.Engine;
  var $ = function (id) { return document.getElementById(id); };

  var serverMode = null;   // 'ai' | 'rules' | null (no server)
  var serverInfo = null;
  var clientAI = null;     // static hosting: keyless LLM from the browser
  var profile = null;      // the signed-in customer (from the data pack)
  var session = null;      // { kind:'api'|'client'|'local', ... }
  var busy = false;
  var playGen = 0;
  var pendingAsk = null;
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
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }
  /* light formatting: **bold** and list markers → clean bullets */
  function fmt(text) {
    var s = esc(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.split('\n').map(function (l) { return l.replace(/^\s*[*\-•]\s+/, '• '); }).join('<br>');
    return s;
  }

  /* ---------- sounds + haptics ---------- */
  var actx = null;
  function blip(freq, gain) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') { actx.resume(); }
      var o = actx.createOscillator(), v = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      v.gain.setValueAtTime(gain, actx.currentTime);
      v.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12);
      o.connect(v); v.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.13);
    } catch (e) { /* silent */ }
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  /* ---------- transport ---------- */

  async function detectServer() {
    try {
      var r = await fetch('api/health');
      if (!r.ok) throw new Error('bad status');
      serverInfo = await r.json();
      serverMode = serverInfo.mode;
    } catch (e) {
      serverMode = null; serverInfo = null;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: customerId })
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'session failed');
    return data;
  }
  async function apiSend(text) {
    var r = await fetch('/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: text })
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'message failed');
    return data;
  }

  function modeLabel() {
    if (serverMode === 'ai') return { text: 'AI · ' + (serverInfo && serverInfo.label || 'LLM'), cls: 'mode mode-ai' };
    if (serverMode === 'rules') return { text: 'Rules engine', cls: 'mode mode-rules' };
    if (clientAI) return { text: 'AI · in-browser', cls: 'mode mode-ai' };
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

  /* ---------- views ---------- */

  function showView(v) {
    ['loginView', 'dashView', 'chatView'].forEach(function (id) { $(id).hidden = (id !== v); });
    $('logoutBtn').hidden = (v === 'loginView');
    window.scrollTo(0, 0);
  }

  /* ---------- login ---------- */

  function renderLoginList(filter) {
    var list = $('loginList');
    var q = (filter || '').trim().toLowerCase();
    var opts = Object.keys(E.DATA.customers).map(function (id) { return E.DATA.customers[id]; })
      .filter(function (c) {
        if (!q) return true;
        return c.name.toLowerCase().indexOf(q) !== -1 || c.pnr.toLowerCase().indexOf(q) !== -1;
      });
    if (!opts.length) { list.classList.remove('show'); return; }
    list.innerHTML = opts.map(function (c) {
      return '<div class="loginopt" data-id="' + esc(c.id) + '">' +
        '<span class="avatar" style="width:36px;height:36px;font-size:12.5px">' + esc(initials(c.name)) + '</span>' +
        '<span><span class="nm">' + esc(c.name) + '</span><br><span class="sub">' + esc(c.tier) + ' · PNR ' + esc(c.pnr) + '</span></span>' +
        '</div>';
    }).join('');
    list.classList.add('show');
    list.querySelectorAll('.loginopt').forEach(function (o) {
      o.addEventListener('mousedown', function (ev) { ev.preventDefault(); login(o.dataset.id); });
    });
  }

  function login(id) {
    profile = E.DATA.customers[id];
    if (!profile) return;
    try { sessionStorage.setItem('sk_profile', id); } catch (e) {}
    $('loginList').classList.remove('show');
    $('loginInput').value = '';
    blip(700, 0.05);
    renderDash();
    showView('dashView');
    pollMyCases();
  }

  function logout() {
    profile = null; session = null; playGen++;
    try { sessionStorage.removeItem('sk_profile'); } catch (e) {}
    setVoice(false);
    showView('loginView');
  }

  /* ---------- boarding passes ---------- */

  function ticketHTML(b) {
    var cities = b.route.split('→').map(function (s) { return s.trim().toUpperCase(); });
    var stampCls = 'stamp-' + b.status;
    var stampTxt = b.status === 'cancelled' ? 'Cancelled' : (b.status === 'delayed' ? 'Delayed ' + b.delayHours + 'h' : 'On schedule');
    return '<div class="stub"><svg width="18" height="18" viewBox="0 0 26 26"><path d="M2 20 L13 4 L16 9 L24 20 L16 16 L10 20 Z" fill="#ffffff"/></svg><span class="air">SK AIRWAYS</span></div>' +
      '<div class="tmain">' +
        '<div class="trow1"><span class="route">' + esc(cities[0]) + '<span class="arr">→</span>' + esc(cities[1] || '') + '</span>' +
        '<span class="fno">' + esc(b.flight) + '</span></div>' +
        '<div class="tgrid">' +
          '<div class="tf"><div class="k">Date</div><div class="v">' + esc(b.date) + '</div></div>' +
          '<div class="tf"><div class="k">Scheduled</div><div class="v' + (b.newDep ? ' strike' : '') + '">' + esc(b.dep) + '</div></div>' +
          (b.newDep ? '<div class="tf"><div class="k">New departure</div><div class="v">' + esc(b.newDep) + '</div></div>' : '') +
          '<div class="tf"><div class="k">Status</div><div class="v">' + esc(b.statusText) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="tside"><span class="stamp ' + stampCls + '">' + esc(stampTxt) + '</span>' +
        '<span class="tpnr">PNR ' + esc(b.pnr) + '</span></div>';
  }

  function addTicketCards(customerId) {
    var m = $('messages');
    E.DATA.bookings.filter(function (b) { return b.customer === customerId; }).forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'ticket';
      el.innerHTML = ticketHTML(b);
      m.appendChild(el);
    });
    m.scrollTop = m.scrollHeight;
  }

  /* ---------- dashboard ---------- */

  function renderDash() {
    if (!profile) return;
    $('dashName').textContent = 'Hello, ' + profile.first;
    $('dashMeta').innerHTML =
      '<span class="tier tier-' + esc(profile.tier.toLowerCase()) + '">' + esc(profile.tier) + '</span>' +
      '<span class="mono" style="font-size:13px">PNR ' + esc(profile.pnr) + '</span>' +
      '<span style="opacity:.75">' + esc(profile.email) + '</span>';
    var fl = $('dashFlights');
    fl.innerHTML = '';
    E.DATA.bookings.filter(function (b) { return b.customer === profile.id; }).forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'ticket';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.innerHTML = ticketHTML(b);
      var ask = b.status === 'unaffected'
        ? 'Is my ' + b.route + ' flight on ' + b.date + ' still on schedule?'
        : 'What are my options for flight ' + b.flight + '?';
      el.addEventListener('click', function () { openChat(ask); });
      fl.appendChild(el);
    });
  }

  var myCasesTimer = null;
  async function pollMyCases() {
    if (!profile || !serverMode) return;
    try {
      var r = await fetch('/api/mycases?customer=' + encodeURIComponent(profile.id));
      if (!r.ok) return;
      var data = await r.json();
      var box = $('dashCases');
      var items = [];
      (data.cases || []).forEach(function (c) {
        c.tickets.forEach(function (t) {
          var st = t.handled ? (t.decision || 'handled') : 'open';
          items.push('<div class="feeditem tk' + (t.handled ? ' done' : '') + '"><span class="id">' + esc(t.id) + '</span><span>' + esc(t.label) + '</span><span class="st ' + esc(st) + '">' + esc(st.toUpperCase()) + '</span></div>');
        });
        c.actions.forEach(function (a) {
          items.push('<div class="feeditem"><span class="id">' + esc(a.id) + '</span><span>' + esc(a.label) + '</span></div>');
        });
      });
      box.innerHTML = items.length ? items.slice(0, 10).join('')
        : '<p class="empty-note">Nothing yet — raised tickets and agent actions appear here, live.</p>';
    } catch (e) { /* next poll */ }
  }

  /* ---------- chat ---------- */

  function updateWho(c) {
    if (!c) return;
    $('who-name').textContent = c.name;
    $('who-avatar').textContent = initials(c.name);
    $('who-tier').textContent = c.tier;
    $('who-pnr').textContent = 'PNR ' + c.pnr;
    if (!profile || profile.id !== c.id) {
      profile = E.DATA.customers[c.id] || profile;
      if (profile) { try { sessionStorage.setItem('sk_profile', profile.id); } catch (e) {} renderDash(); }
    }
  }

  function openChat(ask) {
    if (session && profile && session.customerId === profile.id) {
      showView('chatView');
      if (ask && !busy) submitMessage(ask);
      return;
    }
    pendingAsk = ask || null;
    openSession(profile ? profile.id : 'new', false);
  }

  async function openSession(id, autoplay) {
    playGen++;
    showView('chatView');
    var m = modeLabel();
    $('modeBadge').textContent = m.text;
    $('modeBadge').className = m.cls;
    $('who-case').textContent = '';
    $('messages').innerHTML = '';
    $('traceList').innerHTML = '<p class="empty-note">Rule checks appear here as Aria replies.</p>';
    $('ledgerList').innerHTML = '<p class="empty-note">No actions on this booking yet.</p>';
    $('escList').innerHTML = '<p class="empty-note">No escalations raised.</p>';
    $('traceCount').textContent = '0';
    $('ledgerCount').textContent = '0';
    $('escCount').textContent = '0';
    $('escBanner').classList.remove('show');
    $('userInput').value = '';
    setBusy(true);

    var opening = null;
    if (serverMode) {
      try {
        var data = await apiStart(id);
        session = { kind: 'api', id: data.sessionId, caseId: data.caseId, customerId: id, turn: 0 };
        if (data.caseId) $('who-case').textContent = data.caseId;
        opening = data;
      } catch (err) { serverMode = null; }
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
        addBubble('agent', 'The new-customer flow needs the AI agent — run node server.js locally, or retry once you’re online.');
        setBusy(false);
        return;
      } else {
        session = { kind: 'local', state: E.createSession(id), customerId: id };
        opening = E.openingMessage(session.state);
      }
    }

    if (session && id !== 'new') {
      addTicketCards(id);
      session.ticketShown = true;
    }
    await renderAgentTurn(opening, 'Session opened', 300);
    setBusy(false);
    if (pendingAsk) { var ask = pendingAsk; pendingAsk = null; submitMessage(ask); return; }
    if (autoplay) runAutoplay(playGen);
  }

  function setBusy(b) {
    busy = b;
    $('userInput').disabled = b;
    $('sendBtn').disabled = b;
  }

  function addBubble(kind, text) {
    var m = $('messages');
    var el = document.createElement('div');
    el.className = 'msg msg-' + kind;
    el.innerHTML = fmt(text);
    m.appendChild(el);
    var t = document.createElement('div');
    t.className = 'msg-time t-' + kind;
    t.textContent = (kind === 'agent' ? 'Aria · ' : '') + now();
    m.appendChild(t);
    m.scrollTop = m.scrollHeight;
    blip(kind === 'agent' ? 880 : 520, kind === 'agent' ? 0.05 : 0.06);
    buzz(kind === 'agent' ? 14 : 8);
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
    var labels = { data: 'Data', info: 'Note', allowed: 'Allowed', action: 'Action', blocked: 'Blocked', supervisor: 'Supervisor', escalated: 'Escalated' };
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
    var escalated = out.fullEscalated || (session && session.kind !== 'api' && session.state && session.state.fullEscalated);
    if (escalated) $('escBanner').classList.add('show');
  }

  function addResolutionCard(out) {
    var m = $('messages');
    if (out.actions && out.actions.length) {
      var el = document.createElement('div');
      el.className = 'rescard';
      var rows = out.actions.map(function (a) {
        return '<div class="rescard-row ok"><span>✓</span><div>' + esc(a.label) + ' <span class="rid">' + esc(a.id) + '</span></div></div>';
      }).join('');
      var caseRef = session && session.caseId ? ' · <span class="rid">' + esc(session.caseId) + '</span>' : '';
      el.innerHTML = '<div class="rescard-title">Done for you' + caseRef + '</div>' + rows;
      m.appendChild(el);
    }
    (out.escalations || []).forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tkr';
      el.innerHTML = '<div class="ic">🎫</div><div><b>Ticket raised</b> <span class="id">' + esc(t.id) + '</span>' +
        '<p>A human agent is reviewing this — the decision will appear right here and on your dashboard.</p></div>';
      m.appendChild(el);
      blip(660, 0.06); buzz(20);
    });
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
    if (out.customer) {
      updateWho(out.customer);
      if (session && !session.ticketShown) {
        addTicketCards(out.customer.id);
        session.ticketShown = true;
      }
    }
    addResolutionCard(out);
    renderTrace(out, turnLabel);
    renderLedger(out);
    if (out.chips) renderChips(out.chips);
    speakParts(parts, out);
  }

  /* ---------- message flow ---------- */

  async function sendToAgent(text) {
    if (session.kind === 'api') { session.turn++; return apiSend(text); }
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
      pollMyCases();
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

  /* ---------- supervisor updates ---------- */

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
      pollMyCases();
    } catch (e) { /* retry next poll */ }
  }

  /* ---------- voice mode (natural TTS via /api/tts, browser fallback) ---------- */

  var voiceOn = false;
  var audioEl = null;

  function setVoice(on) {
    voiceOn = on;
    $('voiceOverlay').classList.toggle('show', on);
    if (!on) {
      $('voiceOverlay').classList.remove('speaking');
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
      try { window.speechSynthesis.cancel(); } catch (e) {}
    } else {
      $('voiceStatus').textContent = 'Listening to the conversation';
    }
  }

  function pickBrowserVoice() {
    try {
      var vs = window.speechSynthesis.getVoices() || [];
      return vs.find(function (v) { return /en/i.test(v.lang) && /(natural|neural|online)/i.test(v.name); }) ||
             vs.find(function (v) { return /en/i.test(v.lang) && /google/i.test(v.name); }) ||
             vs.find(function (v) { return /^en/i.test(v.lang); }) || null;
    } catch (e) { return null; }
  }

  async function speakParts(parts, out) {
    if (!voiceOn || !parts || !parts.length) return;
    var text = parts.join(' ').replace(/\*\*/g, '').slice(0, 580);
    $('voiceText').textContent = text;
    var cards = [];
    (out && out.actions || []).forEach(function (a) { cards.push('<span class="pill" style="background:var(--good-bg);color:var(--good)">✓ ' + esc(a.id) + '</span>'); });
    (out && out.escalations || []).forEach(function (t) { cards.push('<span class="pill" style="background:var(--warn-bg);color:var(--warn)">🎫 ' + esc(t.id) + '</span>'); });
    $('voiceCards').innerHTML = cards.join('');
    $('voiceOverlay').classList.add('speaking');
    $('voiceStatus').textContent = 'Aria is speaking';
    var done = function () {
      $('voiceOverlay').classList.remove('speaking');
      $('voiceStatus').textContent = 'Listening to the conversation';
    };
    try {
      var r = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
      if (!r.ok) throw new Error('tts unavailable');
      var blob = await r.blob();
      audioEl = new Audio(URL.createObjectURL(blob));
      audioEl.onended = done;
      audioEl.onerror = done;
      await audioEl.play();
      return;
    } catch (e) { /* fall back to browser speech */ }
    try {
      var u = new SpeechSynthesisUtterance(text);
      var v = pickBrowserVoice();
      if (v) u.voice = v;
      u.rate = 1.02;
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { done(); }
  }

  /* ---------- wiring ---------- */

  document.addEventListener('DOMContentLoaded', async function () {
    // login
    $('loginInput').addEventListener('focus', function () { renderLoginList($('loginInput').value); });
    $('loginInput').addEventListener('input', function () { renderLoginList($('loginInput').value); });
    $('loginInput').addEventListener('blur', function () { setTimeout(function () { $('loginList').classList.remove('show'); }, 150); });
    $('loginInput').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var q = $('loginInput').value.trim().toLowerCase();
      var match = Object.keys(E.DATA.customers).map(function (id) { return E.DATA.customers[id]; })
        .filter(function (c) { return c.name.toLowerCase().indexOf(q) !== -1 || c.pnr.toLowerCase().indexOf(q) !== -1; });
      if (match.length === 1) login(match[0].id);
    });
    $('logoutBtn').addEventListener('click', logout);

    // dashboard
    $('dashChatBtn').addEventListener('click', function () { openChat(null); });
    $('dashVoiceBtn').addEventListener('click', function () { setVoice(true); openChat(null); });

    // chat
    $('sendBtn').addEventListener('click', function () { submitMessage($('userInput').value); });
    $('userInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitMessage($('userInput').value); }
    });
    $('backBtn').addEventListener('click', function () {
      playGen++;
      setVoice(false);
      if (profile) { renderDash(); showView('dashView'); pollMyCases(); } else { showView('loginView'); }
    });
    $('restartBtn').addEventListener('click', function () {
      if (session) openSession(session.customerId, false);
    });
    $('consoleToggle').addEventListener('click', function () { $('inspector').classList.toggle('open'); });
    $('voiceBtn').addEventListener('click', function () { setVoice(!voiceOn); });
    $('voiceClose').addEventListener('click', function () { setVoice(false); });

    // modals
    function bindModal(openId, overlayId, closeId) {
      $(openId).addEventListener('click', function () { $(overlayId).classList.add('show'); });
      $(closeId).addEventListener('click', function () { $(overlayId).classList.remove('show'); });
      $(overlayId).addEventListener('click', function (ev) {
        if (ev.target === $(overlayId)) $(overlayId).classList.remove('show');
      });
    }
    bindModal('dataBtn', 'dataOverlay', 'dataClose');
    bindModal('howBtn', 'howOverlay', 'howClose');
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        $('dataOverlay').classList.remove('show');
        $('howOverlay').classList.remove('show');
        setVoice(false);
      }
    });

    setInterval(pollNotices, 4000);
    setInterval(pollMyCases, 6000);
    try { window.speechSynthesis.getVoices(); } catch (e) {}

    await detectServer();

    // restore login / deep links (?p=priya|arvind|meher|new & play=1)
    var qs = new URLSearchParams(location.search);
    var qp = qs.get('p');
    var saved = null;
    try { saved = sessionStorage.getItem('sk_profile'); } catch (e) {}
    if (qp && E.DATA.customers[qp]) {
      profile = E.DATA.customers[qp];
      try { sessionStorage.setItem('sk_profile', qp); } catch (e) {}
      renderDash();
      if (qs.get('view') === 'dash') { showView('dashView'); pollMyCases(); }
      else openSession(qp, qs.get('play') === '1');
    } else if (qp === 'new') {
      openSession('new', false);
    } else if (saved && E.DATA.customers[saved]) {
      profile = E.DATA.customers[saved];
      renderDash();
      showView('dashView');
      pollMyCases();
    } else {
      showView('loginView');
    }
  });
})();
