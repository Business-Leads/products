// End-to-end tests against a real Postgres database (TEST_DATABASE_URL).
// No external services are called: Stripe events are constructed locally and
// the Claude/Local Falcon integrations are unconfigured, which exercises the
// manual-task fallbacks.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hq:hq@localhost:5432/products_hq_test";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.ADMIN_PASSWORD = "pw";
process.env.BASE_URL = "https://hq.example.com";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SMTP_URL;

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Stripe from "stripe";

const { pool, query, one } = await import("../src/db/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { createLead, processLeads } = await import("../src/engine/leads.js");
const { decideTask } = await import("../src/engine/actions.js");
const { handleStripeEvent } = await import("../src/engine/billing.js");
const { duePeriod, runRoutines, skipStep, setCustomerStatus } = await import("../src/engine/workflow.js");
const { buildCheckoutParams } = await import("../src/lib/stripe.js");
const { requireProduct, getPlan } = await import("../src/products/index.js");
const { buildServer } = await import("../src/web/server.js");

async function reset() {
  await query(`TRUNCATE leads, customers, onboarding_steps, tasks, emails, deliveries, disputes, stripe_events,
    events, job_runs, health_checks, settings, sessions RESTART IDENTITY CASCADE`);
}

async function openTasks() {
  return query(`SELECT * FROM tasks WHERE status = 'open' ORDER BY id`);
}

function checkoutEvent(id: string, product: string, plan: string, extra: Record<string, string> = {}): Stripe.Event {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${id}`,
        customer: `cus_${id}`,
        subscription: `sub_${id}`,
        customer_details: { email: "owner@example.co.uk", name: "Sam Owner", phone: null },
        metadata: { hq_product: product, hq_plan: plan, ...extra },
      },
    },
  } as unknown as Stripe.Event;
}

before(async () => {
  await migrate();
});
after(async () => {
  await pool.end();
});
beforeEach(reset);

describe("routine scheduling", () => {
  const activated = new Date("2026-09-20T14:00:00Z");

  it("monthly anniversary routines skip the month the customer went live", () => {
    const c = { every: "month", dayOfMonth: "anniversary" } as const;
    assert.equal(duePeriod(c, activated, new Date("2026-09-24T10:00:00Z")), null);
    assert.equal(duePeriod(c, activated, new Date("2026-10-19T10:00:00Z")), null);
    assert.equal(duePeriod(c, activated, new Date("2026-10-20T10:00:00Z")), "2026-10");
    // catches up later in the month if a run was missed
    assert.equal(duePeriod(c, activated, new Date("2026-10-27T10:00:00Z")), "2026-10");
  });

  it("clamps anniversaries to short months", () => {
    const c = { every: "month", dayOfMonth: "anniversary" } as const;
    assert.equal(duePeriod(c, new Date("2026-01-31T12:00:00Z"), new Date("2026-02-28T12:00:00Z")), "2026-02");
  });

  it("weekly and weekday routines respect the day and 08:00 UK time", () => {
    assert.equal(duePeriod({ every: "week", weekday: 1 }, activated, new Date("2026-09-28T09:00:00Z")), "2026-09-28");
    assert.equal(duePeriod({ every: "week", weekday: 1 }, activated, new Date("2026-09-29T09:00:00Z")), null);
    assert.equal(duePeriod({ every: "day", weekdaysOnly: true }, activated, new Date("2026-09-26T09:00:00Z")), null);
    assert.equal(duePeriod({ every: "day" }, activated, new Date("2026-09-28T06:00:00Z")), null);
  });
});

describe("checkout", () => {
  it("adds the Speed to Lead setup fee as a one-off line", () => {
    const p = requireProduct("speedtolead");
    const params = buildCheckoutParams(p, getPlan(p, "solo")!, { leadId: 7 });
    assert.equal(params.line_items!.length, 2);
    assert.equal(params.line_items![0]!.price_data!.unit_amount, 14900);
    assert.equal(params.line_items![1]!.price_data!.unit_amount, 19500);
    assert.equal(params.line_items![1]!.price_data!.recurring, undefined);
    assert.equal(params.metadata!.hq_product, "speedtolead");
    assert.equal(params.metadata!.hq_lead_id, "7");
  });

  it("bills EmailFirst weekly with recurring and one-off add-ons", () => {
    const p = requireProduct("emailfirst");
    const params = buildCheckoutParams(p, getPlan(p, "weekly")!, { addOns: ["phones", "video", "bogus"] });
    const items = params.line_items!;
    assert.equal(items.length, 3);
    assert.equal(items[0]!.price_data!.recurring!.interval, "week");
    assert.equal(items[1]!.price_data!.recurring!.interval, "week");
    assert.equal(items[2]!.price_data!.recurring, undefined);
  });
});

describe("enquiries", () => {
  it("drafts a reply, holds it for approval, then queues it and schedules follow-ups", async () => {
    const lead = await createLead({ product: "firstpagelocal", name: "Jo Spark", email: "Jo@Spark.co.uk", business: "Spark Electrical" });
    const dup = await createLead({ product: "firstpagelocal", email: "jo@spark.co.uk" });
    assert.equal(dup.duplicate, true);

    const r = await processLeads();
    assert.equal(r.drafted, 1);
    const [task] = await openTasks();
    assert.equal(task.action, "send_email");
    const email = await one(`SELECT * FROM emails WHERE id = $1`, [task.payload.emailId]);
    assert.equal(email.status, "draft");
    assert.match(email.body_text, /https:\/\/hq\.example\.com\/buy\/firstpagelocal\/monthly\?lead=1/);
    assert.match(email.body_text, /AI Future Technologies Ltd/);

    await decideTask(task.id, "approve", { subject: "Edited subject", body: "Edited body" });
    const sent = await one(`SELECT * FROM emails WHERE id = $1`, [task.payload.emailId]);
    assert.equal(sent.status, "queued");
    assert.equal(sent.subject, "Edited subject");
    assert.match(sent.body_text, /^Edited body\n\n--\nFirstPageLocal is a trading name/);

    const l = await one(`SELECT * FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(l.status, "contacted");
    assert.equal(l.touches, 1);
    assert.ok(l.next_touch_at > l.created_at);
  });

  it("accepts website form posts and rejects honeypot spam", async () => {
    const app = await buildServer();
    const ok = await app.inject({
      method: "POST",
      url: "/api/leads/linkn",
      headers: { "content-type": "application/json", origin: "https://linkn-co-uk.netlify.app" },
      payload: { email: "a@b.co", linkedin: "https://linkedin.com/in/x" },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["access-control-allow-origin"], "https://linkn-co-uk.netlify.app");
    const spam = await app.inject({
      method: "POST",
      url: "/api/leads/linkn",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "email=spam%40x.co&company-name=bot&_redirect=https://linkn-co-uk.netlify.app/thanks/",
    });
    assert.equal(spam.statusCode, 302);
    const leads = await query(`SELECT * FROM leads`);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].data.linkedin, "https://linkedin.com/in/x");
    await app.close();
  });
});

