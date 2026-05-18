# A phone receptionist in 60 seconds

Paste a Google Maps URL. We read the business, design a custom AI receptionist, and provision a real US phone number you can call. The agent picks up, knows your hours, books appointments, takes messages, and answers caller questions about your services — all in a voice that fits the business.

Built for the YC hackathon.

---

## The flow

```
  Paste Google Maps URL
           │
           ▼
   Google Places API ────────►  business profile (name, hours, phone, reviews)
           │
           ▼
   Firecrawl  ───────────────►  one-page website markdown
           │
           ▼
   Claude (system-prompt gen)  ►  receptionist persona + service menu
                                  + 2-5 business-specific intake questions
           │
           ▼
   AgentPhone (createAgent +    ►  live US phone number, voice config,
   provisionNumber + attach)       webhook URL, opening line
           │
           ▼
   Moss (semantic index) ──────►  on-call website search

  → returns a phone number the user can call right now
```

End-to-end: 30-60 seconds from URL to working number on a real call.

## A live call

```
Caller dials → AgentPhone → /api/agentphone/webhook
                                  │
                                  ▼
                       HMAC verify + load business + caller
                                  │
                                  ▼
                         Gemini 2.5 Flash agent loop
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
        check_availability  book_appointment   search_business_info
        lookup_caller       cancel_appointment update_caller_info
        modify_appointment  transfer_to_human
                                  │
                                  ▼
                  NDJSON stream back to AgentPhone → voice
```

Gemini handles the voice turn because of streaming latency. Claude only runs once, at provisioning time, to draft the persona.

## What's nice about it

