# HQ is switched off, and how to bring it back

On 6 November 2026 the owner switched off the HQ dashboard
(hq.onlinebusinessbuilder.co.uk) and the client accounts (account.&lt;site&gt;) to stop
the DigitalOcean bill. Nothing needed to restart it was thrown away. This page lists
what still works, what stopped, where everything is kept, and the steps to bring HQ
back.

## What still works without HQ

- **The product sites** on Netlify (linkn.co.uk, speedtolead.co.uk,
  onlinebusinessbuilder.co.uk, goodquestions.co.uk, emailfirst.co.uk). The files are
  in `sites/`, published with the "Publish sites to Netlify" workflow.
- **Calls** are booked straight on Cal.com, at `cal.com/felix-clarke/<product>-chat`
  for a chat and `cal.com/felix-clarke/<product>-onboarding` for onboarding. Cal.com
  sends its own confirmation with the Zoom link.
- **Sign-ups** use Stripe payment links. After paying, the buyer goes straight to the
  product's onboarding call on Cal.com. The payment page shows the Stripe account's
  name (Business Leads), which the owner accepted. Stripe emails the receipts.

  | Plan | Payment link |
  |---|---|
  | Linkn Starter, £199 a month | https://buy.stripe.com/7sY6oG9wr9pV4Lheb32Nq04 |
  | Linkn Business, £349 a month | https://buy.stripe.com/9B68wO0ZV31xcdJeb32Nq05 |
  | Linkn Growth, £649 a month | https://buy.stripe.com/cNi7sK7oj1XtelReb32Nq06 |
  | Speed to Lead Solo, £149 a month and £195 setup | https://buy.stripe.com/7sY5kC7oj0TpelRgjb2Nq07 |
  | Speed to Lead Team, £249 a month and £195 setup | https://buy.stripe.com/14AfZgaAv45BelR9UN2Nq08 |
  | Online Business Builder, £99 a month | https://buy.stripe.com/bJe00i7oj6dJ1z56IB2Nq09 |

  The "Payment links" workflow (`scripts/payment-links.ts`) lists them, or makes any
  that are missing. The EmailFirst site has no sign-up button; it books a chat.
- **Forms** (the Linkn and Online Business Builder profile reviews, and the Good
  Questions "ask for help" form) use Netlify Forms. Each entry is emailed to
  info@felixclarke.com and is also listed in Netlify under Forms.
- **The Good Questions AI readiness report** is the result on the page itself, with a
  button to print it or save it as a PDF. Nothing is emailed. Only people who ask for
  help send their details and scores, and Felix gets back to them within two working
  days. While HQ was running it emailed the report and kept every result for the
  research; that stopped with HQ.
- **MailWizz** landing pages and anything already scheduled in MailWizz keep running,
  as they never depended on HQ.

## What stopped

- Every automatic job, such as replies to enquiries, follow-ups, cold outreach,
  onboarding emails and reminders, monthly reports, the morning digest, Mailpulse
  prospect sync, billing reminders and the health checks.
- Client accounts on account.&lt;site&gt; (log-in, dashboard, billing pages) and any
  links to them in emails already sent, including Good Questions survey links
  (account.goodquestions.co.uk/survey/…).
- Reading replies. Mail to info+hq@felixclarke.com still lands in Gmail under the
  "HQ Replies" label, but nothing acts on it.
- Webhooks into HQ. HQ's own Stripe and Cal.com webhooks were removed. The Sbl.so
  webhook and the Make scenario "Watch Calls" (Awaz calls) were set up by hand and
  now point at nothing, so turn the Make scenario off to stop its error emails.

## Where everything is kept

| What | Where |
|---|---|
| Code | This repository, branch `claude/sharp-mayer-p52klq` |
| Database backup | Emails in info@felixclarke.com (Sent Mail and Inbox), subject `hq-snapshot-20261106-1503 part N of M`. Keep every part. Part 1 also holds the settings that only the app had (the dashboard password and the Sbl.so and Awaz webhook addresses), so keep it private. |
| Keys | GitHub repository secrets (listed below). Nothing secret is in the code. |
| Cal.com call types | Cal.com, unchanged |
| Stripe products, prices and payment links | Stripe (Email First Ltd account, shared with Mailpulse and Business Leads) |
| Prospect master file | UK_Prospects_Master.csv in Felix's Google Drive (also inside the backup) |
| DNS | GoDaddy still has the CNAMEs for hq.onlinebusinessbuilder.co.uk and account.linkn.co.uk, account.speedtolead.co.uk, account.goodquestions.co.uk and account.onlinebusinessbuilder.co.uk. Cloudflare has account.emailfirst.co.uk. They point at the deleted app and are harmless; Deploy points them at the new app. |

