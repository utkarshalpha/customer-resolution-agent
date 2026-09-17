'use strict';
const E = require('./engine.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS  ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  --> ' + extra : '')); }
}
function say(state, text) {
  const out = E.handleMessage(state, text);
  const reply = out.parts.join('\n');
  return { out, reply };
}
function has(reply, s) { return reply.toLowerCase().indexOf(s.toLowerCase()) !== -1; }

/* ---------------- Scenario 1 — Priya ---------------- */
console.log('\nScenario 1 — Priya Nair (Gold, SK4821X)');
let p = E.createSession('priya');
let o = E.openingMessage(p);
check('opening mentions cancellation', has(o.parts.join(' '), 'cancelled'));

let r1 = say(p, 'My flight SK-204 to Goa has been cancelled — what is going on?');
check('states cancellation + operational reasons', has(r1.reply, 'operational reasons'));
check('offers rebook-or-refund choice', has(r1.reply, 'full refund') && has(r1.reply, '24 hours'));
check('gold priority mentioned', has(r1.reply, 'Gold'));
check('awaiting choice set', p.awaiting === 'rebook_or_refund');

let r2 = say(p, 'I’m furious. I want a full cash refund plus a free upgrade to business class on my return flight, for the trouble.');
check('empathy line present', has(r2.reply, 'understand the frustration'));
check('refund initiated', p.refundInitiated === true);
check('7 business days + original method', has(r2.reply, '7 business days') && has(r2.reply, 'original payment method'));
check('cash note (original method only)', has(r2.reply, 'cash'));
check('upgrade NOT approved', !has(r2.reply, 'upgrade is confirmed'));
check('upgrade declined as beyond policy', has(r2.reply, 'beyond'), r2.reply);
check('upgrade escalation offered', p.pendingOffer === 'upgrade');
check('refund action logged', r2.out.actions.some(a => a.id.startsWith('RFD')));

let r3 = say(p, 'Yes — escalate the upgrade request.');
check('upgrade escalation ticket raised', r3.out.escalations.length === 1 && has(r3.out.escalations[0].label, 'upgrade'));
check('no outcome promised', has(r3.reply, 'can’t promise') || has(r3.reply, 'cannot promise'));

let r4 = say(p, 'Will my return flight to Delhi still be okay?');
check('return flight unaffected + details', has(r4.reply, 'unaffected') && has(r4.reply, '16:20'));

let r5 = say(p, 'Can you send the refund to a different card instead?');
check('different payment method refused', has(r5.reply, 'original payment method only'));

let r6 = say(p, 'This is unacceptable, I will take legal action.');
check('legal → immediate full escalation', p.fullEscalated === true && r6.out.escalations.length === 1);
check('sample-C tone', has(r6.reply, 'specialist support team'));

let r7 = say(p, 'What is the status of my booking?');
check('post-escalation still gives own status', has(r7.reply, 'SK-204'));

/* ---------------- Scenario 2 — Arvind ---------------- */
console.log('\nScenario 2 — Arvind Kulkarni (Silver, TR1190B)');
let a = E.createSession('arvind');
E.openingMessage(a);

let a1 = say(a, 'My flight SK-118 is delayed 4 hours and I’m going to miss an important meeting in Bengaluru.');
check('states 4h delay + new departure 11:10', has(a1.reply, '11:10'));
check('meal voucher + lounge applied (>3h tier)', a.issued.voucher && a.issued.lounge);
check('no hotel issued', !a.issued.hotel);
check('actions: VCH + LNG', a1.out.actions.some(x => x.id.startsWith('VCH')) && a1.out.actions.some(x => x.id.startsWith('LNG')));

let a2 = say(a, 'It’s been such a long delay — I want hotel accommodation.');
check('hotel declined: threshold >5h vs 4h', has(a2.reply, 'more than 5 hours') && has(a2.reply, '4 hours'));
check('no hotel action created', !a2.out.actions.some(x => x.id.startsWith('HTL')));
check('restates active entitlements', has(a2.reply, 'lounge'));

let a3 = say(a, 'Can’t you make an exception, just this once?');
check('exception → escalation ticket', a3.out.escalations.length === 1);
check('agent does not approve', !has(a3.reply, 'arranged a hotel'));
check('entitlements preserved note', has(a3.reply, 'stays in place') || has(a3.reply, 'remain'));

