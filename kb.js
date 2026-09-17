/* ============================================================
   SK Airways — Customer Resolution Agent · knowledge base
   The assignment data pack's policy text as a retrievable KB:
   verbatim chunks with section ids + metadata, and a scored
   keyword retrieval the agent queries through search_policy.
   (For a one-page KB, deterministic keyword retrieval is the
   honest choice — swap in embeddings when the KB grows.)
   ============================================================ */
'use strict';

const CHUNKS = [
  {
    id: 'cancellation_rebooking',
    section: '§3 Service Rules',
    title: 'Cancellation Rebooking Rule',
    text: 'If a flight is cancelled by the airline, the customer is entitled to a free rebooking on the next available flight within 24 hours, or a full refund, customer’s choice.',
    keywords: ['cancel', 'cancelled', 'cancellation', 'rebook', 'rebooking', 'refund', 'choice', '24', 'next available', 'free']
  },
  {
    id: 'delay_compensation',
    section: '§3 Service Rules',
    title: 'Delay Compensation Rule',
    text: 'Delay under 3 hours: ₹500 meal voucher. Delay more than 3 hours: meal voucher + lounge access. Delay more than 5 hours: meal voucher + hotel accommodation, covering only the delayed hours (not a full night’s stay).',
    keywords: ['delay', 'delayed', 'compensation', 'meal', 'voucher', 'lounge', 'hotel', 'accommodation', 'stay', 'night', 'hours', 'food', 'entitle']
  },
  {
    id: 'refund_processing',
    section: '§3 Service Rules',
    title: 'Refund Processing Rule',
    text: 'Refunds for airline-caused cancellations are processed in full within 7 business days. Refunds are issued to the original payment method only.',
    keywords: ['refund', 'refunds', 'money', 'payment', 'method', 'card', 'account', 'cash', 'days', 'processed', 'original']
  },
  {
    id: 'fare_difference',
    section: '§3 Service Rules',
    title: 'Fare Difference Rule',
    text: 'If a customer voluntarily chooses to rebook on a higher-fare flight (not airline-caused), they must pay the fare difference. Agents cannot waive fare differences above ₹1,500 without supervisor approval.',
    keywords: ['fare', 'difference', 'waive', 'waiver', 'higher', 'pay', 'supervisor', '1500', '2000', 'voluntary', 'switch', 'move', 'alternative']
  },
  {
    id: 'loyalty_tier',
    section: '§3 Service Rules',
    title: 'Loyalty Tier Rule',
    text: 'Gold and Platinum tier customers get priority rebooking (first access to next-available seats) but no additional compensation beyond the standard policy.',
    keywords: ['loyalty', 'tier', 'gold', 'platinum', 'silver', 'priority', 'status', 'member', 'upgrade', 'extra', 'additional', 'benefit']
  },
  {
    id: 'allowed_actions',
    section: '§4 Allowed Actions',
    title: 'Allowed agent actions',
    text: 'Allowed: rebook the customer on the next available flight within 24 hours at no charge (airline-caused disruption); issue meal vouchers and lounge access per the delay compensation rule; arrange hotel accommodation for the delayed-hours portion, where the delay qualifies; initiate a refund request for airline-caused cancellations; provide the customer’s own booking and flight status information.',
    keywords: ['allowed', 'can', 'permitted', 'actions', 'rebook', 'voucher', 'lounge', 'hotel', 'refund', 'status', 'information']
  },
  {
    id: 'prohibited_actions',
    section: '§4 Prohibited Actions',
    title: 'Prohibited — must escalate to a human agent',
    text: 'Prohibited (must escalate to a human agent): approving any compensation beyond the stated policy amounts; waiving a fare difference above ₹1,500; making exceptions for non-airline-caused disruptions (e.g., customer missed the flight); handling threats of legal action or formal complaints — must be escalated immediately; processing refunds to a different payment method than the original.',
    keywords: ['prohibited', 'cannot', 'escalate', 'escalation', 'human', 'exception', 'legal', 'complaint', 'lawyer', 'sue', 'court', 'upgrade', 'beyond', 'policy', 'missed', 'different', 'method', 'waive']
  }
];

/* Scored keyword retrieval: token overlap against keywords + title + text. */
function searchPolicy(query, limit) {
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/[^a-z0-9₹]+/).filter(t => t.length > 2);
  const scored = CHUNKS.map(c => {
    let score = 0;
    const hay = (c.title + ' ' + c.text).toLowerCase();
    for (const t of tokens) {
      if (c.keywords.some(k => k === t || k.startsWith(t) || t.startsWith(k))) score += 3;
      else if (hay.includes(t)) score += 1;
    }
    return { c, score };
  }).filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 3).map(s => ({
    policy_id: s.c.id,
    section: s.c.section,
    title: s.c.title,
    text: s.c.text
  }));
}

module.exports = { CHUNKS, searchPolicy };