HQ uses these repository secrets. DIGITALOCEAN_ACCESS_TOKEN, STRIPE_SECRET_KEY,
ANTHROPIC_API_KEY, ADMIN_PASSWORD (optional), GMAIL_APP_PASSWORD, REPLY_MAILBOX
(optional), CALCOM_API_KEY, NETLIFY_AUTH_TOKEN, GODADDY_API_KEY, GODADDY_API_SECRET,
MAILWIZZ_API_URL, MAILWIZZ_API_KEY, MAILWIZZ_LOGIN_EMAIL, MAILWIZZ_LOGIN_PASSWORD,
AWAZ_API_KEY, AWAZ_TEST_AGENT_ID, AWAZ_TEST_FROM_ID, FEEDBOSS_API_KEY,
LOCALFALCON_API_KEY, SBL_API_KEY, SBL_COMPANY_ID, SBL_WEBHOOK_SECRET, EF_FROM_EMAIL,
GQ_FROM_EMAIL, GBP_MANAGER_EMAIL and SCOREAPP_API_KEY. Do not add RESEND_API_KEY back
as a way to send; it belongs to another business and has none of our domains.

## How the backup works

HQ's data was in a small database that DigitalOcean attaches to the app itself, which
only the app can reach. (The separate cluster products-hq-db, named in
`.do/app.yaml`, turned out to be empty and unused, so it was deleted too.) So HQ makes
its own backup and restores itself, through its own Gmail mailbox
(`src/ops/snapshot.ts` and `src/ops/snapshot-mail.ts`).

- **Making one.** When `SNAPSHOT_REQUEST` names a backup that hasn't been made, HQ
  pauses everything, runs pg_dump on its `app` schema and emails the file in 15 MB
  parts to its own mailbox. The password never appears on a command line or in a log.
- **Checking one.** The "HQ snapshot" workflow, given the backup's exact name, reads
  the parts back from Sent Mail (only emails the mailbox sent itself count), checks
  the SHA-256, restores the backup into a throwaway database and compares every row
  count. The "HQ shutdown" workflow won't delete anything without a successful check
  of the backup `SNAPSHOT_REQUEST` names.
- **Restoring one.** When `RESTORE_REQUEST` names a backup, HQ fetches it on start,
  loads it before setting up its tables, checks the row counts and starts paused. It
  only ever does this once, and never over a database that already has customers,
  leads or prospects.

## Bring HQ back

Allow about an hour. Do the steps in order.

1. **Check the keys.** In GitHub, Settings, Secrets and variables, Actions, check the
   secrets above are there. Run the "SMTP check" and "IMAP check" workflows. Both must
   pass, because HQ restores itself through Gmail. If you want the old dashboard
   password, copy ADMIN_PASSWORD from the app-settings file attached to part 1 of the
   backup into the ADMIN_PASSWORD secret. Otherwise set a new one, so Deploy doesn't
   print a generated one in its public log.
2. **Ask HQ to restore the backup.** In `src/ops/snapshot.ts` set
   `RESTORE_REQUEST = "hq-snapshot-20261106-1503"` (the exact name). Leave
   `SNAPSHOT_REQUEST` as it is; the restored database knows that backup was made.
   For a quiet first start, also add this to the `envs` of the web service in
   `.do/app.yaml`, so no jobs run until you're ready.
   ```yaml
   - key: SCHEDULER_ENABLED
     scope: RUN_TIME
     value: "false"
   ```
   Commit both to `claude/sharp-mayer-p52klq`.
3. **Deploy.** Run the "Deploy" workflow. It creates the app and its database, points
   the GoDaddy CNAMEs at it, and creates the Stripe and Cal.com webhooks. In its log,
   check every `DNS:` line shows 200, and look for "Created Stripe webhook" and
   "Cal.com webhook created". Add the account.emailfirst.co.uk CNAME in Cloudflare by
   hand if it was removed.
4. **Check the restore.** Run "HQ shutdown" with the confirm box left empty. It
   changes nothing and shows HQ's start-up lines. Look for
   `HQ restore: hq-snapshot-20261106-1503 loaded, … every row count matches` and the
   `HQ database` line. If it isn't there, read the "Things to know" section below.
