/* ============================================================
   SK Airways — Customer Resolution Agent · shared policy layer
   Provider-independent: the system prompt, the tool definitions,
   and the deterministic policy checks that no model can bypass.
   Used by agent.js (Anthropic) and agent-openai.js (free LLMs).
   Grounded only in the assignment data pack.
   ============================================================ */
'use strict';

/* Runs in Node (server) and the browser (static/GitHub Pages deployments). */
const Engine = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : window.Engine;
const KB = (typeof module !== 'undefined' && module.exports) ? require('./kb.js') : window.KB;
const DATA = Engine.DATA;

const LEGAL_RE = /\b(legal action|legal|sue|suing|lawsuit|lawyer|court|formal complaint|consumer forum)\b/i;

/* ---------- session state (AI mode) ---------- */

/* customerId may be null → an UNVERIFIED session: the agent must collect a
   booking reference and call verify_identity before any account action. */
function createAiSession(customerId, caseId) {
  return {
    caseId: caseId || null,
    startedVerified: Boolean(customerId),
    customer: customerId ? DATA.customers[customerId] : null,
    messages: [],            // format is owned by the runner (Anthropic or OpenAI-compatible)
    turn: 0,
    counters: { esc: 0, vch: 0, lng: 0, htl: 0, rfd: 0, rbk: 0 },
    issued: {},
    refundInitiated: false,
    rebooked: false,
    fareQuoted: false,
    fareRebooked: false,
    fullEscalated: false,
    tickets: []
  };
}

function nextId(state, kind) {
  const bases = { esc: 7000, vch: 2300, lng: 1100, htl: 5500, rfd: 9000, rbk: 3300 };
  const prefixes = { esc: 'ESC', vch: 'VCH', lng: 'LNG', htl: 'HTL', rfd: 'RFD', rbk: 'RBK' };
  state.counters[kind]++;
  return prefixes[kind] + '-' + (bases[kind] + state.counters[kind]);
}

function disrupted(state) {
  if (!state.customer) return null;
  return DATA.bookings.filter(b => b.customer === state.customer.id && b.status !== 'unaffected')[0] || null;
}

/* ---------- system prompt (stable per customer) ---------- */

function openingText(customer) {
  return Engine.openingMessage({ customer, turn: 0 }).parts.join(' ');
}

function caseLine(state) {
  return state && state.caseId
    ? '\n\nCase ID for this conversation: ' + state.caseId + ' — quote it when you summarise a completed resolution or an escalation.'
    : '';
}

/* Prompt for a session where no customer has been verified yet. */
function buildUnverifiedPrompt(state) {
  return `You are the customer-facing virtual resolution agent for SK Airways. Today is Wednesday, 23 September 2026 — a day of disruption. The customer in this chat has NOT been identified yet.

# Identity first — nothing else proceeds without it
- Briefly acknowledge their issue, then ask for their booking reference (PNR).
- The moment they provide anything that looks like a booking reference, call verify_identity with it.
- NEVER discuss any account, booking, flight, or personal data before verify_identity succeeds. You have no customer data until then.
- If the reference doesn't match, say so and ask them to double-check it. Never guess, never proceed unverified.
- Ask only for what is missing — once verified, the system gives you their profile and bookings; do not re-ask for things you already know.

# What you may do before verification
- Answer general policy questions using search_policy (it returns the verbatim service rules with section ids). Quote the rules faithfully; never extrapolate.
- Threats of legal action or a formal complaint must be escalated IMMEDIATELY via escalate_to_human (category legal_threat_or_formal_complaint), even before verification.

# Tone — match these SK Airways samples
Sample A — Customer: "My flight got cancelled and no one told me anything!" → Agent: "I completely understand the frustration — I can see flight SK-190 was cancelled due to operational reasons. I can rebook you on the next available flight at no extra cost, or process a full refund. Which would you prefer?"
Sample C — Customer: "This is unacceptable, I'm going to file a formal complaint and consider legal action." → Agent: "I hear you, and I'm sorry this has been such a frustrating experience. I want to make sure this gets the right attention — I'm escalating this to our specialist support team right now, and they'll reach out to you directly."

Keep replies short and human: one to three brief paragraphs.${caseLine(state)}`;
}