- **Real numbers, real calls.** Not a demo widget — every provision gives you a number that actually rings.
- **Business-aware intake.** Claude infers what a real receptionist for *this* business type would ask before booking ("what kind of pet?" for a vet, "what's the issue?" for a plumber, none for a takeout spot).
- **Eight tools the agent uses on the call**: check availability, book, cancel, modify, lookup caller, update caller, transfer, search website. Cancel/modify match by 6-char REF code or by date/time/service.
- **In-call website search.** [Moss](https://github.com/usemoss/moss) indexes the scraped site into ~800-char chunks. The agent calls `search_business_info` for specific factual questions ("do you carry Meguiar's Ultimate?", "what's your refund policy?") and gets an answer in single-digit milliseconds.
- **Deep-research follow-up.** A button on the business page kicks off [browser-use](https://browser-use.com/) to do an agentic multi-page browse, then regenerates the prompt, service menu, and intake — and pushes the new prompt to the live AgentPhone agent. Bigger upgrade for sites that hide content behind a couple of clicks.
- **Caller memory.** Every caller is upserted by phone number. On the second call the agent greets by name, knows past appointments, and can quote their REF codes.
- **Streaming transcripts.** Voice turns stream back to AgentPhone as NDJSON, so the caller hears the first words while the rest is still generating.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router (Turbopack) | Serverless routes for the webhook + page-render for the dashboard |
| Auth | Clerk | Drop-in, Next-native, free hackathon tier |
| Database | MongoDB (Atlas) | Loose schema fit for the rapidly-evolving Business doc |
| Maps | Google Places API (New) | Authoritative source for hours, address, reviews |
| Web scrape | Firecrawl | Fast (~3s), cheap, single-page markdown |
| Deep scrape (optional) | browser-use | Agentic multi-page browse for richer prompts |
| Prompt designer | Anthropic Claude Sonnet | Once per business — quality over latency |
| Voice agent | Google Gemini 2.5 Flash | Streaming + low latency for the turn loop |
| Telephony | AgentPhone | Provisions real numbers, handles voice + webhook |
| Vector search | Moss (in-process) | Sub-10ms in-call lookups, no external service |
| UI | shadcn/ui + Tailwind + Radix | Standard polished components, fast to build |

## Quickstart

```bash
git clone <this repo>
cd yc-hackathon
npm install
cp .env.example .env.local   # then fill in keys
npm run dev
```

Open `http://localhost:3000`, sign up, paste a Google Maps URL of a business with a website (the more multi-page, the better — a salon or a restaurant works great), and watch a phone number show up. Then call it.

### Required env vars

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Base URL the AgentPhone webhook posts back to (use ngrok in dev) |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk auth |
| `MONGODB_URI` | Atlas connection string; `MONGODB_DB_NAME` optional |
| `GOOGLE_PLACES_API_KEY` | Places API (New) — needs Text Search + Place Details enabled |
| `FIRECRAWL_API_KEY` | Default website scrape at provision time |
| `ANTHROPIC_API_KEY` | Used by [lib/prompt.ts](lib/prompt.ts) to draft the receptionist persona |
| `GEMINI_API_KEY` | Powers the in-call voice agent loop |
| `AGENTPHONE_API_KEY` | Provisions agents + numbers |
| `AGENTPHONE_WEBHOOK_SECRET` | HMAC-verifies incoming voice webhooks |

### Optional (feature-gated)

| Variable | Purpose |
|---|---|
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | Enable in-call website search via Moss |
| `BROWSER_USE_API_KEY` | Enable the "Deep research" button on the dashboard |
| `GEMINI_MODEL` | Override the default voice model |
| `AGENTPHONE_BASE_URL`, `AGENTPHONE_DEFAULT_VOICE` | Override AgentPhone host / voice ID |
| `WEBHOOK_SKIP_VERIFY` | `true` skips HMAC verify — dev only, never in prod |

## Project layout

```
app/
  api/
    provision/route.ts                    POST: Maps URL → number
    agentphone/webhook/route.ts           POST: voice turn handler (NDJSON stream out)
    business/[id]/calls/route.ts          GET:  recent calls for the dashboard
    business/[id]/appointments/route.ts   GET:  upcoming bookings
    admin/agentphone/route.ts             POST: fix-agent, index-business, enrich-business
  business/[id]/page.tsx                  per-business dashboard
  page.tsx                                landing + paste-url form

lib/
  agent-loop.ts        Gemini tool-use loop with NDJSON streaming
  tools.ts             8 tools: check/book/cancel/modify/lookup/update/transfer/search
  agentphone.ts        AgentPhone REST client (create/update/attach)
  places.ts            Google Places (New) wrapper
  firecrawl.ts         fast default scrape
  browser-use.ts       optional deep-research scrape
  moss.ts              chunk + index + query
  prompt.ts            Claude meta-prompt that designs the receptionist
  caller-context.ts    returning-caller greeting + upcoming appointments
  availability.ts      hour-aware slot search + conflict check
  dates.ts             fixed-offset tz math (no DST — hackathon scope)
  mongo.ts             lazy client, collection helpers, indexes
  types.ts             Business / Caller / Appointment / Conversation shapes
```

## Design notes

A few decisions that aren't obvious from the code:

- **Two models on purpose.** Claude designs the prompt once (slow + smart), Gemini handles the call (fast + streaming). Same architecture you'd use in production.
- **Fixed-offset timezones, no DST.** Hours math is done in `UTC±N`. Wrong twice a year, right enough for a hackathon. See [lib/dates.ts](lib/dates.ts).
- **AgentPhone resources are sequential, not transactional.** If `attachNumber` fails after `createAgent`, we delete the agent. If Mongo insert fails after both succeed, we log orphans for manual cleanup. See [app/api/provision/route.ts](app/api/provision/route.ts).
- **`appointmentReference` is the last 6 chars of the Mongo `_id`, uppercased.** No separate short-code table. The agent reads it to the caller at booking; the caller can quote it back to cancel or modify. See [lib/tools.ts](lib/tools.ts).
- **Moss native bindings on Vercel.** Two-layer fix: `serverExternalPackages` so Turbopack doesn't try to bundle `.node` files, and explicit `outputFileTracingIncludes` so the platform-specific binary gets shipped with every function that imports Moss. See [next.config.ts](next.config.ts).
- **Deep research is opt-in and pricey.** Each browser-use enrich is ~30-120s and ~$0.05-$1 in LLM tokens. The button only appears when `BROWSER_USE_API_KEY` is set, and `maxDuration = 300` on the route (Vercel Pro required — Hobby caps at 60s).

## Known limits

- DST is wrong twice a year. Switch to IANA + `date-fns-tz` for prod.
- No background jobs. Long operations (deep research, indexing) hold the request open — fine on Pro, will time out on Hobby.
- No rate-limiting on `/api/admin/agentphone?action=enrich-business`. Trivial to abuse if exposed publicly.
- Single tenant per business: no team / multi-owner support yet.
- Voice is hard-coded per agent at provision time; no per-call switching.

## Credits

Built at the YC AI hackathon. Standing on the shoulders of: [AgentPhone](https://agentphone.to), [Moss](https://github.com/usemoss/moss), [browser-use](https://browser-use.com), [Firecrawl](https://firecrawl.dev), [Anthropic Claude](https://www.anthropic.com/claude), [Google Gemini](https://ai.google.dev/), [Clerk](https://clerk.com), [shadcn/ui](https://ui.shadcn.com), and [Next.js](https://nextjs.org).