5. **Turn the restore request off.** Set `RESTORE_REQUEST = ""` and commit.
6. **Webhook addresses.** To keep the old Sbl.so and Awaz addresses, copy
   SBL_WEBHOOK_TOKEN and AWAZ_WEBHOOK_TOKEN from the app-settings file in part 1 into
   the app's settings in DigitalOcean (App, web, Settings, Environment Variables).
   Otherwise copy the new addresses from HQ's Linkn and Speed to Lead product pages
   into Sbl.so and the Make scenario "Watch Calls", and turn the scenario back on.
7. **Before switching on**, catch up on what happened while HQ was off.
   - People who booked on Cal.com while HQ was off. Clear their follow-ups, and tick
     onboarding calls on each customer's page.
   - People who paid through a payment link. HQ didn't see those payments. For each
     completed checkout in Stripe, open
     `https://account.<site>/welcome?session_id=<checkout session id>` to bring the
     customer into HQ, then send them a login link from their customer page. Don't
     fill in the password form yourself.
   - Form entries from Netlify Forms. Add any that are still open as leads.
   - Unsubscribes in MailWizz on the "EF |" and "GQ |" lists. Add them to HQ's
     do-not-contact list (Outreach page), then run the Mailpulse sync on Settings,
     Prospect database.
   - Replies in the "HQ Replies" label. HQ only reads unread ones, so mark as read
     any Felix already dealt with, and as unread any that still need HQ, especially
     "stop" requests.
   - Queued emails. Anything queued before the shutdown may now be out of date.
8. **Switch it on.** Remove `SCHEDULER_ENABLED` from `.do/app.yaml`, commit and run
   Deploy. Then sign in and use Settings, Switch everything back on.
9. **Point the sites back** at HQ if you want client accounts again. The old links
   (account.&lt;site&gt;/chat, /buy/&lt;product&gt;/&lt;plan&gt;, /login and the
   /api/leads forms) are in the history of `sites/`, before commit 94edf64. Run "Pull
   sites from Netlify" first, edit, then publish each site.

## If the automatic restore can't be used

- **From a workflow.** "Restore HQ snapshot" loads a backup into the products-hq-db
  cluster from outside. Use it only when the `HQ database` line shows HQ is using that
  cluster, and only one restore route per restart.
- **By hand.** In Gmail open each part, choose Download message, then run
  `npx tsx scripts/hq-snapshot.ts join backup.dump part1.eml part2.eml …` and
  `pg_restore --no-owner --no-acl --single-transaction -d <database> backup.dump`
  against HQ's database before HQ first starts.

## Things to know

- **Keep the backup readable.** It lives only in Gmail. Don't delete the part emails,
  don't turn off IMAP for the mailbox, and keep Sent Mail and All Mail shown in IMAP
  (Gmail Settings, Labels).
- **A restore that stops HQ starting.** If the Gmail login is missing or wrong, HQ
  stops rather than start empty. Fix GMAIL_APP_PASSWORD and run Deploy again; it tries
  the restore again on every start.
- **The image** installs the Postgres 16 tools from apt.postgresql.org. If a future
  build fails there, pin the base image in the `Dockerfile` to a specific Debian
  release.
- **Data from after the backup** was made (about 15:05 UTC on 6 November 2026, while
  HQ sat paused until it was deleted) isn't in it. That means replies read, webhooks
  received and client actions in that window.
- **First start on an empty database** (for example if the restore was forgotten)
  emails Felix an HQ invite. Ignore it, add the restore and deploy again; the restore
  replaces an empty database but never one with customers, leads or prospects.

## Workflows

| Workflow | What it does | Needs HQ running |
|---|---|---|
| Deploy | Creates or updates HQ, its database, DNS, Stripe and Cal.com webhooks | No, it creates it |
| HQ snapshot | Checks a backup from the mailbox by restoring it into a throwaway database | No |
| Restore HQ snapshot | Loads a backup into the products-hq-db cluster from outside | Yes, its database |
| HQ shutdown | Dry run shows what exists and HQ's start-up lines; with DELETE removes HQ | No |
| Payment links | Lists, or makes, the sites' Stripe payment links | No |
| Publish sites to Netlify | Publishes `sites/<name>` (choose one site; "all" also overwrites emailfirst) | No |
| Pull sites from Netlify | Copies the live sites into `sites/` and commits | No |
| Check sites | Loads pages as a visitor and lists their booking, sign-up and form links | No |
| SMTP check, IMAP check | Check the Gmail login HQ sends and reads with | No |