function buildSystemPrompt(state) {
  const customer = state.customer;
  if (!customer) return buildUnverifiedPrompt(state);
  const rows = DATA.bookings
    .filter(b => b.customer === customer.id)
    .map(b => `- Flight ${b.flight} · ${b.route} · ${b.date} · scheduled departure ${b.dep} · STATUS: ${b.statusText}`)
    .join('\n');

  return `You are the customer-facing virtual resolution agent for SK Airways. Today is Wednesday, 23 September 2026 — a day of disruption. You are chatting with one verified customer.

# The verified customer — the ONLY passenger whose information you may discuss
- Name: ${customer.name}
- Loyalty tier: ${customer.tier}
- Booking reference (PNR): ${customer.pnr}
- Contact: ${customer.email}, ${customer.phone}
- Travel history (last 12 months): ${customer.history}

## Their bookings (authoritative — the only flight data that exists)
${rows}

# Service rules (apply these exactly; there are no other policies)
1. Cancellation Rebooking Rule: if a flight is cancelled by the airline, the customer is entitled to a free rebooking on the next available flight within 24 hours, OR a full refund — the customer's choice.
2. Delay Compensation Rule: delay under 3 hours → ₹500 meal voucher. Delay more than 3 hours → meal voucher + lounge access. Delay more than 5 hours → meal voucher + hotel accommodation covering ONLY the delayed hours (explicitly not a full night's stay).
3. Refund Processing Rule: refunds for airline-caused cancellations are processed in full within 7 business days, to the original payment method ONLY.
4. Fare Difference Rule: a voluntary rebooking onto a higher-fare flight (not airline-caused) means the customer pays the fare difference. You cannot waive a difference above ₹1,500 — that needs supervisor approval.
5. Loyalty Tier Rule: Gold and Platinum get priority rebooking (first access to next-available seats) but NO additional compensation beyond standard policy.

# Allowed actions (each has a tool — actions happen ONLY through tools)
- Rebook on the next available flight within 24 hours at no charge (airline-caused cancellation) → rebook_free
- Issue meal vouchers / lounge access / delayed-hours hotel per the delay rule → issue_delay_compensation
- Initiate a refund for an airline-caused cancellation → initiate_refund
- Quote and process a voluntary move to a higher-fare flight → quote_fare_difference, then rebook_paid_alternative
- Provide this customer's own booking and flight status information (it is all above)

# Prohibited — you must escalate to a human instead (tool: escalate_to_human)
- Approving ANY compensation beyond the stated policy (upgrades, extra vouchers, full-night hotel, cash goodwill)
- Waiving a fare difference above ₹1,500 (supervisor approval required)
- Making exceptions for non-airline-caused disruptions (e.g. the customer missed a flight)
- Handling threats of legal action or formal complaints — escalate IMMEDIATELY (category legal_threat_or_formal_complaint), do not continue resolving
- Processing a refund to any payment method other than the original

# How you work
- Ground every statement in the data above. NEVER invent flights, times, seats, fares, hotels, or policies. The only fare figure you may quote is what quote_fare_difference returns.
- For a DELAYED flight, never offer a refund or a free rebooking — those remedies exist only for airline-caused CANCELLATIONS. A delayed customer's options are exactly: the delay assistance above, a voluntary paid move to the alternative flight (quote_fare_difference first), or waiting for the delayed departure.
- The ₹500 voucher amount applies ONLY to delays under 3 hours. For longer delays say "meal voucher" with no amount — policy does not specify one.

# Knowledge base
- search_policy returns the verbatim service-rule text with section ids. Use it when you need the exact wording, when the customer disputes a rule, or before explaining an entitlement you have not already confirmed in this conversation. Quote what it returns faithfully.
- get_booking_details re-fetches this customer's bookings if you need to re-check a fact mid-conversation.
- Never claim an action happened unless the tool result confirms it. If a tool returns allowed=false, relay the policy reason warmly, offer the in-policy alternative, and offer escalation.
- For beyond-policy requests: explain the policy, offer what IS possible, and offer to escalate to a human. If the customer insists or explicitly asks, call escalate_to_human. Never promise an escalation's outcome.
- Answer nothing about any other passenger or PNR — politely decline for privacy.
- Keep replies short and human: one to three brief paragraphs. Use ₹ amounts exactly as given.
- Once a legal-threat escalation has happened, the specialist team owns the case: offer only status information and reassurance afterwards.

# Tone — match these SK Airways samples
Sample A — Customer: "My flight got cancelled and no one told me anything!" → Agent: "I completely understand the frustration — I can see flight SK-190 was cancelled due to operational reasons. I can rebook you on the next available flight at no extra cost, or process a full refund. Which would you prefer?"
Sample B — Customer: "I want compensation, this delay ruined my whole day." → Agent: "I'm sorry for the disruption. Your flight was delayed 3 hours 40 minutes, which qualifies for a meal voucher and lounge access under our policy. I've applied both to your account now."
Sample C — Customer: "This is unacceptable, I'm going to file a formal complaint and consider legal action." → Agent: "I hear you, and I'm sorry this has been such a frustrating experience. I want to make sure this gets the right attention — I'm escalating this to our specialist support team right now, and they'll reach out to you directly."

# Conversation so far
${state.startedVerified
    ? `You have already greeted the customer with: "${openingText(customer)}" — do not repeat this greeting.`
    : 'The customer was verified mid-conversation via their booking reference. Address them by name and continue resolving the issue they described — do not restart the conversation or re-ask what they already told you.'}${caseLine(state)}`;
}

