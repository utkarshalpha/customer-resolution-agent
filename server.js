/* ============================================================
   SK Airways — Customer Resolution Agent · server
   Serves the UI and the /api endpoints.

   AI providers, resolved in this order at startup:
     1. anthropic    — ANTHROPIC_API_KEY (Claude, needs `npm install`)
     2. groq         — GROQ_API_KEY        (free key, console.groq.com)
     3. gemini       — GEMINI_API_KEY      (free key, aistudio.google.com)
     4. openrouter   — OPENROUTER_API_KEY  (free models)
     5. custom       — LLM_BASE_URL + LLM_API_KEY (+ LLM_MODEL)
     6. pollinations — keyless free endpoint, probed at startup
     7. rules        — deterministic engine (always works)
   Force one with AGENT_PROVIDER=<name> (or "rules").
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./engine.js');
const policy = require('./policy.js');
const freeAgent = require('./agent-openai.js');

const PORT = Number(process.env.PORT || 3000);

/* ---------- optional ./config.json (gitignored) ---------- */

(function loadConfigJson() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const map = {
      apiKey: 'ANTHROPIC_API_KEY',
      anthropicApiKey: 'ANTHROPIC_API_KEY',
      groqApiKey: 'GROQ_API_KEY',
      geminiApiKey: 'GEMINI_API_KEY',
      openrouterApiKey: 'OPENROUTER_API_KEY',
      llmApiKey: 'LLM_API_KEY',
      llmBaseUrl: 'LLM_BASE_URL',
      llmModel: 'LLM_MODEL',
      provider: 'AGENT_PROVIDER'
    };
    for (const k of Object.keys(map)) {
      if (cfg[k] && !process.env[map[k]]) process.env[map[k]] = String(cfg[k]);
    }
  } catch (_) { /* no config.json — fine */ }
})();

/* ---------- runtime (mode/provider) resolution ---------- */

let RUNTIME = { mode: 'rules', provider: null, label: 'Rules engine', model: null, providerObj: null, reason: '' };
let anthropicAgent = null;

function useRules(reason) {
  RUNTIME = { mode: 'rules', provider: null, label: 'Rules engine', model: null, providerObj: null, reason };
}
function tryAnthropic() {
  if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return false;
  try {
    require('@anthropic-ai/sdk');
    anthropicAgent = require('./agent.js');
    RUNTIME = { mode: 'ai', provider: 'anthropic', label: 'Claude', model: anthropicAgent.MODEL, providerObj: null, reason: 'Anthropic credential found' };
    return true;
  } catch (e) {
    console.warn('  note: ANTHROPIC key found but @anthropic-ai/sdk not installed — run `npm install`. Trying free providers…');
    return false;
  }
}
function tryFree(name, reason) {
  const p = freeAgent.resolveProvider(name);
  if (!p) return false;
  RUNTIME = { mode: 'ai', provider: name, label: p.label, model: p.model, providerObj: p, reason: reason || (name + ' credential found') };
  return true;
}

async function resolveRuntime() {
  const forced = (process.env.AGENT_PROVIDER || '').toLowerCase().trim();
  if (forced === 'rules') return useRules('forced via AGENT_PROVIDER=rules');
  if (forced === 'anthropic') {
    if (!tryAnthropic()) useRules('AGENT_PROVIDER=anthropic but key or SDK missing');
    return;
  }
  if (forced && freeAgent.PRESETS[forced]) {
    if (!tryFree(forced, 'forced via AGENT_PROVIDER=' + forced)) useRules('AGENT_PROVIDER=' + forced + ' but its API key / base URL is missing');
    return;
  }

  // auto-detect
  if (tryAnthropic()) return;
  for (const name of ['groq', 'gemini', 'openrouter', 'custom']) {
    if (tryFree(name)) return;
  }
  // last resort: keyless free endpoint — probe it so we never advertise a dead AI mode
  process.stdout.write('  probing keyless free LLM (pollinations.ai)… ');
  const ok = await freeAgent.probe('pollinations');
  console.log(ok ? 'reachable' : 'unreachable');
  if (ok) return tryFree('pollinations', 'no API keys set — keyless free LLM is reachable');
  useRules('no LLM credentials and the keyless endpoint is unreachable');
}

