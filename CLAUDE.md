# Products HQ: notes for Claude sessions

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

## Budget (owner's hard limit: about $40/month in total)
- DigitalOcean: smallest app (apps-s-1vcpu-0.5gb, ~$5) plus dev database (~$7). Don't upsize.
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

## Next work, in order
1. Deploy with `node scripts/deploy.mjs` (see Deploying above).
2. Point the five Netlify sites' forms at `/api/leads/<product>` and their
   buy buttons at `/buy/<product>/<plan>`. The Netlify MCP connector can
   deploy. Confirm with the owner before publishing site changes.
3. Wire the tool APIs, one per handler: Local Falcon (FirstPageLocal),
   Awaz (Speed to Lead), MailWizz (EmailFirst), then FeedBoss and Sbl.so
   (Linkn, where approval stays mandatory), then ScoreApp. Needs API keys and
   docs from the owner; don't guess endpoints.
4. Outreach (`engine/outreach.ts`) sends through the app's own SMTP. For
   volume, sending should move to Mailpulse/MailWizz once that API is wired.
   Keep the PECR rules: corporate subscribers only by default, opt-out in
   every email, global suppression.
5. Inbound replies are handled by `engine/inbound.ts` via IMAP. The owner
   needs to set REPLY_TO and IMAP_URL for a mailbox that all replies reach.