/* ---------- tool definitions (neutral JSON Schema) ---------- */

const TOOLS = [
  {
    name: 'verify_identity',
    description: 'Verify the customer by their booking reference (PNR) and bind this session to their profile. Call this the MOMENT the customer provides anything that looks like a booking reference — no account or booking information exists until it succeeds. On success it returns their profile and bookings, so never re-ask for details it returns. If it fails, ask the customer to double-check the reference; never guess.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        booking_reference: {
          type: 'string',
          description: 'The booking reference / PNR exactly as the customer gave it (formatting is normalised automatically)'
        }
      },
      required: ['booking_reference'],
      additionalProperties: false
    }
  },
  {
    name: 'search_policy',
    description: 'Search the airline’s service-rule knowledge base and get the VERBATIM policy text with section ids. Use it when you need the exact wording of a rule, when the customer disputes a rule, or before explaining an entitlement you have not already confirmed in this conversation. Works before identity verification too — the rules are public. Quote the returned text faithfully; never extrapolate beyond it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look up, e.g. "hotel for long delay", "refund payment method", "fare difference waiver"'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'get_booking_details',
    description: 'Re-fetch the verified customer’s bookings and current flight statuses. Use it to re-check a fact mid-conversation. Requires identity to be verified first.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'issue_delay_compensation',
    description: 'Apply the delay assistance the customer’s delayed flight qualifies for under the Delay Compensation Rule (meal voucher; lounge access if delay > 3h; hotel for the delayed hours only if delay > 5h). Call this when a customer with a DELAYED flight asks about compensation, food, lounge, or hotel, or when you inform them of their entitlements. Idempotent — safe to call again; already-issued items are reported, never duplicated. Returns exactly what is now active and what the policy excludes.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'rebook_free',
    description: 'Rebook the customer free of charge on the next available flight within 24 hours. ONLY valid when their flight was CANCELLED by the airline (Cancellation Rebooking Rule). Call this when a customer with a cancelled flight chooses rebooking over a refund. Fails with a policy reason for delayed flights or if a refund is already in progress.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'initiate_refund',
    description: 'Initiate a full refund for an airline-caused CANCELLATION — processed within 7 business days to the original payment method only. Call this when a customer with a cancelled flight chooses the refund. Fails with a policy reason for delayed (not cancelled) flights, or if the customer was already rebooked.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'quote_fare_difference',
    description: 'Get the fare difference for a VOLUNTARY move to the alternative higher-fare flight (only applies when the customer’s flight is delayed, not cancelled, and they want to switch instead of waiting). Call this BEFORE discussing any paid rebooking — never invent a fare figure. The result includes the amount, whether it exceeds your ₹1,500 waiver limit, and the customer’s rebooking priority.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'rebook_paid_alternative',
    description: 'Move the customer onto the quoted higher-fare alternative flight. Call ONLY after quote_fare_difference AND only when the customer has explicitly agreed to pay the fare difference. Set customer_accepted_fare=true only if they clearly accepted paying it in this conversation.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        customer_accepted_fare: {
          type: 'boolean',
          description: 'true only if the customer explicitly agreed in this conversation to pay the quoted fare difference'
        }
      },
      required: ['customer_accepted_fare'],
      additionalProperties: false
    }
  },
  {
    name: 'escalate_to_human',
    description: 'Raise a ticket to a human agent / supervisor / specialist support team. Call this whenever a request falls under the Prohibited list: compensation beyond policy (upgrades, full-night hotel, extra goodwill), a fare-difference waiver above ₹1,500 (goes to a supervisor), exceptions for non-airline-caused disruptions, a refund to a different payment method, or — IMMEDIATELY — any threat of legal action or a formal complaint. Also use it when the customer explicitly asks for a human.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'beyond_policy_compensation',
            'fare_waiver_above_limit',
            'non_airline_disruption',
            'legal_threat_or_formal_complaint',
            'refund_method_change',
            'customer_requested_human'
          ],
          description: 'Which prohibited/escalation case this is'
        },
        reason: {
          type: 'string',
          description: 'One concise sentence describing what the customer asked for'
        }
      },
      required: ['category', 'reason'],
      additionalProperties: false
    }
  }
];

