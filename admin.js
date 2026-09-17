/* SK Airways — Resolution Console (support / supervisor view) */
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function markHandled(caseId, ticketId) {
    try {
      await fetch('/api/handle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: caseId, ticketId: ticketId })
      });
    } catch (e) { /* next refresh will show reality */ }
    refresh();
  }

  function render(data) {
    var cases = data.cases || [];
    var actions = 0, open = 0, handled = 0;
    cases.forEach(function (c) {
      actions += c.actions.length;
      c.tickets.forEach(function (t) { t.handled ? handled++ : open++; });
    });
    $('statCases').textContent = cases.length;
    $('statActions').textContent = actions;
    $('statOpen').textContent = open;
    $('statHandled').textContent = handled;

    var list = $('caseList');
    if (!cases.length) {
      list.innerHTML = '<p class="empty">No cases yet — open the customer chat and start a conversation.</p>';
      return;
    }
    list.innerHTML = cases.map(function (c) {
      var who = c.customer
        ? esc(c.customer.name) + ' · <span class="tier tier-' + esc(c.customer.tier.toLowerCase()) + '">' + esc(c.customer.tier) + '</span> · <span class="pnr">PNR ' + esc(c.customer.pnr) + '</span>'
        : '<span class="tier tier-silver">Unverified customer</span>';
      var tickets = c.tickets.length
        ? c.tickets.map(function (t) {
            return '<div class="ticket' + (t.handled ? ' handled' : '') + '">' +
              '<span class="id">' + esc(t.id) + '</span>' +
              '<span class="grow">' + esc(t.label) + '</span>' +
              (t.handled
                ? '<span class="handled-tag">HANDLED</span>'
                : '<button class="btn btn-sm" data-case="' + esc(c.caseId) + '" data-ticket="' + esc(t.id) + '">Mark handled</button>') +
              '</div>';
          }).join('')
        : '<p class="empty" style="padding:4px 0">None</p>';
      var acts = c.actions.length
        ? c.actions.map(function (a) {
            return '<div class="actionrow"><span class="id">' + esc(a.id) + '</span><span class="grow">' + esc(a.label) + '</span></div>';
          }).join('')
        : '<p class="empty" style="padding:4px 0">None</p>';
      return '<article class="case' + (c.tickets.some(function (t) { return !t.handled; }) ? ' escalated' : '') + '">' +
        '<div class="case-top">' +
          '<span class="case-id">' + esc(c.caseId) + '</span>' +
          '<span class="case-meta">' + who + '</span>' +
          '<span class="case-meta">' + esc(c.mode === 'ai' ? 'AI agent' : 'Rules engine') + (c.provider ? ' · ' + esc(c.provider) : '') + '</span>' +
          (c.fullEscalated ? '<span class="pill pill-cancelled">Specialist team</span>' : '') +
        '</div>' +
        '<div class="case-section">Escalation tickets</div>' + tickets +
        '<div class="case-section">Actions on booking</div>' + acts +
        '</article>';
    }).join('');

    list.querySelectorAll('button[data-ticket]').forEach(function (b) {
      b.addEventListener('click', function () { markHandled(b.dataset.case, b.dataset.ticket); });
    });
  }

  async function refresh() {
    try {
      var r = await fetch('/api/cases');
      render(await r.json());
      var h = await (await fetch('/api/health')).json();
      $('modeNote').textContent = h.mode === 'ai' ? 'AI agent · ' + (h.label || '') : 'Rules engine';
    } catch (e) {
      $('modeNote').textContent = 'server unreachable';
    }
  }

  refresh();
  setInterval(refresh, 4000);
})();
