'use strict';
/* Tests for the AI-mode policy layer (policy.js executeTool).
   No API key needed — this is the deterministic code the model cannot bypass. */
const agent = require('./policy.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  --> ' + extra : '')); }
}
function call(state, name, input) {
  const out = { parts: [], trace: [], actions: [], escalations: [], fullEscalated: false };
  const result = agent.executeTool(state, out, name, input || {});
  return { result, out };
}

/* ---------------- Arvind (Silver, delayed 4h) ---------------- */
console.log('\nPolicy layer — Arvind (delayed 4h)');
let a = agent.createAiSession('arvind');

let r = call(a, 'issue_delay_compensation');
check('voucher + lounge issued, no hotel', r.result.allowed && !r.result.hotel_included &&
  r.result.issued_now.join(',').includes('meal voucher') && r.result.issued_now.join(',').includes('lounge'));
check('hotel excluded with reason', /more than 5 hours/.test(r.result.hotel_note));
check('actions logged (VCH + LNG)', r.out.actions.length === 2);

r = call(a, 'issue_delay_compensation');
check('idempotent — nothing re-issued', r.result.issued_now.length === 0 && r.result.already_active.length === 2);

r = call(a, 'initiate_refund');
check('refund denied on delayed flight', r.result.allowed === false && /cancellation/i.test(r.result.reason));

r = call(a, 'rebook_free');
check('free rebooking denied (not cancelled)', r.result.allowed === false);

r = call(a, 'quote_fare_difference');
check('no invented fare for Arvind', r.result.allowed === false && /do not invent/i.test(r.result.reason));

r = call(a, 'escalate_to_human', { category: 'beyond_policy_compensation', reason: 'Hotel for a 4h delay' });
check('escalation creates ticket, not full escalation', r.result.allowed && r.result.ticket_id.startsWith('ESC') && !a.fullEscalated);

/* ---------------- Meher (Platinum, delayed 6h) ---------------- */
console.log('\nPolicy layer — Meher (delayed 6h)');
let m = agent.createAiSession('meher');

r = call(m, 'issue_delay_compensation');
check('voucher + lounge + hotel (delayed hours)', r.result.hotel_included && r.out.actions.length === 3);
check('hotel scoped to delayed hours, not full night', /not a full night/i.test(r.result.hotel_note));

r = call(m, 'rebook_paid_alternative', { customer_accepted_fare: true });
check('paid rebooking rejected before a quote', r.result.allowed === false && /quote/i.test(r.result.reason));

r = call(m, 'quote_fare_difference');
check('quote: ₹2,000 diff, above ₹1,500 limit', r.result.fare_difference_inr === 2000 &&
  r.result.exceeds_agent_waiver_limit === true && r.result.agent_waiver_limit_inr === 1500);
check('Platinum priority flagged', r.result.priority_rebooking === true);

r = call(m, 'rebook_paid_alternative', { customer_accepted_fare: false });
check('no acceptance → no rebooking, supervisor path named', r.result.allowed === false && /supervisor/i.test(r.result.reason));

r = call(m, 'rebook_paid_alternative', { customer_accepted_fare: true });
check('accepted → moved with Platinum priority', r.result.allowed === true && m.fareRebooked === true);

let mw = agent.createAiSession('meher');
call(mw, 'quote_fare_difference');
mw.waiverApproved = true;
r = call(mw, 'rebook_paid_alternative', { customer_accepted_fare: false });
check('supervisor waiver → free rebooking executes', r.result.allowed === true && r.result.fare_waived_by_supervisor === true && r.result.fare_difference_inr === 0);
check('waiver action labelled as waived', r.out.actions[0].label.indexOf('WAIVED') !== -1);

/* ---------------- Priya (Gold, cancelled) ---------------- */
console.log('\nPolicy layer — Priya (cancelled)');
let p = agent.createAiSession('priya');

r = call(p, 'issue_delay_compensation');
check('delay compensation denied on cancellation', r.result.allowed === false);

r = call(p, 'initiate_refund');
check('refund allowed: 7 business days, original method', r.result.allowed && /7 business days/.test(r.result.note) && /ORIGINAL payment method/i.test(r.result.note));

r = call(p, 'initiate_refund');
check('refund idempotent', r.result.already_done === true);

r = call(p, 'rebook_free');
check('rebooking blocked after refund', r.result.allowed === false && /refund/i.test(r.result.reason));

r = call(p, 'escalate_to_human', { category: 'legal_threat_or_formal_complaint', reason: 'Threatened legal action' });
check('legal threat → full escalation', r.result.allowed && p.fullEscalated === true && r.out.fullEscalated === true);

let p2 = agent.createAiSession('priya');
r = call(p2, 'rebook_free');
check('fresh Priya: free rebooking works with Gold priority', r.result.allowed && /Gold/.test(r.result.note));
r = call(p2, 'initiate_refund');
check('refund blocked after rebooking', r.result.allowed === false);

/* ---------------- Identity & knowledge base ---------------- */
console.log('\nIdentity & knowledge base');
let u = agent.createAiSession(null, 'CASE-20260923-0099');

r = call(u, 'issue_delay_compensation');
check('unverified session: action tools blocked', r.result.allowed === false && /verify/i.test(r.result.reason));

r = call(u, 'search_policy', { query: 'hotel for a long delay' });
check('KB search works unverified', r.result.allowed === true && r.result.results[0].policy_id === 'delay_compensation');
check('KB returns verbatim §3 text', /not a full night/i.test(r.result.results[0].text));

r = call(u, 'verify_identity', { booking_reference: 'ZZ9999' });
check('bad reference refused', r.result.allowed === false && u.customer === null);

r = call(u, 'verify_identity', { booking_reference: 'sk 4821x' });
check('verify binds customer (normalised PNR)', r.result.allowed === true && u.customer && u.customer.id === 'priya');
check('verify returns bookings, no re-asking needed', r.result.bookings.length === 2 && /Cancelled/.test(r.result.bookings[0]));

r = call(u, 'initiate_refund');
check('after verification, actions work', r.result.allowed === true && u.refundInitiated === true);

r = call(u, 'search_policy', { query: 'waive the fare difference' });
check('KB search: fare rule retrieved', r.result.results.some(x => x.policy_id === 'fare_difference'));

let u2 = agent.createAiSession(null, 'CASE-20260923-0100');
r = call(u2, 'escalate_to_human', { category: 'legal_threat_or_formal_complaint', reason: 'Legal threat before verification' });
check('legal escalation works even unverified', r.result.allowed === true && u2.fullEscalated === true);

check('case id stored on session', u.caseId === 'CASE-20260923-0099');

/* ---------------- Tool definitions sanity ---------------- */
console.log('\nTool definitions');
check('9 tools defined', agent.TOOLS.length === 9);
check('all tools strict with closed schemas', agent.TOOLS.every(t => t.strict === true && t.input_schema.additionalProperties === false));
check('escalation categories cover the prohibited list', (function () {
  const cats = agent.TOOLS.find(t => t.name === 'escalate_to_human').input_schema.properties.category.enum;
  return ['beyond_policy_compensation', 'fare_waiver_above_limit', 'non_airline_disruption',
    'legal_threat_or_formal_complaint', 'refund_method_change'].every(c => cats.includes(c));
})());

console.log('\n' + (failures === 0 ? 'ALL POLICY-LAYER TESTS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