/* ---------- persistent audit log (the non-negotiable record) ----------
   Every message, action, escalation and supervisor decision is appended to
   data/audit.jsonl as it happens. On boot the log is replayed, so completed
   cases — transcript included — survive restarts and stay visible in the
   Resolution Console and via GET /api/record. */

const DATA_DIR = path.join(__dirname, 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* exists */ }

function writeAudit(event) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n');
  } catch (e) { console.error('[audit write failed]', e.message); }
}

let caseCounter = 0;
const historicalCases = new Map(); // caseId -> case record rebuilt from the audit log
(function loadAudit() {
  let raw;
  try { raw = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch (_) { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    if (!ev.caseId) continue;
    let c = historicalCases.get(ev.caseId);
    if (!c) {
      c = { caseId: ev.caseId, createdAt: ev.at, mode: null, provider: null, customer: null, transcript: [], actions: [], tickets: [], fullEscalated: false, live: false };
      historicalCases.set(ev.caseId, c);
    }
    if (ev.event === 'session_opened') { c.mode = ev.mode; c.provider = ev.provider; c.createdAt = ev.at; }
    if (ev.event === 'identity_verified') c.customer = ev.customer;
    if (ev.event === 'customer_message') c.transcript.push({ who: 'customer', text: ev.text, at: ev.at });
    if (ev.event === 'agent_message') c.transcript.push({ who: ev.via === 'supervisor' ? 'supervisor' : 'agent', text: ev.text, at: ev.at });
    if (ev.event === 'action') c.actions.push({ id: ev.id, label: ev.label });
    if (ev.event === 'escalation') { c.tickets.push({ id: ev.id, label: ev.label, handled: false }); if (ev.full) c.fullEscalated = true; }
    if (ev.event === 'supervisor_decision') {
      const t = c.tickets.find(x => x.id === ev.ticketId);
      if (t) { t.handled = true; t.decision = ev.decision; }
    }
  }
  for (const id of historicalCases.keys()) {
    const n = parseInt(id.split('-').pop(), 10);
    if (n > caseCounter) caseCounter = n; // restarts never reuse a case id
  }
})();

/* ---------- sessions & cases ---------- */

const sessions = new Map(); // id -> { caseId, mode, provider, providerObj, state, actions[], tickets[], notices[], transcript[], createdAt, forceEscalated }
function newCaseId() {
  return 'CASE-20260923-' + String(++caseCounter).padStart(4, '0');
}

const PNR_CHIPS = ['My booking reference is SK4821X', 'My booking reference is TR1190B', 'My booking reference is WL7742'];

function chipsFor(state) {
  if (!state || !state.customer) return PNR_CHIPS;
  if (state.fullEscalated) return ['What is the status of my booking?'];
  const script = Engine.SCRIPTS[state.customer.id] || [];
  const idx = Math.min(state.turn, script.length);
  let chips = script.slice(idx, idx + 2);
  if (chips.length === 0) chips = ['What is the status of my booking?', 'This is unacceptable — I’m considering legal action.'];
  if (chips.length < 3) chips.push('What is the status of my booking?');
  return chips.slice(0, 3);
}

function customerOf(entry) {
  const c = entry.state && entry.state.customer;
  return c ? { id: c.id, name: c.name, tier: c.tier, pnr: c.pnr } : null;
}

function recordLedger(entry, out) {
  (out.actions || []).forEach(a => {
    entry.actions.push({ id: a.id, label: a.label });
    writeAudit({ caseId: entry.caseId, event: 'action', id: a.id, label: a.label });
  });
  (out.escalations || []).forEach(t => {
    entry.tickets.push({ id: t.id, label: t.label, handled: false });
    writeAudit({ caseId: entry.caseId, event: 'escalation', id: t.id, label: t.label, full: Boolean((entry.state && entry.state.fullEscalated) || entry.forceEscalated) });
  });
}

function recordTranscript(entry, who, text) {
  entry.transcript.push({ who, text, at: new Date().toISOString() });
  writeAudit({
    caseId: entry.caseId,
    event: who === 'customer' ? 'customer_message' : 'agent_message',
    via: who === 'supervisor' ? 'supervisor' : undefined,
    text
  });
}

function findPnrInText(text) {
  const condensed = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return Engine.DATA.bookings.find(b => condensed.includes(b.pnr.toUpperCase())) || null;
}

/* Rules mode, unverified session: deterministic identity gathering.
   Once a known PNR appears, bind an engine session and continue normally. */
function rulesUnboundTurn(entry, text) {
  const out = { parts: [], trace: [], actions: [], escalations: [], chips: PNR_CHIPS };
  if (entry.forceEscalated) {
    out.parts = ['Your case is with our specialist support team and they’ll be in touch directly. If you share your booking reference, they’ll use the contact details on that booking.'];
    return out;
  }
  if (policy.LEGAL_RE.test(text)) {
    entry.forceEscalated = true;
    const id = 'ESC-' + (7000 + entry.tickets.length + 1);
    out.escalations.push({ id, label: 'Legal-action / formal-complaint threat — immediate handover to specialist support (customer unverified)' });
    out.trace.push({ rule: '§4 Prohibited → escalate', detail: id + ' · Legal threat from an unverified customer — escalated immediately', verdict: 'escalated' });
    out.parts = ['I hear you, and I’m sorry this has been such a frustrating experience. I want to make sure this gets the right attention — I’m escalating this to our specialist support team right now. If you can share your booking reference, they’ll reach out on the contact details for that booking.'];
    return out;
  }
  const b = findPnrInText(text);
  if (!b) {
    out.trace.push({ rule: '§1 Identity', detail: 'No booking reference recognised in the message — asking again', verdict: 'info' });
    out.parts = ['I’d be glad to help. Could you share your booking reference (PNR) from your confirmation email so I can pull up your details?'];
    return out;
  }
  const state = Engine.createSession(b.customer);
  state.caseId = entry.caseId;
  entry.state = state;
  const cust = state.customer;
  out.trace.push({ rule: '§1 Identity', detail: 'Verified ' + cust.name + ' · ' + cust.tier + ' · PNR ' + cust.pnr, verdict: 'allowed' });
  const statusOut = Engine.handleMessage(state, 'what is the status of my booking?');
  out.parts = ['Thanks — you’re verified as ' + cust.name + ' (' + cust.tier + ' tier, PNR ' + cust.pnr + ').'].concat(statusOut.parts);
  out.trace = out.trace.concat(statusOut.trace);
  out.actions = statusOut.actions;
  out.escalations = statusOut.escalations;
  out.chips = statusOut.chips;
  return out;
}

/* Build the customer-facing update for a supervisor decision. For an approved
   fare-difference waiver, the rebooking actually executes through the policy
   layer (state.waiverApproved) — closing the human-in-the-loop circle. */
function buildDecisionNotice(entry, ticket, decision) {
  const out = { parts: [], trace: [], actions: [], escalations: [] };
  const state = entry.state;
  const isWaiver = /waiver/i.test(ticket.label);
  out.trace.push({
    rule: 'Supervisor decision',
    detail: ticket.id + ' → ' + decision.toUpperCase() + ' (Resolution Console)',
    verdict: decision === 'approved' ? 'supervisor' : 'blocked'
  });

  if (isWaiver && state && state.customer) {
    const diff = Engine.DATA.fareDifference[state.customer.id];
    const amount = typeof diff === 'number' ? '₹' + diff.toLocaleString('en-IN') : 'the fare difference';
    if (decision === 'approved') {
      state.waiverApproved = true;
      if (state.fareOffered) state.fareQuoted = true; // rules-engine sessions track the quote as fareOffered
      const result = policy.executeTool(state, out, 'rebook_paid_alternative', { customer_accepted_fare: false });
      if (result.allowed && result.already_done) {
        out.parts.push('Supervisor update on ticket ' + ticket.id + ': your ' + amount + ' fare-difference waiver has been APPROVED. Since you had already chosen to pay, the ' + amount + ' will be refunded to your original payment method.');
      } else if (result.allowed) {
        out.parts.push('Supervisor update on ticket ' + ticket.id + ': your ' + amount + ' fare-difference waiver has been APPROVED — I’ve moved you onto the alternative flight at no extra charge. Confirmation is on its way to ' + state.customer.email + '.');
      } else {
        out.parts.push('Supervisor update on ticket ' + ticket.id + ': your ' + amount + ' fare-difference waiver has been APPROVED. A colleague will complete the rebooking and confirm by email.');
      }
    } else {
      out.parts.push('Supervisor update on ticket ' + ticket.id + ': the fare-difference waiver was reviewed and can’t be approved — ' + amount + ' remains payable. You can pay it and be moved right away, or stay on your current flight with your delay assistance in place.');
    }
  } else {
    out.parts.push(decision === 'approved'
      ? 'Update on ticket ' + ticket.id + ': our support team has APPROVED your request — a colleague will complete it and confirm by email shortly.'
      : 'Update on ticket ' + ticket.id + ': our support team reviewed your request, and it can’t be approved beyond the standard policy. Everything you’re already entitled to stays in place.');
  }

  recordLedger(entry, out);
  writeAudit({ caseId: entry.caseId, event: 'supervisor_decision', ticketId: ticket.id, decision });
  out.parts.forEach(p => recordTranscript(entry, 'supervisor', p));
  if (entry.mode === 'ai' && state) {
    // keep the model's history consistent with what the customer was shown
    state.messages.push({ role: 'assistant', content: out.parts.join('\n\n') });
  }
  return out;
}

/* ---------- helpers ---------- */

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8']
};

