# Products HQ

The central dashboard that markets, onboards and runs the five products, on
its own, around the clock. A person checks quality and approves what they
choose to. Everything else happens without them.

| Product | Price | Runs on |
|---|---|---|
| FirstPageLocal | £29/month | Local Falcon scans, Claude-drafted reports |
| Linkn | £199 / £349 / £649 a month | FeedBoss (posts) and Sbl.so (outreach) |
| Speed to Lead | £149 / £249 a month, plus £195 setup | Awaz.ai voice assistants |
| EmailFirst | £19/week, plus add-ons | Mailpulse / MailWizz |
| Good Questions | Quoted | ScoreApp and Mailpulse |

Each product is defined in `src/products/*.ts`: plans, intake form,
onboarding steps, recurring routines, sender address and tone of voice.

## What runs by itself

| Job | When | What it does |
|---|---|---|
| leads | every 5 min | Replies to new enquiries from the product sites (Claude drafts; a plain template if Claude isn't connected), then follows up on the product's schedule until they buy or say stop |
| inbox | every 5 min | Reads replies from the reply mailbox. "Stop" requests and "not interested" replies end follow-ups at once, out-of-office replies are ignored, and anything else stops automated follow-ups and goes to the inbox with a drafted answer |
| outreach | every 30 min, weekdays 9 to 5 | Cold email to imported prospects (Outreach page): written individually by Claude, a short sequence, a daily cap per product. Off until switched on. Only limited companies, LLPs, PLCs and public bodies by default (PECR). Replies become leads; "stop" goes on a permanent do-not-contact list shared by all products |
| onboarding | every 5 min | Moves every new customer through their product's checklist: welcome email, intake form and reminders, setup, first delivery, go-live |
| routines | every 30 min | Creates each live customer's recurring work (monthly reports, weekly reviews, content plans) and runs it |
| outbox | every minute | Sends queued email, with retries |
| billing | hourly | Pauses service after the product's grace period when a payment stays unpaid |
| health | every 5 min | Checks every product site; alerts after two failures, clears itself on recovery |
| digest | 07:30 daily | Emails the operator one summary: revenue, new customers, what was done, what's waiting, anything broken |
| watchdog | every 15 min | Alerts if any of the above stops completing |

Stripe webhooks create customers the moment they pay, track failed payments
(one reminder email with the payment link) and recover them when paid, and
raise disputes in the inbox with their evidence deadline.

## The inbox: where a person comes in

Anything that needs a human becomes a task in the **Inbox**:

- **Approvals.** Drafted emails, reports, call scripts and content plans. Edit
  them in place, approve, and the work carries on by itself.
- **Manual steps.** Work the system can't do yet, with instructions. Some ask
  for input, such as pasted scan results, which the system then turns into
  the customer's report.
- **Alerts.** A site is down, a job stalled, a payment was disputed, or an
  email failed.

Each product's page has **Autonomy** switches. Enquiry replies and each
routine can be set to "Needs my approval" or "Fully automatic". Everything
starts on approval. Switch a flow to automatic once its drafts are
consistently right. **Pause** stops all automated outbound for one product,
and *Automation → Pause everything* stops it for all of them.

Linkn keeps its hard rule: nothing is sent or posted on LinkedIn without a
person's approval.

## What is still manual

Claude, Stripe and email are fully automated. The product tools are
recorded but not yet driven through their APIs:

- Awaz
- Local Falcon
- MailWizz
- FeedBoss
- Sbl.so
- ScoreApp

Until each one is wired in, its steps appear in the inbox as manual tasks
with instructions, so nothing stalls unnoticed. The *Automation* page shows
the state of every connection. Wiring each API is the next phase, one
product at a time, once its API key and documentation are available.

## Going live

1. **Deploy on DigitalOcean.** `doctl apps create --spec .do/app.yaml` creates
   the app and its Postgres database in London. The spec deploys from `main`
   on every push.
2. **Set the secrets** in App → Settings → Environment variables. See
   `.env.example` for the full list.
   - `ADMIN_PASSWORD`: the app refuses to start in production without it.
   - `STRIPE_SECRET_KEY`: for the Email First Ltd account.
   - `SMTP_URL`: the sending server. Each product's from-address domain needs
     SPF and DKIM for it.
   - `ANTHROPIC_API_KEY`
3. **Add the Stripe webhook.** In the Email First Ltd Stripe account, add an
   endpoint at `https://<app>/webhooks/stripe` and put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. It needs these events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`
   - `charge.dispute.created`
   - `charge.dispute.updated`
   - `charge.dispute.closed`

   The account also bills Mailpulse and Business Leads. This app only acts on
   objects it created itself (tagged `hq_product`) and ignores everything
   else, so it's safe to add alongside the existing webhook.
4. **Connect the site forms.** Each product page in the dashboard shows the
   form snippet and the sign-up links (`/buy/<product>/<plan>`). Point each
   site's enquiry form at `/api/leads/<product>` and its buy buttons at the
   sign-up links.
5. **Domains.** Point the GoDaddy DNS for each product domain at its Netlify
   site. Give the dashboard its own subdomain as well (for example
   `hq.business-leads.co.uk`) with a CNAME to the DigitalOcean app. Then add
   the domains to `ALLOWED_ORIGINS` and `EXTRA_HEALTH_URLS`.

## Development

```bash
npm install
cp .env.example .env          # SMTP_URL=log prints emails instead of sending
createdb products_hq
npm run dev                    # http://localhost:8080
npm test                       # end-to-end tests; needs a products_hq_test database
npm run typecheck
```

The code is laid out as follows:

- `src/products/`: what each product is and how it's delivered
- `src/engine/`: onboarding steps, routines, handlers, billing, leads and the scheduler
- `src/jobs/`: the scheduled jobs
- `src/web/`: the dashboard, the public intake and checkout pages, and the webhooks
- `src/db/migrations/`: the schema, applied automatically on start
