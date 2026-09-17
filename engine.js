/* ============================================================
   SK Airways — Customer Resolution Agent
   Assignment 3 (AIONOS) — deterministic policy engine
   Every rule, amount and fact below is grounded in the Data Pack.
   Sections referenced: §1 Profiles, §2 Bookings, §3 Service Rules,
   §4 Allowed/Prohibited, §5 Tone samples, §6 Scenarios.
   ============================================================ */
'use strict';

var DATA = {
  airline: 'SK Airways',
  setOn: 'Wednesday, 23 September 2026',
  customers: {
    priya: {
      id: 'priya', name: 'Priya Nair', first: 'Priya', tier: 'Gold', pnr: 'SK4821X',
      email: 'priya.nair@example.com', phone: '+91-98xxxxxxx1',
      history: '6 flights in the last 12 months · 1 prior complaint (delayed baggage, resolved with voucher)'
    },
    arvind: {
      id: 'arvind', name: 'Arvind Kulkarni', first: 'Arvind', tier: 'Silver', pnr: 'TR1190B',
      email: 'arvind.kulkarni@example.com', phone: '+91-98xxxxxxx2',
      history: '3 flights in the last 12 months · no prior complaints'
    },
    meher: {
      id: 'meher', name: 'Meher Kaur', first: 'Meher', tier: 'Platinum', pnr: 'WL7742',
      email: 'meher.kaur@example.com', phone: '+91-98xxxxxxx3',
      history: '10 flights in the last 12 months · 1 prior complaint (overbooking, resolved with a tier-status upgrade)'
    }
  },
  bookings: [
    { customer: 'priya', pnr: 'SK4821X', flight: 'SK-204', route: 'Delhi → Goa', date: 'Wed 23 Sep 2026', dep: '18:40', status: 'cancelled', statusText: 'Cancelled (operational reasons)' },
    { customer: 'priya', pnr: 'SK4821X', flight: 'Return', route: 'Goa → Delhi', date: 'Fri 25 Sep 2026', dep: '16:20', status: 'unaffected', statusText: 'Unaffected' },
    { customer: 'arvind', pnr: 'TR1190B', flight: 'SK-118', route: 'Mumbai → Bengaluru', date: 'Wed 23 Sep 2026', dep: '07:10', status: 'delayed', delayHours: 4, newDep: '11:10', statusText: 'Delayed 4h (new departure 11:10)' },
    { customer: 'meher', pnr: 'WL7742', flight: 'SK-305', route: 'Delhi → Hyderabad', date: 'Wed 23 Sep 2026', dep: '14:00', status: 'delayed', delayHours: 6, newDep: '20:00', statusText: 'Delayed 6h (new departure 20:00)' }
  ],
  // §6 Scenario 3: the alternative higher-fare flight Meher asks about carries a ₹2,000 fare difference.
  fareDifference: { meher: 2000 },
  waiverLimit: 1500 // §3 Fare Difference Rule: agents cannot waive above ₹1,500 without supervisor approval
};

/* ---------- helpers ---------- */

function bookingsFor(id) {
  return DATA.bookings.filter(function (b) { return b.customer === id; });
}
function disruptedBooking(id) {
  return bookingsFor(id).filter(function (b) { return b.status !== 'unaffected'; })[0] || null;
}
function inr(n) { return '₹' + n.toLocaleString('en-IN'); }

/* §3 Delay Compensation Rule, applied literally: every tier whose
   condition holds contributes its entitlement. */
function delayEntitlements(hours) {
  var e = [];
  if (hours < 3) e.push({ key: 'voucher500', label: '₹500 meal voucher', tier: 'under 3 hours' });
  if (hours > 3) e.push({ key: 'voucher', label: 'meal voucher', tier: 'more than 3 hours' });
  if (hours > 3) e.push({ key: 'lounge', label: 'lounge access', tier: 'more than 3 hours' });
  if (hours > 5) e.push({ key: 'hotel', label: 'hotel accommodation for the delayed hours only', tier: 'more than 5 hours' });
  return e;
}

/* ---------- session ---------- */

function createSession(customerId) {
  var c = DATA.customers[customerId];
  return {
    customer: c,
    turn: 0,
    counters: { esc: 0, vch: 0, lng: 0, htl: 0, rfd: 0, rbk: 0 },
    issued: {},            // entitlement key -> ledger id
    refundInitiated: false,
    rebooked: false,
    fareRebooked: false,
    awaiting: null,        // 'rebook_or_refund' | 'fare_decision'
    fareOffered: false,
    pendingOffer: null,    // 'upgrade' | 'fullNight' | 'hotelException' | 'waiver' | 'diffMethod' | 'compExtra'
    declined: {},          // topic -> true (first polite decline given)
    fullEscalated: false,
    escalatedTopics: {},
    tickets: []
  };
}

function nextId(state, kind) {
  var bases = { esc: 7000, vch: 2300, lng: 1100, htl: 5500, rfd: 9000, rbk: 3300 };
  var prefixes = { esc: 'ESC', vch: 'VCH', lng: 'LNG', htl: 'HTL', rfd: 'RFD', rbk: 'RBK' };
  state.counters[kind]++;
  return prefixes[kind] + '-' + (bases[kind] + state.counters[kind]);
}

/* ---------- output assembly ---------- */

