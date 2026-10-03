# Online Business Builder (operations dashboard): notes for Claude sessions

The whole project is branded **Online Business Builder**. The dashboard lives at
hq.onlinebusinessbuilder.co.uk. "products-hq" survives only as the internal
DigitalOcean app name; don't rename it, because the deploy script finds the app by that name.

The owner's plan usage is limited. Read this file and README.md, then work
directly. Don't re-research the products: what's known is encoded in
`src/products/*.ts`.

## What this is
One Node 22 / TypeScript app (Fastify + Postgres, no frontend build) that
markets, onboards and runs six products: FirstPageLocal, Linkn, Speed to
Lead, EmailFirst, Good Questions and Online Business Builder
(onlinebusinessbuilder.netlify.app, £99/month; customers pay first and then
book an onboarding call with Felix, via `bookingAfterPurchase`). It is meant to run autonomously on
DigitalOcean App Platform (`.do/app.yaml`). The operator (Felix) only
approves and checks quality through the Inbox.

## Decisions already made (don't re-ask)
- Payments: Stripe, **Email First Ltd** account. It is shared with Mailpulse
  and Business Leads, so the webhook only acts on objects tagged `hq_product`.
- Linkn prices are whatever is on the site: £199 / £349 / £649 a month.
- Speed to Lead runs on Awaz.ai.
- Hosting: DigitalOcean. Domains are in GoDaddy. Sites are on Netlify.
- Everything must run without a person. Human touchpoints are inbox tasks.
- Stick to the brief. Don't raise unrelated business matters (billing
  disputes, supplier issues and so on) unless asked.

## How it fits together
- `src/products/`: registry. Plans, intake fields, onboarding steps (kind
  auto | customer | approval | manual), routines (cadence + handler), sender,
  voice.
- `src/engine/handlers.ts`: step and routine handlers return an `Outcome`
  (done | waiting | email | review | manual). `workflow.ts` applies outcomes.
  `actions.ts` handles inbox decisions.
- A handler that needs an unwired tool calls `requireAutomation(id)`, which
  throws `NotConfiguredError`. The engine turns that into a manual task with
  the step's instructions.
- `src/integrations/index.ts`: set `automation: "full"` on an integration
  once its API calls are actually implemented in a handler.
- `src/jobs/index.ts` + `engine/scheduler.ts`: in-process scheduler with
  Postgres advisory locks.
- The web layer uses tagged-template HTML (`web/html.ts` escapes by default).
- Client accounts (`src/portal/`): each product has a password-protected client
  area, branded as that product, at `portal.host` (e.g. account.linkn.co.uk) once
  its slug is in PORTAL_DOMAINS (DNS CNAME to the app plus a DigitalOcean domain),
  otherwise at BASE_URL/portal/<slug>. `server.ts` rewrites those hosts to
  `/portal/<slug>/…`. Flow: Stripe checkout returns to `/welcome` (creates the
  password), then `/book` (if bookingAfterPurchase), then `/details`, then the
  dashboard (progress, figures, reports, updates), plus billing (invoices from
  webhooks, upgrade, cancel at period end), support and account pages.
  `engine/clients.ts` holds the actions; every one emails the operator.
- Clients must never see supplier names: every step and routine needs a
  client label (or null) in the product's `portal` block; a test enforces it.
- HQ: `/clients` (all client logins), `/support`, and per-customer panels
  (view their dashboard read-only, password links, disable login, figures,
  post updates that the client can approve to complete a step).

## Testing
Postgres 16 is available in the cloud container:

```bash
service postgresql start
su postgres -c "psql -c \"CREATE USER hq WITH PASSWORD 'hq' SUPERUSER;\""
su postgres -c "createdb -O hq products_hq_test"
npm test          # end-to-end, no external calls
npm run typecheck
```

Don't `pkill -f` a pattern that matches your own shell command; it kills the
shell.

## Budget
The owner lifted the earlier $40/month limit, but keep costs sensible.
- DigitalOcean: smallest app (apps-s-1vcpu-0.5gb) plus a small managed Postgres cluster. Don't upsize without reason.
- Claude: the dashboard defaults to claude-opus-5-5 with a hard cap,
  CLAUDE_MONTHLY_BUDGET_USD=20. Over budget, drafting falls back to templates
  and manual tasks.
- Never buy domains or anything else.

## Deploying
Preferred route: GitHub Actions → "Deploy" workflow (`.github/workflows/deploy.yml`),
which reads repository secrets (DIGITALOCEAN_ACCESS_TOKEN, STRIPE_SECRET_KEY,
ANTHROPIC_API_KEY, optional ADMIN_PASSWORD and MAIL_*). Trigger it with the GitHub
MCP `actions_run_trigger` and read the logs with `get_job_logs`. Claude Code sessions
can't reach DigitalOcean or Stripe directly.

Alternatively, keys can live in the Claude Code environment settings:
DIGITALOCEAN_ACCESS_TOKEN, STRIPE_SECRET_KEY, HQ_ANTHROPIC_API_KEY (named so it
doesn't switch Claude Code's own billing), and optionally GODADDY_API_KEY and
GODADDY_API_SECRET, MAIL_ADDRESS and MAIL_APP_PASSWORD (Google Workspace).

