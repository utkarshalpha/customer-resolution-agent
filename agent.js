/* ============================================================
   SK Airways — Customer Resolution Agent · Anthropic runner
   Claude (claude-opus-5) drives the conversation when an
   ANTHROPIC_API_KEY is available; every action goes through the
   deterministic policy layer in policy.js, which the model
   cannot bypass.
   ============================================================ */
'use strict';

const policy = require('./policy.js');

const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
const EFFORT = process.env.AGENT_EFFORT || 'low';
const MAX_LOOP = 8;

let _client = null;
function getClient() {
  if (_client) return _client;
  const mod = require('@anthropic-ai/sdk');
  const Anthropic = mod.default || mod;
  _client = new Anthropic();
  return _client;
}

async function runTurn(state, userText) {
  const out = { parts: [], trace: [], actions: [], escalations: [], fullEscalated: state.fullEscalated };
  state.turn++;

  state.messages.push({ role: 'user', content: userText });
  if (policy.LEGAL_RE.test(userText) && !state.fullEscalated) {
    // Operator note via mid-conversation system message (supported on claude-opus-5)
    state.messages.push({
      role: 'system',
      content: 'The customer’s last message contains a threat of legal action or a formal complaint. Policy requires IMMEDIATE escalation: call escalate_to_human with category legal_threat_or_formal_complaint now, then reply in the style of Sample C. Do not continue normal resolution first.'
    });
  }

  const client = getClient();

  for (let i = 0; i < MAX_LOOP; i++) {
    // Rebuilt every iteration: verify_identity can bind the customer mid-turn.
    const system = [{ type: 'text', text: policy.buildSystemPrompt(state), cache_control: { type: 'ephemeral' } }];
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: EFFORT },
        system,
        tools: policy.TOOLS,
        messages: state.messages
      });
    } catch (err) {
      // A custom AGENT_MODEL may not support mid-conversation system messages — retry without them
      if (err && err.status === 400 && /role 'system'/.test(String(err.message))) {
        state.messages = state.messages.filter(m => m.role !== 'system');
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 16000,
          output_config: { effort: EFFORT },
          system,
          tools: policy.TOOLS,
          messages: state.messages
        });
      } else {
        throw err;
      }
    }

    if (response.stop_reason === 'refusal') {
      out.parts.push('I’m sorry — I wasn’t able to process that message. Could you rephrase it? I can help with your booking, rebooking, refunds and delay assistance.');
      policy.trace(out, 'Model', 'stop_reason: refusal — safe fallback reply shown', 'info');
      break;
    }

    state.messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        block.text.trim().split(/\n{2,}/).forEach(p => out.parts.push(p.trim()));
      }
    }

    if (response.stop_reason === 'tool_use') {
      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        policy.trace(out, 'Agent decision', 'Tool call: ' + block.name + (Object.keys(block.input || {}).length ? ' ' + JSON.stringify(block.input) : ''), 'data');
        const result = policy.executeTool(state, out, block.name, block.input || {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      state.messages.push({ role: 'user', content: results });
      continue;
    }

    if (response.stop_reason === 'pause_turn') {
      continue;
    }
    break; // end_turn / max_tokens
  }

  out.fullEscalated = state.fullEscalated;
  return out;
}

module.exports = { runTurn, MODEL };