function makeOut() {
  return { parts: [], trace: [], actions: [], escalations: [], chips: [], fullEscalated: false };
}
function trace(out, rule, detail, verdict) {
  out.trace.push({ rule: rule, detail: detail, verdict: verdict });
}
function action(out, state, kind, label) {
  var id = nextId(state, kind);
  out.actions.push({ id: id, label: label });
  trace(out, 'Action', id + ' · ' + label, 'action');
  return id;
}
function escalate(out, state, label) {
  var id = nextId(state, 'esc');
  var t = { id: id, label: label };
  state.tickets.push(t);
  out.escalations.push(t);
  trace(out, '§4 Prohibited → escalate', id + ' · ' + label, 'escalated');
  return id;
}

/* ---------- opening message ---------- */

function openingMessage(state) {
  var c = state.customer;
  var out = makeOut();
  var d = disruptedBooking(c.id);
  var msg = 'Hello ' + c.first + ', I’m the ' + DATA.airline + ' virtual resolution agent. You’re verified on booking ' + c.pnr + ' (' + c.tier + ' tier).';
  trace(out, '§1 Customer profile', c.name + ' · ' + c.tier + ' · PNR ' + c.pnr, 'data');
  if (d) {
    if (d.status === 'cancelled') {
      msg += ' I can see flight ' + d.flight + ' (' + d.route + ') today shows as cancelled due to operational reasons — I’m sorry about that.';
    } else {
      msg += ' I can see flight ' + d.flight + ' (' + d.route + ') today is delayed by ' + d.delayHours + ' hours — I’m sorry about that.';
    }
    trace(out, '§2 Booking data', d.flight + ' · ' + d.statusText, 'data');
  }
  msg += ' I can help with flight status, rebooking, refunds and delay assistance. How can I help?';
  out.parts.push(msg);
  out.chips = suggestChips(state);
  return out;
}

/* ---------- entitlement issuing (delayed flights) ---------- */

function ensureDelayComp(state, out) {
  var c = state.customer;
  var d = disruptedBooking(c.id);
  if (!d || d.status !== 'delayed') return [];
  var ents = delayEntitlements(d.delayHours);
  var granted = [];
  ents.forEach(function (e) {
    trace(out, '§3 Delay Compensation Rule', d.delayHours + 'h delay → ' + e.tier + ' tier → ' + e.label, 'allowed');
    if (!state.issued[e.key]) {
      var kind = e.key === 'lounge' ? 'lng' : (e.key === 'hotel' ? 'htl' : 'vch');
      var label = e.key === 'hotel'
        ? 'Hotel accommodation arranged — delayed hours only (' + d.dep + '–' + d.newDep + '), ' + c.pnr
        : (e.label.charAt(0).toUpperCase() + e.label.slice(1)) + ' issued — ' + c.pnr;
      state.issued[e.key] = action(out, state, kind, label);
      granted.push(e);
    }
  });
  return granted;
}

function entitlementSentence(state, freshlyGranted) {
  var d = disruptedBooking(state.customer.id);
  var names = delayEntitlements(d.delayHours).map(function (e) {
    return e.key === 'hotel' ? 'hotel accommodation covering the delayed hours (' + d.dep + '–' + d.newDep + ', not a full night’s stay)' : e.label;
  });
  var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  if (freshlyGranted.length > 0) {
    return 'Because the delay is more than ' + (d.delayHours > 5 ? '5' : '3') + ' hours, policy entitles you to ' + list + ' — I’ve applied this to your booking now.';
  }
  return 'Your delay assistance — ' + list + ' — is already applied to your booking.';
}

/* ---------- chips ---------- */

var SCRIPTS = {
  priya: [
    'My flight SK-204 to Goa has been cancelled — what is going on?',
    'I’m furious. I want a full cash refund plus a free upgrade to business class on my return flight, for the trouble.',
    'Yes — escalate the upgrade request.',
    'Will my return flight to Delhi still be okay?'
  ],
  arvind: [
    'My flight SK-118 is delayed 4 hours and I’m going to miss an important meeting in Bengaluru.',
    'It’s been such a long delay — I want hotel accommodation.',
    'Can’t you make an exception, just this once?'
  ],
  meher: [
    'SK-305 is delayed 6 hours. This has completely derailed my day.',
    'I want a full night’s hotel stay, not just coverage for the delayed hours.',
    'Then move me onto the higher-fare flight instead of making me wait.',
    'I shouldn’t have to pay ₹2,000 for your delay — escalate it to a supervisor.'
  ]
};

function suggestChips(state) {
  var id = state.customer.id;
  var chips = [];
  if (state.fullEscalated) return ['What is the status of my booking?'];
  if (state.awaiting === 'rebook_or_refund') {
    chips = ['I’d like the full refund.', 'Rebook me on the next flight.'];
  } else if (state.awaiting === 'fare_decision') {
    chips = ['Okay, I’ll pay the ₹2,000 difference.', 'I shouldn’t have to pay — escalate it to a supervisor.', 'I’ll stay on SK-305 then.'];
  } else if (state.pendingOffer === 'upgrade') {
    chips = ['Yes — escalate the upgrade request.', 'Fine, forget the upgrade.'];
  } else if (state.pendingOffer === 'fullNight') {
    chips = ['Yes, escalate that request.', 'Then move me onto the higher-fare flight instead of making me wait.'];
  } else {
    // walk the scenario script: first line not yet "used" heuristically by state
    var script = SCRIPTS[id] || [];
    var idx = Math.min(state.turn, script.length);
    chips = script.slice(idx, idx + 2);
    if (chips.length === 0) {
      chips = ['What is the status of my booking?', 'This is unacceptable — I’m considering legal action.'];
    }
  }
  // always offer a guardrail probe + status
  if (chips.length < 3) chips.push('What is the status of my booking?');
  return chips.slice(0, 3);
}

