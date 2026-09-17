/* ============================================================
   SK Airways — Customer Resolution Agent · free-LLM runner
   Drives the conversation with any OpenAI-compatible chat API.
   Zero dependencies (Node 18+ built-in fetch). Every action still
   goes through the deterministic policy layer in policy.js.

   Providers (all free):
   - pollinations  — keyless, works with no setup at all (default fallback)
   - groq          — free API key at console.groq.com (no card)
   - gemini        — free API key at aistudio.google.com (no card)
   - openrouter    — free models with a free account
   - custom        — any OpenAI-compatible endpoint via LLM_BASE_URL
   ============================================================ */
'use strict';

/* Runs in Node (server) and the browser (static/GitHub Pages deployments,
   where the keyless provider is called directly from the page). */
const policy = (typeof module !== 'undefined' && module.exports) ? require('./policy.js') : window.Policy;
const ENV = (typeof process !== 'undefined' && process.env) ? process.env : {};

const PRESETS = {
  groq: {
    label: 'Groq · GPT-OSS 120B',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    fallbackModel: 'openai/gpt-oss-20b', // when the 120B is TPM-throttled
    keyEnv: 'GROQ_API_KEY'
  },
  gemini: {
    label: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    keyEnv: 'GEMINI_API_KEY'
  },
  openrouter: {
    label: 'OpenRouter (free model)',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY'
  },
  pollinations: {
    label: 'Pollinations (keyless)',
    url: 'https://text.pollinations.ai/openai',
    model: 'openai',
    keyEnv: null
  },
  custom: {
    label: 'Custom endpoint',
    url: null, // from LLM_BASE_URL
    model: null, // from LLM_MODEL
    keyEnv: 'LLM_API_KEY'
  }
};

function resolveProvider(name) {
  const preset = PRESETS[name];
  if (!preset) return null;
  const p = { name, label: preset.label, url: preset.url, model: preset.model, fallbackModel: preset.fallbackModel || null, key: null };
  if (name === 'custom') {
    const base = ENV.LLM_BASE_URL;
    if (!base) return null;
    p.url = base.replace(/\/+$/, '') + '/chat/completions';
    p.model = ENV.LLM_MODEL || 'gpt-4o-mini';
    p.label = 'Custom · ' + p.model;
  }
  if (preset.keyEnv) {
    p.key = ENV[preset.keyEnv] || null;
    if (!p.key && name !== 'pollinations') return null;
  }
  if (ENV.LLM_MODEL && name !== 'custom') p.model = ENV.LLM_MODEL;
  return p;
}

/* ---------- HTTP ---------- */

async function chatOnce(provider, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.key) headers['Authorization'] = 'Bearer ' + provider.key;
    const res = await fetch(provider.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('LLM API error HTTP ' + res.status + ': ' + text.slice(0, 300));
      err.status = res.status;
      const ra = parseFloat(res.headers.get('retry-after') || '0') * 1000;
      const m = text.match(/try again in ([0-9.]+)s/i);
      err.retryAfterMs = ra || (m ? parseFloat(m[1]) * 1000 : 0);
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* Free tiers and the keyless endpoint drop connections and rate-limit —
   retry network errors and 5xx with a short backoff, honour retry-after on
   429s, and drop to the provider's fallback model if the big one stays
   throttled (e.g. Groq: gpt-oss-120b → gpt-oss-20b). */
async function chat(provider, body, _noFallback) {
  const delays = [0, 1500, 4000];
  let lastErr = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    let wait = delays[attempt];
    if (lastErr && lastErr.status === 429 && lastErr.retryAfterMs) {
      wait = Math.min(lastErr.retryAfterMs + 500, 30000);
    }
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      return await chatOnce(provider, body);
    } catch (err) {
      lastErr = err;
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (!retryable) throw err;
    }
  }
  if (!_noFallback && provider.fallbackModel && body.model !== provider.fallbackModel && lastErr && lastErr.status === 429) {
    return chat(provider, Object.assign({}, body, { model: provider.fallbackModel }), true);
  }
  throw lastErr;
}

/* Quick startup probe for the keyless provider (~1 token).
   Hard-capped at 8s with no retries, so page/server startup never hangs
   on a slow endpoint — a failed probe just means the rules fallback. */
async function probe(providerName) {
  const provider = resolveProvider(providerName);
  if (!provider) return false;
  try {
    const r = await Promise.race([
      chatOnce(provider, {
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 5
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 8000))
    ]);
    return Boolean(r.choices && r.choices[0] && r.choices[0].message);
  } catch (e) {
    return false;
  }
}

/* ---------- tool format conversion ---------- */

const OA_TOOLS = policy.TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

/* ---------- the agent loop ---------- */

const MAX_LOOP = 8;

async function runTurn(state, userText, provider) {
  const out = { parts: [], trace: [], actions: [], escalations: [], fullEscalated: state.fullEscalated };
  state.turn++;

  let content = userText;
  if (policy.LEGAL_RE.test(userText) && !state.fullEscalated) {
    content += '\n\n[OPERATOR NOTE — policy enforcement: this message contains a threat of legal action or a formal complaint. You must IMMEDIATELY call escalate_to_human with category legal_threat_or_formal_complaint, then reply in the style of Sample C. Do not continue normal resolution first.]';
  }
  state.messages.push({ role: 'user', content });

  for (let i = 0; i < MAX_LOOP; i++) {
    // System prompt is rebuilt every iteration: verify_identity can bind the
    // customer mid-turn, and the next call must see the full verified context.
    const response = await chat(provider, {
      model: provider.model,
      messages: [{ role: 'system', content: policy.buildSystemPrompt(state) }].concat(state.messages),
      tools: OA_TOOLS,
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 1024
    });

    const choice = response.choices && response.choices[0];
    if (!choice || !choice.message) {
      throw new Error('LLM returned an empty response');
    }
    const msg = choice.message;

    const assistantMsg = { role: 'assistant', content: msg.content || '' };
    if (msg.tool_calls && msg.tool_calls.length) assistantMsg.tool_calls = msg.tool_calls;
    state.messages.push(assistantMsg);

    if (msg.content && msg.content.trim()) {
      msg.content.trim().split(/\n{2,}/).forEach(p => { if (p.trim()) out.parts.push(p.trim()); });
    }

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* tolerate sloppy JSON from small models */ }
        policy.trace(out, 'Agent decision', 'Tool call: ' + tc.function.name + (Object.keys(input).length ? ' ' + JSON.stringify(input) : ''), 'data');
        const result = policy.executeTool(state, out, tc.function.name, input);
        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    break; // finished — no more tool calls
  }

  if (out.parts.length === 0) {
    out.parts.push('Is there anything else I can help with on your booking?');
  }
  out.fullEscalated = state.fullEscalated;
  return out;
}

const AGENT_FREE_EXPORTS = { runTurn, resolveProvider, probe, PRESETS };
if (typeof module !== 'undefined' && module.exports) module.exports = AGENT_FREE_EXPORTS;
if (typeof window !== 'undefined') window.AgentFree = AGENT_FREE_EXPORTS;
