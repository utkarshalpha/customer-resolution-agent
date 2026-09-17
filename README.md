# Customer Resolution Agent — Airline Disruption

Assignment 3 (AIONOS) — a customer-facing resolution agent for a day of airline disruption,
set on **Wednesday, 23 September 2026**, grounded **only** in the assignment data pack.
No invented rules, policies or customer data.

## Deploy (full functionality)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/utkarshalpha/customer-resolution-agent)

**Render (free web service) is the recommended host** — the app is a single stateful Node
process (in-memory sessions, supervisor-notice queue, the live `/admin` Resolution Console),
so it needs a persistent runtime:

- **Render free** ✅ — persistent `node server.js`, free plan, no card. One click on the
  button above (it reads `render.yaml`), then your URL serves everything: the AI chat,
  identity flow, and the `/admin` supervisor console with decisions flowing back into chats.
  Free instances spin down when idle — the first request after a quiet spell takes ~1 min.
  Optional: add `GROQ_API_KEY` or `GEMINI_API_KEY` in the dashboard for a faster provider.
- **Vercel** ❌ for this build — serverless functions don't share memory between requests,
  so sessions and supervisor notices would be lost mid-conversation (it would need an
  external store like Redis/Postgres first).
- **GitHub Pages** — static preview only (https://utkarshalpha.github.io/customer-resolution-agent/):
  the chat works with the in-browser free LLM, but there is no server, so no case store,
  no supervisor console, no closed-loop decisions. Use Render for the real thing.

## Run it

```
node server.js     # → http://localhost:3000
```

That's it — **AI mode works with no API key and no npm install**: with no credentials the
server probes a keyless free LLM endpoint (pollinations.ai) at startup and uses it for the
chat. If it's unreachable, the deterministic rules engine takes over, so the demo always
works. The badge in the chat header shows what's active.

**Recommended (free, ~1 minute, no card):** a free API key from Groq or Google makes the AI
mode fast and reliable —

| Provider | Free key from | Set before `node server.js` |
|---|---|---|
| Groq (Llama 3.3 70B) | console.groq.com | `GROQ_API_KEY` |
| Google Gemini | aistudio.google.com | `GEMINI_API_KEY` |
| OpenRouter (free models) | openrouter.ai | `OPENROUTER_API_KEY` |
| Anthropic Claude | console.anthropic.com (paid) | `ANTHROPIC_API_KEY` + `npm install` |
| Any OpenAI-compatible API | — | `LLM_BASE_URL` + `LLM_API_KEY` (+ `LLM_MODEL`) |

```
# PowerShell                          # bash
$env:GROQ_API_KEY = "gsk_..."         export GROQ_API_KEY=gsk_...
node server.js                        node server.js
```

Keys can also go in a gitignored `config.json` next to `server.js`:
`{ "groqApiKey": "gsk_..." }` (also accepts `geminiApiKey`, `openrouterApiKey`, `apiKey`
for Anthropic, `llmBaseUrl`/`llmApiKey`/`llmModel`, and `provider` to force one).
Force a specific mode with `AGENT_PROVIDER=groq|gemini|openrouter|pollinations|anthropic|rules`.
Only Claude needs `npm install` (the official SDK); every free provider runs dependency-free
on Node 18+ built-in fetch.

**Tests** (81 checks, no API key needed):

```
npm test
```

## What it is

Pick one of the three passengers from the data pack and chat as them — free text or the
suggested replies, or **Watch scenario** to run the full §6 script end-to-end.

### AI mode — how the agent works

- **An LLM drives the conversation** (Claude, Groq Llama, Gemini, or the keyless fallback —
  same behavior contract for all). Its system prompt contains the data pack — but only the
  *verified customer's* profile and bookings (other passengers' data is never in its
  context), the five §3 service rules, the §4 allowed/prohibited boundary, and the §5 tone
  samples.
- **Every action goes through nine tools** enforced by a deterministic policy layer the model
  cannot bypass (`policy.js`): `verify_identity`, `search_policy`, `get_booking_details`,
  `issue_delay_compensation`, `rebook_free`, `initiate_refund`, `quote_fare_difference`,
  `rebook_paid_alternative`, `escalate_to_human`. A disallowed call (hotel for a 4-hour
  delay, refund on a delayed flight, paid rebooking without an accepted quote) returns a
  policy error with the rule, which the agent must relay and escalate. The only fare figure
  the model can quote is what `quote_fare_difference` returns.
- **Agentic identity flow** — the "New customer" entry starts unverified: the agent asks what
  happened, collects the booking reference, and calls `verify_identity`; no account data
  exists in its context until that succeeds, and it never re-asks for what verification
  returns.
- **Knowledge base** — the pack's service rules live in a retrievable KB (`kb.js`);
  `search_policy` returns the verbatim rule text with section ids, logged as KB retrievals
  in the console.