/* ---------- deterministic policy layer (no model can bypass this) ---------- */

function trace(out, rule, detail, verdict) {
  out.trace.push({ rule, detail, verdict });
}
function action(out, state, kind, label) {
  const id = nextId(state, kind);
  out.actions.push({ id, label });
  trace(out, 'Action', id + ' · ' + label, 'action');
  return id;
}

function executeTool(state, out, name, input) {
  /* --- tools that work before identity verification --- */

  if (name === 'verify_identity') {
    const ref = String(input.booking_reference || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (state.customer) {
      trace(out, '§1 Identity', 'Already verified as ' + state.customer.name + ' (PNR ' + state.customer.pnr + ')', 'info');
      return { allowed: true, already_verified: true, customer: { name: state.customer.name, tier: state.customer.tier, pnr: state.customer.pnr } };
    }
    const booking = DATA.bookings.find(b => b.pnr.toUpperCase() === ref);
    if (!booking) {
      trace(out, '§1 Identity', 'No booking matches reference "' + (ref || '—') + '" → verification refused', 'blocked');
      return { allowed: false, reason: 'No booking matches that reference. Ask the customer to double-check their PNR — do not guess and do not proceed unverified.' };
    }
    state.customer = DATA.customers[booking.customer];
    const cust = state.customer;
    trace(out, '§1 Identity', 'Verified ' + cust.name + ' · ' + cust.tier + ' · PNR ' + cust.pnr, 'allowed');
    const rows = DATA.bookings.filter(b => b.customer === cust.id).map(b => {
      trace(out, '§2 Booking data', b.flight + ' ' + b.route + ' · ' + b.date + ' ' + b.dep + ' · ' + b.statusText, 'data');
      return b.flight + ' · ' + b.route + ' · ' + b.date + ' · dep ' + b.dep + ' · ' + b.statusText;
    });
    return {
      allowed: true,
      customer: { name: cust.name, tier: cust.tier, pnr: cust.pnr, email: cust.email, history: cust.history },
      bookings: rows,
      note: 'Identity verified. Greet ' + cust.name.split(' ')[0] + ' by name and address the disruption shown in their bookings — do not re-ask for anything returned here.'
    };
  }

  if (name === 'search_policy') {
    const results = KB.searchPolicy(input.query, 3);
    trace(out, 'Knowledge base', 'search_policy("' + String(input.query || '').slice(0, 60) + '") → ' + (results.length ? results.map(r => r.policy_id).join(', ') : 'no match'), 'data');
    return {
      allowed: true,
      results,
      note: results.length ? 'Quote these rules faithfully; do not extrapolate beyond them.' : 'No rule matched — say the policy does not cover it rather than inventing one.'
    };
  }

  const c = state.customer;
  const d = disrupted(state);

  /* --- everything below (except escalation) needs a verified customer --- */
  if (!c && name !== 'escalate_to_human') {
    trace(out, '§1 Identity', 'Tool "' + name + '" refused — customer not verified', 'blocked');
    return { allowed: false, reason: 'Customer identity is not verified yet. Ask for their booking reference (PNR) and call verify_identity first.' };
  }

  if (name === 'get_booking_details') {
    const rows = DATA.bookings.filter(b => b.customer === c.id).map(b => {
      trace(out, '§2 Booking data', b.flight + ' ' + b.route + ' · ' + b.date + ' ' + b.dep + ' · ' + b.statusText, 'data');
      return b.flight + ' · ' + b.route + ' · ' + b.date + ' · dep ' + b.dep + ' · ' + b.statusText;
    });
    return { allowed: true, customer: { name: c.name, tier: c.tier, pnr: c.pnr }, bookings: rows };
  }

  if (name === 'issue_delay_compensation') {
    if (!d || d.status !== 'delayed') {
      trace(out, '§3 Delay Compensation Rule', 'Flight is not delayed — delay assistance does not apply', 'blocked');
      return { allowed: false, reason: 'The Delay Compensation Rule applies only to delayed flights. This customer’s disrupted flight is ' + (d ? d.statusText : 'not delayed') + '. For a cancellation the remedy is free rebooking within 24 hours or a full refund.' };
    }
    const ents = Engine.delayEntitlements(d.delayHours);
    const nowIssued = [];
    const alreadyActive = [];
    ents.forEach(e => {
      trace(out, '§3 Delay Compensation Rule', d.delayHours + 'h delay → ' + e.tier + ' tier → ' + e.label, 'allowed');
      if (state.issued[e.key]) { alreadyActive.push(e.label); return; }
      const kind = e.key === 'lounge' ? 'lng' : (e.key === 'hotel' ? 'htl' : 'vch');
      const label = e.key === 'hotel'
        ? 'Hotel accommodation arranged — delayed hours only (' + d.dep + '–' + d.newDep + '), ' + c.pnr
        : e.label.charAt(0).toUpperCase() + e.label.slice(1) + ' issued — ' + c.pnr;
      state.issued[e.key] = action(out, state, kind, label);
      nowIssued.push(e.label);
    });
    const hotelIncluded = ents.some(e => e.key === 'hotel');
    if (!hotelIncluded) {
      trace(out, '§3 Delay Compensation Rule', d.delayHours + 'h ≤ 5h → hotel accommodation does NOT apply', 'blocked');
    }
    return {
      allowed: true,
      delay_hours: d.delayHours,
      new_departure: d.newDep,
      issued_now: nowIssued,
      already_active: alreadyActive,
      hotel_included: hotelIncluded,
      hotel_note: hotelIncluded
        ? 'Hotel covers ONLY the delayed hours (' + d.dep + '–' + d.newDep + '), explicitly not a full night’s stay. A full night cannot be approved — escalate if the customer insists.'
        : 'Hotel accommodation requires a delay of more than 5 hours; this delay is ' + d.delayHours + ' hours, so it cannot be arranged. Escalate if the customer insists on an exception.'
    };
  }

  if (name === 'rebook_free') {
    if (!d || d.status !== 'cancelled') {
      trace(out, '§3 Cancellation Rebooking Rule', 'Flight is not cancelled — free rebooking does not apply', 'blocked');
      return { allowed: false, reason: 'Free rebooking applies only to airline-caused cancellations. This flight is ' + (d ? d.statusText : 'not cancelled') + '. A voluntary move to a different flight means the customer pays the fare difference (use quote_fare_difference).' };
    }
    if (state.refundInitiated) {
      trace(out, 'Booking state', 'Refund already in progress — rebooking would need a human to reverse it', 'blocked');
      return { allowed: false, reason: 'A full refund is already in progress for this flight, so there is no active booking to move. Reversing a refund needs a human agent — offer escalation.' };
    }
    if (state.rebooked) {
      trace(out, '§3 Cancellation Rebooking Rule', 'Already rebooked — idempotent, no duplicate', 'info');
      return { allowed: true, already_done: true, note: 'The customer is already rebooked on the next available flight; confirmation goes to ' + c.email + '.' };
    }
    state.rebooked = true;
    trace(out, '§3 Cancellation Rebooking Rule', 'Airline-caused cancellation → free rebooking on next available flight within 24 hours', 'allowed');
    const priority = (c.tier === 'Gold' || c.tier === 'Platinum');
    if (priority) trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking (first access to next-available seats), no additional compensation', 'allowed');
    action(out, state, 'rbk', 'Rebooked free of charge on next available ' + d.route + ' flight within 24 hours' + (priority ? ' (' + c.tier + ' priority)' : ''));
    return {
      allowed: true,
      note: 'Rebooked at no charge on the next available ' + d.route + ' flight departing within 24 hours.' + (priority ? ' ' + c.tier + ' tier gives priority access to next-available seats.' : '') + ' Confirmed flight details go to ' + c.email + '. Do not invent a specific flight number or time — none is in the system.'
    };
  }

  if (name === 'initiate_refund') {
    if (!d || d.status !== 'cancelled') {
      trace(out, '§3 Refund Processing Rule', 'Full refunds apply to airline-caused cancellations — this flight is ' + (d ? d.statusText : 'not cancelled'), 'blocked');
      return { allowed: false, reason: 'Full refunds apply only to airline-caused cancellations. This flight is delayed, not cancelled — offer the delay assistance instead (issue_delay_compensation).' };
    }
    if (state.rebooked) {
      trace(out, 'Booking state', 'Customer already rebooked — switching to a refund needs human review', 'blocked');
      return { allowed: false, reason: 'The customer is already rebooked; unwinding that for a refund needs a human agent — offer escalation.' };
    }
    if (state.refundInitiated) {
      trace(out, '§3 Refund Processing Rule', 'Refund already in progress — idempotent, no duplicate', 'info');
      return { allowed: true, already_done: true, note: 'Refund already in progress: full amount within 7 business days to the original payment method.' };
    }
    state.refundInitiated = true;
    trace(out, '§3 Cancellation Rebooking Rule', d.flight + ' cancelled by airline → customer chose the full refund', 'allowed');
    trace(out, '§3 Refund Processing Rule', 'Full refund → within 7 business days → original payment method only', 'allowed');
    action(out, state, 'rfd', 'Full refund initiated for cancelled flight ' + d.flight + ' — 7 business days, original payment method');
    return {
      allowed: true,
      note: 'Full refund initiated for ' + d.flight + ': processed within 7 business days, to the ORIGINAL payment method only (no cash, no other card/account — that would need escalation). Confirmation goes to ' + c.email + '.'
    };
  }

  if (name === 'quote_fare_difference') {
    if (!d || d.status !== 'delayed') {
      trace(out, '§3 Fare Difference Rule', 'Voluntary paid rebooking applies to delayed flights; this one is ' + (d ? d.statusText : 'not disrupted'), 'blocked');
      return { allowed: false, reason: 'This customer’s flight is cancelled, so they are entitled to a FREE rebooking within 24 hours (rebook_free) or a refund — no fare difference applies.' };
    }
    const diff = DATA.fareDifference[c.id];
    if (typeof diff !== 'number') {
      trace(out, '§3 Fare Difference Rule', 'No alternative flight is in the system for this booking', 'info');
      return { allowed: false, reason: 'No specific alternative flight or fare is in the system for this booking — do not invent one. Explain that a voluntary move means paying the fare difference, and that you cannot waive more than ₹1,500 without supervisor approval.' };
    }
    state.fareQuoted = true;
    trace(out, '§3 Cancellation Rebooking Rule', d.flight + ' is delayed, not cancelled → free rebooking does not apply', 'info');
    trace(out, '§3 Fare Difference Rule', 'Voluntary move to higher-fare flight → fare difference of ₹' + diff.toLocaleString('en-IN') + ' payable', 'allowed');
    trace(out, '§3 Fare Difference Rule', '₹' + diff.toLocaleString('en-IN') + ' > ₹1,500 → agent cannot waive without supervisor approval', 'supervisor');
    return {
      allowed: true,
      fare_difference_inr: diff,
      agent_waiver_limit_inr: DATA.waiverLimit,
      exceeds_agent_waiver_limit: diff > DATA.waiverLimit,
      priority_rebooking: c.tier === 'Gold' || c.tier === 'Platinum',
      note: 'The customer’s options: pay the ₹' + diff.toLocaleString('en-IN') + ' and be moved now; request a supervisor waiver review (escalate_to_human, category fare_waiver_above_limit); or stay on ' + d.flight + ' (departing ' + d.newDep + ') with their delay assistance.'
    };
  }

  if (name === 'rebook_paid_alternative') {
    const diff = DATA.fareDifference[c.id];
    if (!d || d.status !== 'delayed' || typeof diff !== 'number') {
      trace(out, '§3 Fare Difference Rule', 'No quoted alternative flight applies to this booking', 'blocked');
      return { allowed: false, reason: 'There is no quoted alternative flight for this booking.' };
    }
    if (!state.fareQuoted && !state.waiverApproved) {
      trace(out, 'Policy layer', 'rebook_paid_alternative called before quote_fare_difference — rejected', 'blocked');
      return { allowed: false, reason: 'Quote the fare difference first (quote_fare_difference) and get the customer’s explicit agreement to pay it.' };
    }
    const waived = state.waiverApproved === true;
    if (input.customer_accepted_fare !== true && !waived) {
      trace(out, '§3 Fare Difference Rule', 'Customer has not agreed to pay ₹' + diff.toLocaleString('en-IN') + ' — cannot proceed; waiver needs a supervisor', 'blocked');
      return { allowed: false, reason: 'The customer has not agreed to pay the ₹' + diff.toLocaleString('en-IN') + ' fare difference. You cannot waive it (above your ₹1,500 limit). Offer: pay and move, supervisor waiver review (escalate_to_human), or stay on ' + d.flight + '.' };
    }
    if (state.fareRebooked) {
      trace(out, 'Booking state', 'Already moved to the alternative flight — idempotent', 'info');
      return { allowed: true, already_done: true };
    }
    state.fareRebooked = true;
    if (waived) {
      trace(out, '§3 Fare Difference Rule', 'Supervisor approved the ₹' + diff.toLocaleString('en-IN') + ' waiver → rebooking proceeds at no charge', 'supervisor');
    } else {
      trace(out, '§3 Fare Difference Rule', 'Customer accepted the ₹' + diff.toLocaleString('en-IN') + ' fare difference → rebooking proceeds', 'allowed');
    }
    const priority = (c.tier === 'Gold' || c.tier === 'Platinum');
    if (priority) trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking, no additional compensation', 'allowed');
    action(out, state, 'rbk', waived
      ? 'Moved to the higher-fare alternative flight — ₹' + diff.toLocaleString('en-IN') + ' fare difference WAIVED by supervisor approval' + (priority ? ', ' + c.tier + ' priority' : '')
      : 'Moved to the higher-fare alternative flight — ₹' + diff.toLocaleString('en-IN') + ' fare difference payable' + (priority ? ', ' + c.tier + ' priority' : ''));
    return {
      allowed: true,
      fare_difference_inr: waived ? 0 : diff,
      fare_waived_by_supervisor: waived,
      note: 'Moved to the alternative flight' + (priority ? ' with ' + c.tier + ' priority' : '') + '. ' + (waived
        ? 'The ₹' + diff.toLocaleString('en-IN') + ' fare difference was waived under supervisor approval — nothing to pay.'
        : 'The ₹' + diff.toLocaleString('en-IN') + ' fare difference is payable before ticketing.') + ' Confirmation goes to ' + c.email + '. Any delayed-hours hotel is released once rebooked; the meal voucher stays valid.'
    };
  }

  if (name === 'escalate_to_human') {
    const category = String(input.category || 'customer_requested_human');
    const reason = String(input.reason || 'Customer request').slice(0, 300);
    const labels = {
      beyond_policy_compensation: 'Compensation beyond stated policy requested',
      fare_waiver_above_limit: 'Fare-difference waiver above ₹1,500 — needs supervisor approval',
      non_airline_disruption: 'Non-airline-caused disruption — no agent exceptions permitted',
      legal_threat_or_formal_complaint: 'Legal-action / formal-complaint threat — immediate handover to specialist support',
      refund_method_change: 'Refund requested to a non-original payment method — prohibited for the agent',
      customer_requested_human: 'Customer asked for a human agent'
    };
    trace(out, '§4 Prohibited → escalate', (labels[category] || category) + ' — ' + reason, category === 'fare_waiver_above_limit' ? 'supervisor' : 'blocked');
    const id = nextId(state, 'esc');
    const ticket = { id, label: (labels[category] || category) + ': ' + reason };
    state.tickets.push(ticket);
    out.escalations.push(ticket);
    trace(out, 'Escalation', id + ' · ' + ticket.label, 'escalated');
    if (category === 'legal_threat_or_formal_complaint') {
      state.fullEscalated = true;
      out.fullEscalated = true;
    }
    return {
      allowed: true,
      ticket_id: id,
      note: 'Ticket ' + id + ' raised. A human will contact the customer at ' + (c ? c.email : 'the contact details on file once their identity is confirmed') + '. Do not promise any outcome.' + (category === 'legal_threat_or_formal_complaint' ? ' The specialist support team now owns this case — respond in the style of Sample C and only provide status information from here on.' : '')
    };
  }

  trace(out, 'Policy layer', 'Unknown tool "' + name + '" — rejected', 'blocked');
  return { allowed: false, reason: 'Unknown tool.' };
}

/* ---------- opening turn (deterministic, no API call) ---------- */

function openingTurn(state) {
  const out = { parts: [], trace: [], actions: [], escalations: [], fullEscalated: false };
  if (!state.customer) {
    out.parts = ['Hello! I’m the SK Airways virtual resolution agent. I can help with disrupted flights — rebooking, refunds and delay assistance. Could you tell me what happened, and share your booking reference (PNR) so I can pull up your details?'];
    out.trace = [{ rule: '§1 Identity', detail: 'Session started unverified — a booking reference must be verified before any account action', verdict: 'info' }];
    return out;
  }
  const opening = Engine.openingMessage({ customer: state.customer, turn: 0 });
  out.parts = opening.parts;
  out.trace = opening.trace;
  return out;
}

const POLICY_EXPORTS = { createAiSession, buildSystemPrompt, TOOLS, executeTool, openingTurn, LEGAL_RE, trace };
if (typeof module !== 'undefined' && module.exports) module.exports = POLICY_EXPORTS;
if (typeof window !== 'undefined') window.Policy = POLICY_EXPORTS;