/* ---------- request handling ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, mode: RUNTIME.mode, provider: RUNTIME.provider, label: RUNTIME.label, model: RUNTIME.model });
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      const body = await readBody(req);
      const customerId = String(body.customer || '');
      const unbound = customerId === 'new';
      if (!unbound && !Engine.DATA.customers[customerId]) return json(res, 400, { error: 'unknown customer' });

      const id = crypto.randomUUID();
      const caseId = newCaseId();
      let state = null, opening;
      if (RUNTIME.mode === 'ai') {
        state = policy.createAiSession(unbound ? null : customerId, caseId);
        opening = policy.openingTurn(state);
      } else if (unbound) {
        // rules mode, unverified: state is created once a PNR is matched
        opening = policy.openingTurn({ customer: null });
      } else {
        state = Engine.createSession(customerId);
        state.caseId = caseId;
        opening = Engine.openingMessage(state);
      }
      const entry = {
        caseId, mode: RUNTIME.mode, provider: RUNTIME.provider, providerObj: RUNTIME.providerObj,
        state, actions: [], tickets: [], notices: [], transcript: [], createdAt: new Date().toISOString(), forceEscalated: false
      };
      sessions.set(id, entry);
      writeAudit({ caseId, event: 'session_opened', mode: RUNTIME.mode, provider: RUNTIME.provider });
      const c0 = customerOf(entry);
      if (c0) writeAudit({ caseId, event: 'identity_verified', customer: c0 });
      opening.parts.forEach(p => recordTranscript(entry, 'agent', p));
      return json(res, 200, {
        sessionId: id,
        caseId,
        mode: RUNTIME.mode,
        provider: RUNTIME.provider,
        label: RUNTIME.label,
        customer: customerOf(entry),
        parts: opening.parts,
        trace: opening.trace,
        actions: [],
        escalations: [],
        chips: chipsFor(state),
        fullEscalated: false
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const entry = sessions.get(String(body.sessionId || ''));
      if (!entry) return json(res, 404, { error: 'unknown session — restart the chat' });
      const text = String(body.text || '').slice(0, 2000).trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      const prevCust = customerOf(entry);
      recordTranscript(entry, 'customer', text);

      let out;
      if (entry.mode === 'ai') {
        try {
          out = entry.provider === 'anthropic'
            ? await anthropicAgent.runTurn(entry.state, text)
            : await freeAgent.runTurn(entry.state, text, entry.providerObj);
        } catch (err) {
          console.error('[ai turn failed]', err && err.message ? err.message : err);
          const hint = entry.provider === 'pollinations'
            ? 'The keyless free LLM is busy or unreachable — try again in a moment, or set a free GROQ_API_KEY / GEMINI_API_KEY for a reliable provider.'
            : 'Check the server log and your API key for ' + entry.provider + '.';
          return json(res, 502, { error: 'The AI agent call failed. ' + hint });
        }
      } else if (!entry.state) {
        out = rulesUnboundTurn(entry, text);
      } else {
        out = Engine.handleMessage(entry.state, text);
      }
      recordLedger(entry, out);
      (out.parts || []).forEach(p => recordTranscript(entry, 'agent', p));
      const nowCust = customerOf(entry);
      if (!prevCust && nowCust) writeAudit({ caseId: entry.caseId, event: 'identity_verified', customer: nowCust });
      return json(res, 200, {
        mode: entry.mode,
        caseId: entry.caseId,
        customer: customerOf(entry),
        parts: out.parts,
        trace: out.trace,
        actions: out.actions,
        escalations: out.escalations,
        chips: (entry.mode === 'ai' || out.chips === undefined) ? chipsFor(entry.state) : out.chips,
        fullEscalated: Boolean((entry.state && entry.state.fullEscalated) || entry.forceEscalated)
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/cases') {
      const cases = [];
      const liveIds = new Set();
      for (const entry of sessions.values()) {
        liveIds.add(entry.caseId);
        cases.push({
          caseId: entry.caseId,
          mode: entry.mode,
          provider: entry.provider,
          customer: customerOf(entry),
          createdAt: entry.createdAt,
          transcript: entry.transcript,
          actions: entry.actions,
          tickets: entry.tickets,
          fullEscalated: Boolean((entry.state && entry.state.fullEscalated) || entry.forceEscalated),
          live: true
        });
      }
      for (const c of historicalCases.values()) {
        if (!liveIds.has(c.caseId)) cases.push(c);
      }
      cases.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json(res, 200, { cases });
    }

    /* Full case record — transcript + actions + tickets, downloadable. */
    if (req.method === 'GET' && url.pathname === '/api/record') {
      const caseId = String(url.searchParams.get('caseId') || '');
      let rec = null;
      for (const entry of sessions.values()) {
        if (entry.caseId !== caseId) continue;
        rec = {
          caseId, createdAt: entry.createdAt, mode: entry.mode, provider: entry.provider,
          customer: customerOf(entry), transcript: entry.transcript,
          actions: entry.actions, tickets: entry.tickets,
          fullEscalated: Boolean((entry.state && entry.state.fullEscalated) || entry.forceEscalated), live: true
        };
      }
      if (!rec) rec = historicalCases.get(caseId) || null;
      if (!rec) return json(res, 404, { error: 'unknown case' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + caseId + '.json"'
      });
      return res.end(JSON.stringify(rec, null, 2));
    }

    /* Supervisor decision from the console — flows back into the customer chat. */
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req);
      const decision = body.decision === 'approved' ? 'approved' : 'denied';
      for (const entry of sessions.values()) {
        if (entry.caseId !== String(body.caseId || '')) continue;
        const t = entry.tickets.find(x => x.id === String(body.ticketId || ''));
        if (!t) return json(res, 404, { error: 'ticket not found' });
        if (!t.handled) {
          t.handled = true;
          t.decision = decision;
          entry.notices.push(buildDecisionNotice(entry, t, decision));
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'case not found' });
    }

    /* The customer UI polls this for supervisor updates. */
    if (req.method === 'GET' && url.pathname === '/api/notices') {
      const entry = sessions.get(String(url.searchParams.get('sessionId') || ''));
      if (!entry) return json(res, 404, { error: 'unknown session' });
      const notices = entry.notices.splice(0);
      return json(res, 200, {
        notices,
        fullEscalated: Boolean((entry.state && entry.state.fullEscalated) || entry.forceEscalated)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/handle') {
      const body = await readBody(req);
      for (const entry of sessions.values()) {
        if (entry.caseId !== String(body.caseId || '')) continue;
        const t = entry.tickets.find(x => x.id === String(body.ticketId || ''));
        if (!t) return json(res, 404, { error: 'ticket not found' });
        t.handled = true;
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'case not found' });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const data = fs.readFileSync(path.join(__dirname, file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, 400, { error: String(err.message || err) });
  }
});

/* ---------- startup ---------- */

(async () => {
  console.log('SK Airways — Customer Resolution Agent');
  await resolveRuntime();
  server.listen(PORT, () => {
    console.log('  Mode : ' + RUNTIME.mode.toUpperCase() + (RUNTIME.provider ? ' · ' + RUNTIME.label : '') + '  (' + RUNTIME.reason + ')');
    if (RUNTIME.model) console.log('  Model: ' + RUNTIME.model);
    console.log('  URL  : http://localhost:' + PORT);
  });
})();