- **Legal threats** additionally trip a server-side guard that forces immediate escalation
  before any further resolution.
- The **Agent console** beside the chat shows the live audit: every tool call, the rule check
  behind it (Allowed / Blocked / Supervisor / Escalated), the action ledger and escalation
  tickets. Every conversation gets a **Case ID**; turns that change the booking render a
  resolution summary card.
- **Human-in-the-loop, closed loop** — open `/admin` (running `node server.js`) for the
  Resolution Console: all cases and open escalations with **Approve / Deny**. The decision
  flows back into the live customer chat within seconds — an approved ₹2,000 fare waiver
  executes the free rebooking through the same policy layer (`RBK-…: fare difference WAIVED
  by supervisor approval`).

### Rules mode — the fallback

The same policy checks driven by keyword intent matching (`engine.js`) — fully deterministic,
runs in the browser or on the server with no key and no dependencies.

### Assignment requirements → where they live

| Requirement | Implementation |
|---|---|
| Understand the customer's intent | LLM conversation (AI mode) / intent matching (rules mode); multi-intent turns handled in one reply |
| Ask only necessary questions | Identity-first flow: one question (the PNR); `verify_identity` returns profile + bookings, which are never re-asked |
| Use the supplied data and policies | Data pack as seed data; `kb.js` serves verbatim §-cited rules; `policy.js` enforces §3/§4 in code the model can't bypass |
| Recommend or execute the correct next action | Nine tools execute refunds, rebookings and compensation; the options offered are exactly what policy provides |
| Handle an angry or confused customer | Empathy per the §5 tone samples; capability fallback for confusion; anger never changes entitlements |
| Escalate when authority is missing | Prohibited-list + ₹1,500 waiver limit + legal threats → tickets; the console's Approve/Deny closes the loop |
| **Preserve a clear conversation and action record** | **Persistent audit log** (`data/audit.jsonl`): every message, action, escalation and supervisor decision, appended as it happens. Survives restarts, full transcripts in the Resolution Console, one-click **Download record** (JSON) per case |

### The three scenarios (all §6 outcomes enforced)

- **Priya Nair (Gold, SK4821X)** — SK-204 cancelled → her choice of free rebooking within 24h
  (Gold priority) or a full refund (7 business days, original payment method only). The free
  business-class upgrade "for the trouble" is beyond policy → escalated, never approved.
- **Arvind Kulkarni (Silver, TR1190B)** — SK-118 delayed 4h → meal voucher + lounge access.
  Hotel needs >5h → declined with the rule; "make an exception" → escalation ticket.
- **Meher Kaur (Platinum, WL7742)** — SK-305 delayed 6h → voucher, lounge, and hotel covering
  the delayed hours only (14:00–20:00), never a full night. Moving to the higher-fare flight is
  voluntary: ₹2,000 payable, above the ₹1,500 agent waiver limit → pay, supervisor review, or stay.

## Files

```
server.js        HTTP server: static UI + /api/session, /api/message, /api/health.
                 Provider resolution (Claude → Groq → Gemini → OpenRouter → custom
                 → keyless probe → rules) and the session store.
policy.js        The shared deterministic layer: system prompt builder (data pack,
                 customer-scoped), 6 tool definitions, and the policy checks no
                 model can bypass. Both runners use it.
agent-openai.js  Free-LLM runner: OpenAI-compatible chat loop (built-in fetch,
                 zero deps) with retries/backoff for free-tier flakiness.
agent.js         Anthropic runner (claude-opus-5): official SDK, prompt caching,
                 mid-conversation system guard, refusal handling.
engine.js        Data pack (verbatim) + delay-tier maths + the deterministic
                 rules-mode conversation engine. Runs in node and the browser.
app.js           UI: chat, suggested replies, auto-play, policy-trace console,
                 provider badge. Uses the server API; falls back to the
                 in-browser engine if no server is reachable.
styles.css       Design system (white + indigo).
index.html       Page shell + in-app data-pack viewer + "How it works".
test.js          56 checks: the three scenarios + guardrail probes (rules engine).
test-tools.js    25 checks: the shared policy layer (what no model can bypass).
```

### Interpretation notes (edge cases in the pack)

- A 6-hour delay literally satisfies both the ">3 hours" and ">5 hours" tiers, so Meher gets
  lounge access *and* the delayed-hours hotel alongside the meal voucher.
- The ₹500 amount is stated only for the under-3-hour tier, so longer delays issue a
  "meal voucher" without inventing an amount.
- Prohibited requests are declined with the policy reason and an in-policy alternative first;
  the escalation ticket is raised on insistence — except legal threats, which escalate
  immediately per the pack. Escalation outcomes are never promised.

Fictional airline, customers and data — everything comes from the assignment data pack.
The API key stays on the server; it is never sent to the browser.