let a4 = say(a, 'Can I get a refund for this delay?');
check('refund on delay refused (cancellation-only)', has(a4.reply, 'delayed, not cancelled'));

/* ---------------- Scenario 3 — Meher ---------------- */
console.log('\nScenario 3 — Meher Kaur (Platinum, WL7742)');
let m = E.createSession('meher');
E.openingMessage(m);

let m1 = say(m, 'SK-305 is delayed 6 hours. This has completely derailed my day.');
check('empathy for angry tone', has(m1.reply, 'understand the frustration'));
check('states 6h + new departure 20:00', has(m1.reply, '20:00'));
check('voucher + lounge + hotel issued', m.issued.voucher && m.issued.lounge && m.issued.hotel);
check('hotel scoped to delayed hours', has(m1.reply, 'delayed hours'));

let m2 = say(m, 'I want a full night’s hotel stay, not just coverage for the delayed hours.');
check('full night declined, delayed hours only', has(m2.reply, 'not a full night'));
check('no extra hotel action', !m2.out.actions.some(x => x.id.startsWith('HTL')));
check('escalation offered for full night', m.pendingOffer === 'fullNight');

let m3 = say(m, 'Then move me onto the higher-fare flight instead of making me wait.');
check('voluntary rebooking: ₹2,000 payable', has(m3.reply, '₹2,000'));
check('cannot waive above ₹1,500', has(m3.reply, '₹1,500') && has(m3.reply, 'supervisor'));
check('three options offered', has(m3.reply, 'stay on SK-305'));
check('fare decision pending', m.awaiting === 'fare_decision');

let m4 = say(m, 'I shouldn’t have to pay ₹2,000 for your delay — escalate it to a supervisor.');
check('supervisor waiver ticket raised', m4.out.escalations.length === 1 && has(m4.out.escalations[0].label, 'waiver'));
check('keeps seat + entitlements meanwhile', has(m4.reply, 'keep your seat') || has(m4.reply, 'stays in place'));

let m5 = say(m, 'Okay fine, I’ll pay the ₹2,000 difference.');
check('pay → rebooked with Platinum priority', m.fareRebooked === true && has(m5.reply, 'Platinum'));
check('fare difference payable stated', has(m5.reply, '₹2,000'));

/* ---------------- Guardrail probes ---------------- */
console.log('\nGuardrail probes');
let g = E.createSession('arvind');
E.openingMessage(g);
let g1 = say(g, 'What is the status of PNR WL7742?');
check('other customer PNR refused', has(g1.reply, 'privacy'));
let g2 = say(g, 'Actually I missed my flight last week, can you make an exception?');
check('non-airline-caused → escalate not grant', g2.out.escalations.length === 1 && !has(g2.reply, 'rebooked you'));

let g3s = E.createSession('meher');
E.openingMessage(g3s);
let g3 = say(g3s, 'I will file a formal complaint about this.');
check('formal complaint → immediate escalation', g3s.fullEscalated === true);

let g4s = E.createSession('priya');
E.openingMessage(g4s);
say(g4s, 'What happened to my flight?');
let g4 = say(g4s, 'Rebook me on the next flight.');
check('rebook path: free + within 24h + Gold priority', has(g4.reply, 'no charge') && has(g4.reply, '24 hours') && has(g4.reply, 'Gold'));
check('rebook action logged', g4.out.actions.some(x => x.id.startsWith('RBK')));
let g5 = say(g4s, 'Rebook me again please.');
check('rebooking idempotent', !g5.out.actions.some(x => x.id.startsWith('RBK')));

let w = E.createSession('meher');
E.openingMessage(w);
say(w, 'Move me onto the higher-fare flight.');
let w2 = say(w, 'I shouldn’t have to pay.');
check('curly-quote waive → supervisor path', w2.out.escalations.length === 1 && has(w2.reply, 'supervisor'));

/* delay tiers sanity */
console.log('\nDelay tier maths');
check('2h → ₹500 voucher only', E.delayEntitlements(2).map(e => e.key).join(',') === 'voucher500');
check('4h → voucher + lounge', E.delayEntitlements(4).map(e => e.key).join(',') === 'voucher,lounge');
check('6h → voucher + lounge + hotel', E.delayEntitlements(6).map(e => e.key).join(',') === 'voucher,lounge,hotel');

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