describe("a FirstPageLocal customer from payment to first monthly report", () => {
  it("runs onboarding with manual fallbacks, goes live and schedules the monthly report", async () => {
    const lead = await createLead({ product: "firstpagelocal", email: "owner@example.co.uk" });
    await handleStripeEvent(checkoutEvent("evt_1", "firstpagelocal", "monthly", { hq_lead_id: lead.id }));
    await handleStripeEvent(checkoutEvent("evt_1", "firstpagelocal", "monthly")); // duplicate delivery is ignored

    const customers = await query(`SELECT * FROM customers`);
    assert.equal(customers.length, 1);
    const c = customers[0];
    assert.equal(c.status, "onboarding");
    assert.equal((await one(`SELECT status FROM leads WHERE id = $1`, [lead.id])).status, "won");

    const welcome = await one(`SELECT * FROM emails WHERE kind = 'onboarding:welcome'`);
    assert.equal(welcome.status, "queued");
    assert.match(welcome.body_text, new RegExp(`/start/${c.intake_token}`));

    // Intake form
    const app = await buildServer();
    const form = await app.inject({ method: "GET", url: `/start/${c.intake_token}` });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /Name exactly as it appears on Google Maps/);
    const submitted = await app.inject({
      method: "POST",
      url: `/start/${c.intake_token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        name: "Sam Owner",
        business: "Owner Plumbing",
        town: "Stockport",
        gbp_name: "Owner Plumbing Ltd",
        searches: "plumber stockport",
        report_email: "reports@example.co.uk",
      }).toString(),
    });
    assert.equal(submitted.statusCode, 200);
    await app.close();

    // Local Falcon isn't automated, so provisioning becomes a manual task.
    let tasks = await openTasks();
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Set up location/);
    assert.match(tasks[0].body, /manual because Local Falcon/);
    await decideTask(tasks[0].id, "done");

    // The baseline report asks for scan results...
    tasks = await openTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].payload.inputLabel, "Paste baseline scan results here");
    await decideTask(tasks[0].id, "done", { input: "plumber stockport: rank 4; ChatGPT recommends A, B, C" });

    // ...and with no Claude key the draft itself falls back to a person.
    tasks = await openTasks();
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].body, /manual because/);
    await decideTask(tasks[0].id, "done");

    const live = await one(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(live.status, "active");
    assert.ok(live.activated_at);
    const steps = await query(`SELECT status FROM onboarding_steps WHERE customer_id = $1`, [c.id]);
    assert.ok(steps.every((s) => s.status === "done"));
    const liveEmail = await one(`SELECT * FROM emails WHERE kind = 'onboarding:go_live'`);
    assert.equal(liveEmail.to_address, "reports@example.co.uk");

    // Next month, on the anniversary, the monthly report routine starts.
    const nextMonth = new Date(live.activated_at);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCHours(10);
    const r = await runRoutines(nextMonth);
    assert.equal(r.created, 1);
    const delivery = await one(`SELECT * FROM deliveries`);
    assert.equal(delivery.status, "blocked");
    tasks = await openTasks();
    assert.match(tasks[0].title, /This month's scan results/);
    const again = await runRoutines(nextMonth);
    assert.equal(again.created, 0);
  });

  it("marks payment trouble, dunning once, and restores when paid", async () => {
    await handleStripeEvent(checkoutEvent("evt_2", "linkn", "business"));
    const c = await one(`SELECT * FROM customers`);
    assert.equal(c.amount_pence, 34900);

    const invoice = { id: "in_1", hosted_invoice_url: "https://pay.example/in_1", parent: { subscription_details: { subscription: "sub_evt_2" } } };
    await handleStripeEvent({ id: "evt_3", type: "invoice.payment_failed", data: { object: invoice } } as unknown as Stripe.Event);
    await handleStripeEvent({ id: "evt_4", type: "invoice.payment_failed", data: { object: invoice } } as unknown as Stripe.Event);
    assert.equal((await one(`SELECT status FROM customers`)).status, "past_due");
    const dunning = await query(`SELECT * FROM emails WHERE kind = 'dunning'`);
    assert.equal(dunning.length, 1);

    await handleStripeEvent({ id: "evt_5", type: "invoice.paid", data: { object: invoice } } as unknown as Stripe.Event);
    const restored = await one(`SELECT * FROM customers`);
    assert.equal(restored.status, "onboarding");
    assert.equal(restored.past_due_since, null);
  });

  it("ignores Stripe events that belong to other businesses on the shared account", async () => {
    const foreign = { id: "evt_x", type: "checkout.session.completed", data: { object: { id: "cs_x", metadata: {} } } };
    await handleStripeEvent(foreign as unknown as Stripe.Event);
    assert.equal((await query(`SELECT * FROM customers`)).length, 0);
    assert.equal((await one(`SELECT relevant FROM stripe_events WHERE id = 'evt_x'`)).relevant, false);
  });

  it("verifies webhook signatures", async () => {
    const app = await buildServer();
    const payload = JSON.stringify(checkoutEvent("evt_sig", "firstpagelocal", "monthly"));
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
    const good = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": header },
      payload,
    });
    assert.equal(good.statusCode, 200);
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" },
      payload,
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((await query(`SELECT * FROM customers`)).length, 1);
    await app.close();
  });
});

describe("Linkn plan-specific onboarding", () => {
  it("skips outreach steps for Starter", async () => {
    await handleStripeEvent(checkoutEvent("evt_6", "linkn", "starter"));
    const steps = await query(`SELECT key, status FROM onboarding_steps ORDER BY position`);
    const skipped = steps.filter((s) => s.status === "skipped").map((s) => s.key);
    assert.deepEqual(skipped, ["campaign_drafts", "launch", "call_guide"]);
  });
});

describe("manual controls", () => {
  it("skipping a waiting step closes its task and moves on; cancelling clears pending work", async () => {
    await handleStripeEvent(checkoutEvent("evt_7", "firstpagelocal", "monthly"));
    const c = await one(`SELECT * FROM customers`);
    const intake = await one(`SELECT * FROM onboarding_steps WHERE key = 'intake'`);
    assert.equal(intake.status, "waiting");
    await skipStep(intake.id);
    const tasks = await openTasks();
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Set up location/);
    await skipStep(tasks[0].payload.stepId);
    assert.equal((await one(`SELECT status FROM tasks WHERE id = $1`, [tasks[0].id])).status, "dismissed");

    await setCustomerStatus(c.id, "cancelled");
    assert.equal((await one(`SELECT status FROM customers`)).status, "cancelled");
    assert.equal((await openTasks()).length, 0);
  });
});

describe("admin", () => {
  it("requires sign-in", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/inbox" });
    assert.equal(res.statusCode, 302);
    const login = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "password=pw&next=/inbox",
    });
    assert.equal(login.statusCode, 303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const inbox = await app.inject({ method: "GET", url: "/inbox", headers: { cookie } });
    assert.equal(inbox.statusCode, 200);
    await app.close();
  });
});