```bash
npm ci && node scripts/deploy.mjs
```

The script creates or updates the app from `.do/app.yaml` (deploying branch
`claude/sharp-mayer-p52klq`), waits for it to go live, and creates the Stripe
webhook and stores its secret. On first run it prints a generated dashboard
password; tell the owner.

Known blockers:
- The environment's network policy must allow api.digitalocean.com and
  api.stripe.com. If it doesn't, read the environment.network documentation
  and tell the owner.
- DigitalOcean must have GitHub access to Business-Leads/products. If app
  creation fails on the GitHub source, the owner installs the DigitalOcean
  GitHub app at cloud.digitalocean.com/apps/github/install.
- GoDaddy: api.godaddy.com is blocked from Claude Code sessions. The repo
  secret GODADDY_API_KEY exists, and GODADDY_API_SECRET is needed alongside it.
  `.github/workflows/godaddy-check.yml` (read-only) tests them by listing
  domains. DNS changes should run from a GitHub Actions workflow the same way,
  and only for domains the owner already has. Never buy domains.
- Pushing a new `main` branch was blocked by the session safety check. The
  app deploys from the working branch instead.

## Working with the owner
- The owner has visual difficulties: keep HQ large, high-contrast and plain
  (hq.css: cream background, Atkinson Hyperlegible 20px, colour per area).
  The owner loves the cute style: the logo (static/logo.svg) and every HQ and
  product icon (layout.ts ICONS / PRODUCT_ICONS) are white shapes with smiley
  faces on gradient tiles. Keep new icons in that style.
- Stripe checkout must never show Business Leads: `checkoutBranding()` in
  lib/stripe.ts sets each product's name, icon (static/products/*.png) and colours.
- Ask one simple question at a time; no long explanations.
- Do everything yourself; only make something a manual job when it truly
  can't be automated, and then give it a `guide` (why, minutes, numbered
  steps) so it shows as a clear card in the to-do list.

## Connections (state as of Oct 2026)
- Stripe live; checkout links work on each product's account domain
  (`account.<site>/buy/<product>/<plan>`), enquiry forms post to
  `account.<site>/api/leads/<product>`.
- Sites live in `sites/<name>/` and are published by the "Publish sites to
  Netlify" workflow. "Pull sites from Netlify" re-copies them.
- Client areas live on account.linkn.co.uk, account.speedtolead.co.uk,
  account.goodquestions.co.uk, account.onlinebusinessbuilder.co.uk and
  account.emailfirst.co.uk. emailfirst.co.uk's DNS is in Cloudflare (the
  `account` CNAME, A @ 75.2.60.5 and CNAME www -> emailfirst.netlify.app were
  added there by hand; deploy.mjs skips it for GoDaddy). The site is live at
  emailfirst.co.uk.
- Sbl.so: webhook into /webhooks/sbl/<token> (address shown on the Linkn
  product page). FeedBoss: Service API key (x-api-key); one workspace per
  client, created by hand. Awaz is only resold (Speed to Lead): Make scenario
  "Watch Calls" -> HTTP POST to /webhooks/awaz/<token>. We don't use Awaz
  ourselves: Felix does sales and onboarding calls himself.
- Booking: Cal.com (decided Oct 2026, replaces Calendly). One call type per
  product and kind, slug `<product>-chat` (sales) or `<product>-onboarding`
  (src/products/calls.json). deploy.mjs (secret CALCOM_API_KEY) creates
  missing types, sets CALCOM_USERNAME, and creates the webhook
  /webhooks/calcom/<token> (engine/calcom.ts): onboarding bookings tick the
  customer's call, sales chats become enquiries with follow-ups stopped. Sites
  link to `account.<site>/chat`, which redirects to the sales booking page.
  Every booking: a friendly email from us to the booker (with the Zoom link),
  the call shown in the client's account ("Your calls", data.calls), an email
  to Felix. The calendar is embedded on our own pages (`account.<site>/chat`
  and `/book`) because Cal.com's redirect-after-booking is a paid feature;
  after booking they go to `/booked?kind=` (signed-in clients: dashboard). Calls are Zoom only (Zoom app connected in
  Cal.com, username felix-clarke); tested end to end by the owner, Oct 2026.
- MailWizz/Mailpulse: weekly stats via `/campaigns/{uid}/stats`.
- Netlify + GoDaddy APIs: OBB client sites are generated by Claude, deployed
  to their own Netlify site, and domains pointed (never bought automatically).
- Blocked hosts from Claude Code sessions are reached through read-only
  GitHub workflows: check-sites, read-docs, domain-check, feedboss-check,
  godaddy-check, site-colours.

## Next work, in order
1. Wire what's still manual where an API exists (Local Falcon when
   FirstPageLocal launches). Sbl.so is done: it runs on the webhook, no API
   key needed. Don't guess endpoints: read
   the docs through the read-docs workflow.
2. Outreach (`engine/outreach.ts`) sends through the app's own SMTP. For
   volume, sending should move to Mailpulse/MailWizz once that API is wired.
   Keep the PECR rules: corporate subscribers only by default, opt-out in
   every email, global suppression.
3. Inbound replies are handled by `engine/inbound.ts` via IMAP. The owner
   needs to set REPLY_TO and IMAP_URL for a mailbox that all replies reach.