/* ---------- the message handler ---------- */

function handleMessage(state, raw) {
  var out = makeOut();
  var c = state.customer;
  var text = (raw || '').toLowerCase().replace(/[’‘]/g, "'");
  state.turn++;

  var W = {
    legal: /\b(legal action|legal|sue|suing|suit|lawsuit|lawyer|court|formal complaint|consumer forum)\b/.test(text),
    diffMethod: /(different|another|new)\s+(card|account|payment|method|bank)|\b(upi|paytm|gpay|google pay|bank transfer|wallet)\b|pay me in cash|refund (it |me )?in cash/.test(text),
    refund: /\brefund(ed|s)?\b|\bmoney back\b/.test(text),
    upgrade: /\bupgrade(d|s)?\b|business class|first class/.test(text),
    fullNight: /(full|whole|entire)( |-)?night|overnight stay/.test(text),
    hotel: /\bhotel\b|accommodation|\broom\b|somewhere to (stay|sleep|rest)/.test(text),
    lounge: /\blounge\b/.test(text),
    meal: /\bmeal(s)?\b|\bfood\b|voucher|\beat\b|hungry/.test(text),
    comp: /compensat|reimburse|damages|make (this|it) up to me|what am i (entitled|owed)|entitle/.test(text),
    rebook: /\brebook|re-book|next (available )?flight|another flight|different flight|earlier flight|higher(-| )fare|move me|put me on|switch (me|my)|alternative flight/.test(text),
    waive: /\bwaive\b|\bwaiver\b|shouldn'?t have to pay|not paying|won'?t pay|why should i pay|free of charge|no extra (cost|charge)|don'?t want to pay/.test(text),
    exception: /exception|just this once|bend the rules|one(-| )time|surely you can|make it happen/.test(text),
    human: /\bhuman\b|real person|\brepresentative\b|supervisor|manager|escalate|someone senior|speak to (a|an|your)/.test(text),
    missed: /i missed (my|the) flight|missed check(-| )?in|i was late/.test(text),
    greet: /^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(text),
    thanks: /thank|thanks|that works|sounds good|perfect/.test(text),
    bye: /\bbye\b|goodbye|that('s| is) all/.test(text),
    yes: /^(yes|yeah|yep|sure|please do|go ahead|do it|ok(ay)?[,.! ]|fine[,.! ])/.test(text) || /^(yes|ok|okay|fine|sure)$/.test(text),
    no: /^(no|nah|nope|forget it|never ?mind|fine, forget)/.test(text) || /forget the/.test(text),
    payAgree: /i('|’)?ll pay|pay the difference|charge (me|it)|happy to pay|i can pay|i will pay/.test(text),
    stayPut: /stay on|keep my (seat|flight|booking)|wait for (it|the flight)|i('|’)?ll wait/.test(text),
    returnFlight: /return (flight|trip|leg)|flight (back|home)|back to delhi|goa\s*(→|to|-)\s*delhi/.test(text),
    status: /\bstatus\b|what('s| is) (going on|happening)|what happened|why (is|was)|cancel+ed|delay/.test(text)
  };
  var angry = /(furious|angry|unacceptable|ridiculous|worst|terrible|pathetic|fed up|frustrat|awful|disgust|derail|ruined|mess\b|nightmare)/.test(text);

  var d = disruptedBooking(c.id);
  var handled = false;
  var offerResolved = false;

  /* --- privacy guard: mentions of another customer's PNR/name (§4 Allowed: own booking info only) --- */
  var others = Object.keys(DATA.customers).filter(function (k) { return k !== c.id; });
  var otherHit = null;
  others.forEach(function (k) {
    var oc = DATA.customers[k];
    if (text.indexOf(oc.pnr.toLowerCase()) !== -1 || text.indexOf(oc.first.toLowerCase()) !== -1) otherHit = oc;
  });
  if (otherHit) {
    trace(out, '§4 Allowed scope', 'Request touches another customer’s booking (' + otherHit.pnr + ') → refused', 'blocked');
    out.parts.push('For privacy I can only share booking and flight information for the customer verified on this session — that’s your booking, ' + c.pnr + '. I can’t discuss any other passenger’s details.');
    out.chips = suggestChips(state);
    return out;
  }

  /* --- full escalation lock (after a legal threat the case belongs to the specialist team) --- */
  if (state.fullEscalated) {
    var msg = 'Your case is with our specialist support team (ticket ' + state.tickets[state.tickets.length - 1].id + ') and they’ll be in touch directly.';
    if (W.status || W.returnFlight) {
      msg += ' ' + statusSummary(state, out);
    } else {
      trace(out, 'Escalated case', 'Conversation is owned by the specialist team — agent provides status only', 'escalated');
    }
    out.parts.push(msg);
    out.chips = suggestChips(state);
    return out;
  }

  /* --- 1. Legal threat / formal complaint → immediate escalation (§4, tone per Sample C) --- */
  if (W.legal) {
    trace(out, '§4 Prohibited', 'Threat of legal action / formal complaint → must be escalated immediately', 'blocked');
    var id = escalate(out, state, 'Legal-action / formal-complaint threat — immediate handover to specialist support');
    state.fullEscalated = true;
    out.fullEscalated = true;
    out.parts.push('I hear you, and I’m sorry this has been such a frustrating experience. I want to make sure this gets the right attention — I’m escalating this to our specialist support team right now (ticket ' + id + '), and they’ll reach out to you directly at ' + c.email + '. Anything already applied to your booking stays in place.');
    out.chips = suggestChips(state);
    return out;
  }

  /* --- 2. Non-airline-caused disruption (e.g. "I missed my flight") --- */
  if (W.missed) {
    trace(out, '§4 Prohibited', 'Exception for a non-airline-caused disruption → cannot be granted by the agent', 'blocked');
    var mid = escalate(out, state, 'Request involving a non-airline-caused disruption — referred to a human agent');
    out.parts.push('I’m sorry — for disruptions that weren’t caused by the airline, such as a missed flight, I’m not able to make exceptions to policy. I’ve referred this to a human agent (ticket ' + mid + ') who will review it and contact you.');
    out.chips = suggestChips(state);
    return out;
  }

  var empathyUsed = false;
  function empathize(line) {
    if (!empathyUsed) { out.parts.push(line); empathyUsed = true; }
  }
  if (angry) {
    empathize('I completely understand the frustration, ' + c.first + ' — I’m sorry this has disrupted your day.');
  }

  /* --- 3. Pending offer confirmations (yes/no to an escalation offer) --- */
  if (state.pendingOffer && (W.yes || W.human) && !W.rebook && !W.payAgree) {
    var offer = state.pendingOffer;
    state.pendingOffer = null;
    handled = true;
    offerResolved = true;
    if (offer === 'upgrade') {
      state.escalatedTopics.upgrade = true;
      var uid = escalate(out, state, 'Request for complimentary business-class upgrade on return flight — beyond stated policy');
      out.parts.push('Done — I’ve escalated the upgrade request to a human agent (ticket ' + uid + '). They’ll review it and contact you directly at ' + c.email + '. To be clear, I can’t promise an outcome: complimentary upgrades are beyond the stated policy, which is why a person has to look at it.');
    } else if (offer === 'fullNight') {
      var fid = escalate(out, state, 'Request for full-night hotel stay (policy covers delayed hours only) — beyond stated policy');
      out.parts.push('Done — I’ve escalated your request for a full night’s stay to a human agent (ticket ' + fid + '). Your accommodation for the delayed hours stays arranged in the meantime.');
    } else if (offer === 'hotelException') {
      var hid = escalate(out, state, 'Hotel accommodation requested for a 4-hour delay (threshold is >5h) — out-of-policy exception');
      out.parts.push('Done — I’ve escalated your accommodation request to a human agent (ticket ' + hid + '). They’ll review it and reach out directly. Your meal voucher and lounge access remain active.');
    } else if (offer === 'diffMethod') {
      var pid = escalate(out, state, 'Refund requested to a non-original payment method — prohibited for the agent');
      out.parts.push('Understood — I’ve escalated the payment-method request to a human agent (ticket ' + pid + '). Policy only lets me issue refunds to the original payment method, so a person will need to review this.');
    } else if (offer === 'compExtra') {
      var cid2 = escalate(out, state, 'Request for compensation beyond stated policy amounts — requires human review');
      out.parts.push('Done — I’ve escalated your compensation request to a human agent (ticket ' + cid2 + '), and they’ll contact you directly.');
    }
  } else if (state.pendingOffer && W.no) {
    var dropped = state.pendingOffer;
    state.pendingOffer = null;
    handled = true;
    offerResolved = true;
    trace(out, 'Offer withdrawn', 'Customer declined escalation of the ' + dropped + ' request', 'info');
    out.parts.push('No problem — I’ll leave that there. Is there anything else I can help with on this booking?');
  }

  /* --- 4. Cancelled-flight choice resolution (Priya): refund vs rebook --- */
  if (d && d.status === 'cancelled') {
    if (W.diffMethod) {
      handled = true;
      trace(out, '§3 Refund Processing Rule', 'Refunds go to the original payment method only', 'blocked');
      trace(out, '§4 Prohibited', 'Processing refunds to a different payment method → not permitted', 'blocked');
      state.pendingOffer = 'diffMethod';
      out.parts.push('I’m not able to do that one — refunds for airline-caused cancellations are issued to the original payment method only. If you’d like, I can escalate the request to a human agent to review; otherwise the refund will go back to the card or account you paid with.');
    } else if (W.refund && !W.diffMethod) {
      handled = true;
      var cashNote = /\bcash\b/.test(text);
      if (!state.refundInitiated && !state.rebooked) {
        state.refundInitiated = true;
        state.awaiting = null;
        trace(out, '§3 Cancellation Rebooking Rule', d.flight + ' cancelled by airline → customer’s choice: free rebooking ≤ 24h or full refund', 'allowed');
        trace(out, '§3 Refund Processing Rule', 'Full refund → within 7 business days → original payment method only', 'allowed');
        action(out, state, 'rfd', 'Full refund initiated for cancelled flight ' + d.flight + ' — 7 business days, original payment method');
        var r = 'Done — I’ve initiated a full refund for the cancelled flight ' + d.flight + ' (' + d.route + '). It will be processed in full within 7 business days';
        r += cashNote
          ? '. One note on “cash”: refunds can only go back to the original payment method you used to book — I’m not able to issue it any other way.'
          : ', to your original payment method.';
        r += ' You’ll get confirmation at ' + c.email + '.';
        out.parts.push(r);
        var ret = bookingsFor(c.id).filter(function (b) { return b.status === 'unaffected'; })[0];
        if (ret) {
          trace(out, '§2 Booking data', ret.flight + ' ' + ret.route + ' · ' + ret.date + ' ' + ret.dep + ' · Unaffected', 'data');
          out.parts.push('Your return flight (' + ret.route + ', ' + ret.date + ' at ' + ret.dep + ') is unaffected and stays booked.');
        }
      } else if (state.refundInitiated) {
        trace(out, '§3 Refund Processing Rule', 'Refund already in progress — idempotent, no duplicate', 'info');
        out.parts.push('Your full refund for ' + d.flight + ' is already in progress — processed within 7 business days to your original payment method, with confirmation to ' + c.email + '.');
      } else {
        trace(out, 'Booking state', 'Customer already rebooked — refund would need to reverse the rebooking → human review', 'info');
        var swid = escalate(out, state, 'Change of resolution: rebooked customer now requests refund — human review');
        out.parts.push('You’re already rebooked on the next available flight, so switching to a refund needs a human agent to unwind that — I’ve raised it (ticket ' + swid + ') and they’ll confirm with you shortly.');
      }
    } else if (W.rebook && !W.refund) {
      handled = true;
      if (!state.rebooked && !state.refundInitiated) {
        state.rebooked = true;
        state.awaiting = null;
        trace(out, '§3 Cancellation Rebooking Rule', 'Airline-caused cancellation → free rebooking on next available flight within 24 hours', 'allowed');
        if (c.tier === 'Gold' || c.tier === 'Platinum') {
          trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking (first access to next-available seats), no additional compensation', 'allowed');
        }
        action(out, state, 'rbk', 'Rebooked free of charge on next available ' + d.route + ' flight within 24 hours' + (c.tier !== 'Silver' ? ' (' + c.tier + ' priority)' : ''));
        var rb = 'Done — I’ve rebooked you at no charge on the next available ' + d.route + ' flight departing within 24 hours.';
        if (c.tier === 'Gold' || c.tier === 'Platinum') rb += ' As a ' + c.tier + ' member you get priority access to next-available seats.';
        rb += ' The confirmed flight details will reach you at ' + c.email + '.';
        out.parts.push(rb);
      } else if (state.rebooked) {
        out.parts.push('You’re already rebooked on the next available flight — details are on their way to ' + c.email + '.');
      } else {
        out.parts.push('Your refund for ' + d.flight + ' is already in progress, so there’s no active outbound booking to move. If you’d like to travel instead, a human agent can help reverse the refund — shall I escalate that?');
        state.pendingOffer = 'compExtra';
      }
    }
  }

  /* --- 5. Fare-difference flow (delayed flight, voluntary move to a higher-fare flight) --- */
  if (d && d.status === 'delayed' && !handled) {
    if ((W.rebook || (state.fareOffered && W.payAgree)) && !W.hotel) {
      handled = true;
      var diff = DATA.fareDifference[c.id];
      if (W.payAgree && state.fareOffered) {
        state.fareRebooked = true;
        state.awaiting = null;
        trace(out, '§3 Fare Difference Rule', 'Customer accepts the ' + inr(diff) + ' fare difference → rebooking proceeds', 'allowed');
        if (c.tier === 'Gold' || c.tier === 'Platinum') trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking, no additional compensation', 'allowed');
        action(out, state, 'rbk', 'Moved to the higher-fare alternative flight — ' + inr(diff) + ' fare difference payable, ' + (c.tier) + ' priority');
        out.parts.push('Done — I’ve moved you onto the alternative flight' + (c.tier !== 'Silver' ? ' with ' + c.tier + ' priority for the next-available seat' : '') + '. The ' + inr(diff) + ' fare difference is payable before ticketing, and your confirmation will arrive at ' + c.email + '. Your meal voucher stays valid; the delayed-hours accommodation is released once you’re rebooked.');
      } else if (typeof diff === 'number') {
        state.fareOffered = true;
        state.awaiting = 'fare_decision';
        state.pendingOffer = null;
        trace(out, '§3 Cancellation Rebooking Rule', d.flight + ' is delayed, not cancelled → free rebooking does not apply', 'info');
        trace(out, '§3 Fare Difference Rule', 'Voluntary move to a higher-fare flight → fare difference of ' + inr(diff) + ' is payable', 'allowed');
        trace(out, '§3 Fare Difference Rule', inr(diff) + ' > ' + inr(DATA.waiverLimit) + ' → agent cannot waive without supervisor approval', 'supervisor');
        var fmsg = 'I can look at moving you, ' + c.first + '. Because ' + d.flight + ' is delayed rather than cancelled, a move to a different, higher-fare flight counts as a voluntary rebooking — the fare difference of ' + inr(diff) + ' would be payable. I’m also not able to waive a difference above ' + inr(DATA.waiverLimit) + ' myself; that needs supervisor approval.';
        fmsg += ' So you have three options: pay the ' + inr(diff) + ' and I’ll move you now' + (c.tier === 'Gold' || c.tier === 'Platinum' ? ' with ' + c.tier + ' priority' : '') + '; ask me to send the waiver request to a supervisor; or stay on ' + d.flight + ' with your delay assistance in place.';
        out.parts.push(fmsg);
      } else {
        trace(out, '§3 Cancellation Rebooking Rule', d.flight + ' is delayed, not cancelled → free rebooking does not apply', 'info');
        trace(out, '§3 Fare Difference Rule', 'Voluntary rebooking → any fare difference is payable by the customer', 'info');
        out.parts.push('Because ' + d.flight + ' is delayed rather than cancelled, moving to a different flight would be a voluntary rebooking — you’d pay any fare difference for the new flight (I can’t waive a difference above ' + inr(DATA.waiverLimit) + ' without supervisor approval). ' + d.flight + ' currently departs at ' + d.newDep + '. Want me to look at it, or shall I make sure your delay assistance is in place?');
      }
    } else if (state.awaiting === 'fare_decision' && (W.waive || W.human)) {
      handled = true;
      var diff2 = DATA.fareDifference[c.id];
      state.awaiting = null;
      trace(out, '§3 Fare Difference Rule', 'Waiver of ' + inr(diff2) + ' requested — above the ' + inr(DATA.waiverLimit) + ' agent limit', 'blocked');
      var wid = escalate(out, state, 'Fare-difference waiver of ' + inr(diff2) + ' requested — exceeds ' + inr(DATA.waiverLimit) + ' agent limit, needs supervisor approval');
      out.parts.push('That’s fair to ask, and it’s above what I’m allowed to waive — so I’ve sent the ' + inr(diff2) + ' waiver request to a supervisor right now (ticket ' + wid + '). They’ll come back to you directly at ' + c.email + '. Until then you keep your seat on ' + d.flight + ' (departing ' + d.newDep + ') and everything already applied to your booking stays in place.');
    } else if (state.awaiting === 'fare_decision' && W.stayPut) {
      handled = true;
      state.awaiting = null;
      trace(out, 'Customer choice', 'Staying on ' + d.flight + ' — delay assistance remains in place', 'info');
      out.parts.push('No problem — you’re staying on ' + d.flight + ', now departing at ' + d.newDep + '. Your delay assistance stays in place. Anything else I can help with?');
    } else if (W.waive && !state.fareOffered) {
      handled = true;
      trace(out, '§3 Fare Difference Rule', 'Fare differences above ' + inr(DATA.waiverLimit) + ' cannot be waived without supervisor approval', 'info');
      out.parts.push('Just so it’s clear how that works: for a voluntary move to a higher-fare flight the fare difference is payable, and I can’t waive an amount above ' + inr(DATA.waiverLimit) + ' — that needs supervisor approval. Tell me what you’d like to do and I’ll set it up.');
    }
  }

  /* --- 6. Refund asked on a delayed (not cancelled) flight --- */
  if (d && d.status === 'delayed' && W.refund && !handled) {
    handled = true;
    trace(out, '§3 Refund Processing Rule', 'Full refunds apply to airline-caused cancellations — ' + d.flight + ' is delayed, not cancelled', 'blocked');
    var granted6 = ensureDelayComp(state, out);
    out.parts.push('A full refund wouldn’t apply here — refunds are for airline-caused cancellations, and ' + d.flight + ' is delayed, not cancelled. ' + entitlementSentence(state, granted6));
  }

  /* --- 7. Upgrade request → beyond policy (runs even alongside other intents) --- */
  if (W.upgrade && !offerResolved && !state.escalatedTopics.upgrade) {
    handled = true;
    trace(out, '§3 Loyalty Tier Rule', c.tier + ' tier → priority rebooking only, no additional compensation beyond standard policy', 'info');
    trace(out, '§4 Prohibited', 'Complimentary upgrade = compensation beyond stated policy → agent cannot approve', 'blocked');
    if (state.declined.upgrade) {
      state.pendingOffer = null;
      state.escalatedTopics.upgrade = true;
      var uix = escalate(out, state, 'Request for complimentary business-class upgrade — beyond stated policy, human review');
      out.parts.push('I still can’t approve a complimentary upgrade myself — so I’ve escalated the request to a human agent (ticket ' + uix + '), and they’ll contact you directly at ' + c.email + '.');
    } else {
      state.declined.upgrade = true;
      state.pendingOffer = 'upgrade';
      out.parts.push('About the business-class upgrade — that’s not something I’m able to approve. A complimentary upgrade counts as compensation beyond our stated policy, and ' + c.tier + ' tier gives priority rebooking but no additional compensation beyond the standard policy. What I can do is pass the request to a human agent for review — want me to do that?');
    }
  }

  /* --- 8. Full-night hotel (delayed >5h → delayed hours only) --- */
  if (W.fullNight && d && d.status === 'delayed' && !handled) {
    handled = true;
    if (d.delayHours > 5) {
      trace(out, '§3 Delay Compensation Rule', 'Delay > 5h → hotel covers only the delayed hours, not a full night’s stay', 'blocked');
      var granted8 = ensureDelayComp(state, out);
      state.pendingOffer = 'fullNight';
      state.declined.fullNight = true;
      out.parts.push('I understand wanting a proper rest, and I wish I could offer more here — but the policy covers hotel accommodation only for the delayed hours (' + d.dep + '–' + d.newDep + ' in your case), explicitly not a full night’s stay, and I can’t approve beyond that. The delayed-hours accommodation is arranged and ready for you' + (granted8.length ? '' : ' already') + '. If you’d like, I can escalate a request for a full night to a human agent — just say the word.');
    } else {
      trace(out, '§3 Delay Compensation Rule', d.delayHours + 'h delay ≤ 5h → no hotel accommodation under policy', 'blocked');
      var granted8b = ensureDelayComp(state, out);
      state.declined.hotel = true;
      out.parts.push('Hotel accommodation only applies when a delay is more than 5 hours — ' + d.flight + '’s delay is ' + d.delayHours + ' hours, so I’m not able to arrange a stay for this one. ' + entitlementSentence(state, granted8b));
    }
  }

  /* --- 9. Hotel request --- */
  if (W.hotel && !W.fullNight && !handled) {
    handled = true;
    if (d && d.status === 'delayed' && d.delayHours > 5) {
      var granted9 = ensureDelayComp(state, out);
      out.parts.push('Yes — with a ' + d.delayHours + '-hour delay you qualify for hotel accommodation covering the delayed hours (' + d.dep + '–' + d.newDep + '), though not a full night’s stay. ' + (granted9.some(function (g) { return g.key === 'hotel'; }) ? 'I’ve arranged it now, along with your meal voucher and lounge access.' : 'That’s already arranged for you.'));
    } else if (d && d.status === 'delayed') {
      if (state.declined.hotel && (W.exception || true) && state.turn > 1 && state.declinedHotelOnce) {
        // second hotel push → offer escalation
        state.pendingOffer = 'hotelException';
        trace(out, '§4 Prohibited', 'Approving accommodation outside the >5h rule = compensation beyond policy → escalate on request', 'blocked');
        out.parts.push('I really do understand — and I’m still not able to approve a hotel for a ' + d.delayHours + '-hour delay, because that sits outside the stated policy. If you’d like, I can escalate the request to a human agent to review — want me to?');
      } else {
        trace(out, '§3 Delay Compensation Rule', d.delayHours + 'h ≤ 5h → hotel does not apply; >3h → meal voucher + lounge access', 'blocked');
        var granted9b = ensureDelayComp(state, out);
        state.declined.hotel = true;
        state.declinedHotelOnce = true;
        out.parts.push('I understand — ' + d.delayHours + ' hours is a long wait. Hotel accommodation, though, only applies when a delay is more than 5 hours, and ' + d.flight + '’s delay is ' + d.delayHours + ' hours, so I’m not able to arrange it here. ' + entitlementSentence(state, granted9b) + (d.newDep ? ' The lounge is open to you until the new ' + d.newDep + ' departure.' : ''));
      }
    } else if (d && d.status === 'cancelled') {
      trace(out, '§3 Delay Compensation Rule', 'Hotel applies to delays over 5 hours — ' + d.flight + ' is cancelled; the remedy is rebooking or refund', 'info');
      out.parts.push('For a cancellation the policy remedy is a free rebooking within 24 hours or a full refund rather than accommodation. ' + (state.awaiting === 'rebook_or_refund' ? 'Which of the two would you like?' : 'Happy to help with either.'));
    }
  }

  /* --- 10. Exception pleading --- */
  if (W.exception && !handled) {
    handled = true;
    trace(out, '§4 Prohibited', 'Making exceptions beyond stated policy → agent cannot approve → escalate to a human agent', 'blocked');
    var topic = state.declined.hotel ? 'your accommodation request' : (state.declined.fullNight ? 'your full-night stay request' : 'your request');
    var xid = escalate(out, state, 'Customer asked for an out-of-policy exception (' + topic + ') — human agent to review');
    out.parts.push('I hear you, and I’m sorry — I genuinely can’t make exceptions beyond the stated policy, for any booking. What I’ve done instead is escalate ' + topic + ' to a human agent right now (ticket ' + xid + '); they’ll review it and contact you directly at ' + c.email + '. Everything you’re already entitled to stays in place.');
  }

  /* --- 11. Lounge / meal / generic compensation on a delayed flight --- */
  if ((W.lounge || W.meal || W.comp) && !handled) {
    handled = true;
    if (d && d.status === 'delayed') {
      var granted11 = ensureDelayComp(state, out);
      out.parts.push((angry ? '' : 'I’m sorry for the disruption. ') + 'Your flight ' + d.flight + ' is delayed ' + d.delayHours + ' hours. ' + entitlementSentence(state, granted11));
    } else if (d && d.status === 'cancelled') {
      trace(out, '§3 Cancellation Rebooking Rule', 'Cancellation remedy: free rebooking ≤ 24h or full refund — policy has no further cash compensation', 'info');
      trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking, no additional compensation beyond standard policy', 'info');
      var cm = 'For the cancellation of ' + d.flight + ', what policy provides is your choice of a free rebooking on the next available flight within 24 hours or a full refund — there’s no additional cash compensation in the policy, and ' + c.tier + ' tier adds priority rebooking but nothing beyond the standard policy.';
      if (!state.refundInitiated && !state.rebooked) { cm += ' Which of the two would you like?'; state.awaiting = 'rebook_or_refund'; }
      out.parts.push(cm);
      if (W.comp && !W.refund && !W.rebook) {
        state.pendingOffer = 'compExtra';
        out.parts.push('If you feel this deserves more than the standard policy, I can escalate a compensation request to a human agent for review — just say the word.');
      }
    }
  }

  /* --- 12. Return-flight question (Priya) --- */
  if (W.returnFlight && !handled) {
    handled = true;
    var ret2 = bookingsFor(c.id).filter(function (b) { return b.status === 'unaffected'; })[0];
    if (ret2) {
      trace(out, '§2 Booking data', ret2.flight + ' ' + ret2.route + ' · ' + ret2.date + ' ' + ret2.dep + ' · Unaffected', 'data');
      out.parts.push('Yes — your return flight (' + ret2.route + ') on ' + ret2.date + ' at ' + ret2.dep + ' is unaffected and remains booked exactly as it was.');
    } else {
      out.parts.push(statusSummary(state, out));
    }
  }

  /* --- 13. Explicit human/supervisor request (no other context) --- */
  if (W.human && !handled) {
    handled = true;
    var hid2 = escalate(out, state, 'Customer asked for a human agent — conversation referred for follow-up');
    out.parts.push('Of course — I’ve raised this with our human support team (ticket ' + hid2 + '), and someone will contact you directly at ' + c.email + '. In the meantime I’m happy to keep helping here too.');
  }

  /* --- 14. Status / greeting / thanks / fallback --- */
  if (!handled) {
    if (W.status || (d && (text.indexOf(d.flight.toLowerCase()) !== -1))) {
      var s = statusSummary(state, out);
      if (d && d.status === 'cancelled' && !state.refundInitiated && !state.rebooked) {
        trace(out, '§3 Cancellation Rebooking Rule', 'Airline-caused → free rebooking ≤ 24h OR full refund — customer’s choice', 'allowed');
        if (c.tier === 'Gold' || c.tier === 'Platinum') trace(out, '§3 Loyalty Tier Rule', c.tier + ' → priority rebooking (first access to next-available seats)', 'allowed');
        s += ' Because the cancellation was caused by the airline, the choice is yours: a free rebooking on the next available flight within 24 hours' + (c.tier === 'Gold' || c.tier === 'Platinum' ? ' (with ' + c.tier + ' priority for next-available seats)' : '') + ', or a full refund. Which would you prefer?';
        state.awaiting = 'rebook_or_refund';
      } else if (d && d.status === 'delayed') {
        var granted14 = ensureDelayComp(state, out);
        s += ' ' + entitlementSentence(state, granted14);
      }
      out.parts.push(s);
    } else if (W.greet) {
      out.parts.push('Hello ' + c.first + '! You’re verified on booking ' + c.pnr + '. I can help with flight status, rebooking, refunds and delay assistance — what can I do for you?');
    } else if (W.thanks || W.bye) {
      trace(out, 'Session', 'Courtesy close', 'info');
      out.parts.push('You’re very welcome, ' + c.first + '. Everything we’ve set up is confirmed to ' + c.email + '. Safe travels — and I’m here if anything else comes up.');
    } else if (empathyUsed) {
      out.parts.push('Tell me what you’d like me to do — I can help with rebooking, refunds, and delay assistance on ' + c.pnr + ', and anything beyond policy I’ll route to a human agent for you.');
    } else {
      trace(out, 'Scope', 'Message outside supported intents → capability summary offered', 'info');
      out.parts.push('I want to make sure I get this right. On this booking I can: share your flight status, rebook you, arrange refunds for airline-caused cancellations, and apply delay assistance (meal voucher, lounge, hotel where the delay qualifies). Anything beyond policy, I’ll escalate to a human agent. What would you like to do?');
    }
  }

  out.chips = suggestChips(state);
  return out;
}

function statusSummary(state, out) {
  var c = state.customer;
  var rows = bookingsFor(c.id).map(function (b) {
    trace(out, '§2 Booking data', b.flight + ' ' + b.route + ' · ' + b.date + ' ' + b.dep + ' · ' + b.statusText, 'data');
    if (b.status === 'cancelled') return 'Flight ' + b.flight + ' (' + b.route + ', ' + b.date + ', ' + b.dep + ') is cancelled due to operational reasons.';
    if (b.status === 'delayed') return 'Flight ' + b.flight + ' (' + b.route + ', ' + b.date + ') is delayed ' + b.delayHours + ' hours — new departure ' + b.newDep + '.';
    return 'Flight ' + b.flight + ' (' + b.route + ', ' + b.date + ' at ' + b.dep + ') is unaffected.';
  });
  return rows.join(' ');
}

/* ---------- exports ---------- */
var Engine = {
  DATA: DATA,
  SCRIPTS: SCRIPTS,
  createSession: createSession,
  openingMessage: openingMessage,
  handleMessage: handleMessage,
  delayEntitlements: delayEntitlements
};
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
if (typeof window !== 'undefined') window.Engine = Engine;
