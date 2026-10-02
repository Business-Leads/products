// Client account areas: sign-up to dashboard, sign-in security, billing and
// support, plus the HQ views of them. Stripe calls are replaced with stubs.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hq:hq@localhost:5432/products_hq_test";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.ADMIN_PASSWORD = "pw";
process.env.BASE_URL = "https://hq.example.com";
process.env.PORTAL_DOMAINS = "linkn";
process.env.SBL_WEBHOOK_TOKEN = "sbl-secret-token";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SMTP_URL;

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type Stripe from "stripe";

const { pool, query, one } = await import("../src/db/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { handleStripeEvent } = await import("../src/engine/billing.js");
const { getStripe } = await import("../src/lib/stripe.js");
const { products } = await import("../src/products/index.js");
const { buildServer } = await import("../src/web/server.js");

type App = Awaited<ReturnType<typeof buildServer>>;

async function reset() {
  await query(`TRUNCATE sbl_events, client_users, client_sessions, client_tokens, invoices, support_requests, client_updates, login_failures,
    leads, customers, onboarding_steps, tasks, emails, deliveries, stripe_events, events, settings, sessions RESTART IDENTITY CASCADE`);
}

function checkoutEvent(id: string, product: string, plan: string, email = "owner@example.co.uk"): Stripe.Event {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${id}`,
        customer: `cus_${id}`,
        subscription: `sub_${id}`,
        customer_details: { email, name: "Sam Owner", phone: null },
        metadata: { hq_product: product, hq_plan: plan },
      },
    },
  } as unknown as Stripe.Event;
}

const form = (data: Record<string, string>, cookie?: string) => ({
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  payload: new URLSearchParams(data).toString(),
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"];
  const first = Array.isArray(set) ? set[0] : String(set ?? "");
  return first.split(";")[0]!;
}

async function adminCookie(app: App): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/login", ...form({ password: "pw" }) });
  return cookieFrom(res);
}

/** Pay, then create a password from the checkout return page. Returns the session cookie. */
async function signUp(app: App, product: string, plan: string, id = "evt_a"): Promise<string> {
  await handleStripeEvent(checkoutEvent(id, product, plan));
  const res = await app.inject({
    method: "POST",
    url: `/portal/${product}/welcome`,
    ...form({ session_id: `cs_${id}`, password: "correct horse battery", confirm: "correct horse battery" }),
  });
  assert.equal(res.statusCode, 303);
  return cookieFrom(res);
}

let app: App;
before(async () => {
  await migrate();
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await reset();
  app = await buildServer();
});

const VENDORS = /awaz|mailwizz|mailpulse|feedboss|sbl\.so|sblso|scoreapp|local falcon|localfalcon|calendly|stripe|online business builder/i;

describe("client account areas", () => {
  it("label every step and routine for clients, without naming suppliers", () => {
    for (const p of products) {
      for (const s of p.onboarding) assert.ok(s.key in p.portal.steps, `${p.slug}: step ${s.key} needs a client label (or null)`);
      for (const r of p.routines) assert.ok(r.key in p.portal.routines, `${p.slug}: routine ${r.key} needs a client label (or null)`);
      const shown = [
        ...Object.values(p.portal.steps),
        ...Object.values(p.portal.routines),
        p.portal.resultsTitle,
        p.portal.resultsIntro,
        ...p.portal.metrics.map((m) => m.label),
        ...p.plans.map((pl) => `${pl.name} ${pl.summary}`),
      ].filter(Boolean).join("\n");
      // Online Business Builder may of course name itself.
      const check = p.slug === "onlinebusinessbuilder" ? shown.replace(/online business builder/gi, "") : shown;
      assert.doesNotMatch(check, VENDORS, p.slug);
    }
  });

  it("takes an Online Business Builder client from payment to their dashboard", async () => {
    await handleStripeEvent(checkoutEvent("evt_obb", "onlinebusinessbuilder", "monthly"));
    const c = await one(`SELECT * FROM customers`);

    // Back from checkout: create a password.
    const welcome = await app.inject({ method: "GET", url: "/portal/onlinebusinessbuilder/welcome?session_id=cs_evt_obb" });
    assert.match(welcome.body, /Create your password|Welcome to Online Business Builder/);
    assert.match(welcome.body, /owner@example\.co\.uk/);
    const weak = await app.inject({ method: "POST", url: "/portal/onlinebusinessbuilder/welcome", ...form({ session_id: "cs_evt_obb", password: "short", confirm: "short" }) });
    assert.equal(weak.statusCode, 400);
    const created = await app.inject({
      method: "POST",
      url: "/portal/onlinebusinessbuilder/welcome",
      ...form({ session_id: "cs_evt_obb", password: "correct horse battery", confirm: "correct horse battery" }),
    });
    assert.equal(created.headers.location, "/portal/onlinebusinessbuilder/book");
    const cookie = cookieFrom(created);
    assert.match(String(created.headers["set-cookie"]), /HttpOnly/i);

    // The return link can't be used again to take over the account.
    const again = await app.inject({ method: "POST", url: "/portal/onlinebusinessbuilder/welcome", ...form({ session_id: "cs_evt_obb", password: "another password!", confirm: "another password!" }) });
    assert.equal(again.headers.location, "/portal/onlinebusinessbuilder/login");

    // Book the onboarding call.
    const book = await app.inject({ method: "GET", url: "/portal/onlinebusinessbuilder/book", headers: { cookie } });
    assert.match(book.body, /calendly-inline-widget/);
    const booked = await app.inject({ method: "POST", url: "/portal/onlinebusinessbuilder/book/done", headers: { cookie } });
    assert.equal(booked.headers.location, "/portal/onlinebusinessbuilder/details");
    const alert = await one(`SELECT * FROM emails WHERE to_address = 'info@felixclarke.com' AND subject LIKE '%onboarding call booked%'`);
    assert.ok(alert, "operator is emailed when the call is booked");

    // Onboarding form.
    const saved = await app.inject({
      method: "POST",
      url: "/portal/onlinebusinessbuilder/details",
      ...form({ name: "Sam Owner", business: "Owner Plumbing", business_type: "Plumber", area: "Stockport", phone: "0161 000", services: "Boilers" }, cookie),
    });
    assert.equal(saved.statusCode, 303);
    const after = await one(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(after.business, "Owner Plumbing");
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'info@felixclarke.com' AND subject LIKE '%onboarding form completed%'`));

    // Dashboard: progress in client terms, nothing about suppliers.
    const dash = await app.inject({ method: "GET", url: "/portal/onlinebusinessbuilder/", headers: { cookie } });
    assert.equal(dash.statusCode, 200);
    assert.match(dash.body, /Hello Sam/);
    assert.match(dash.body, /Onboarding call/);
    assert.match(dash.body, /Your website being designed/);
    assert.match(dash.body, /£99\/mo/);
    assert.doesNotMatch(dash.body.replace(/online business builder/gi, "").replace(/calendly/gi, ""), VENDORS);

    // Signed-out visitors are sent to sign in.
    const anon = await app.inject({ method: "GET", url: "/portal/onlinebusinessbuilder/" });
    assert.equal(anon.headers.location, "/portal/onlinebusinessbuilder/login");
  });

  it("lets the client approve a design we post, which completes that step", async () => {
    const cookie = await signUp(app, "onlinebusinessbuilder", "monthly");
    const c = await one(`SELECT * FROM customers`);
    const admin = await adminCookie(app);
    const posted = await app.inject({
      method: "POST",
      url: `/customers/${c.id}/updates`,
      ...form({ title: "Your website preview is ready", body: "Have a look.", link: "https://preview.example.com", approval_step: "design_approved" }, admin),
    });
    assert.equal(posted.statusCode, 303);
    const update = await one(`SELECT * FROM client_updates`);
    assert.ok(await one(`SELECT 1 FROM emails WHERE kind = 'client_update' AND to_address = 'owner@example.co.uk'`));

    const dash = await app.inject({ method: "GET", url: "/portal/onlinebusinessbuilder/", headers: { cookie } });
    assert.match(dash.body, /Ready for you to review|Book your onboarding call/);
    const res = await app.inject({ method: "POST", url: `/portal/onlinebusinessbuilder/updates/${update.id}`, ...form({ decision: "approve" }, cookie) });
    assert.equal(res.statusCode, 303);
    const step = await one(`SELECT * FROM onboarding_steps WHERE customer_id = $1 AND key = 'design_approved'`, [c.id]);
    assert.equal(step.status, "done");
    assert.equal((await one(`SELECT response FROM client_updates WHERE id = $1`, [update.id])).response, "approved");
  });

  it("serves each product's account area on its own domain, and nothing else there", async () => {
    const login = await app.inject({ method: "GET", url: "/login", headers: { host: "account.linkn.co.uk" } });
    assert.equal(login.statusCode, 200);
    assert.match(login.body, /<title>Sign in · Linkn<\/title>/);
    assert.match(login.body, /action="\/login"/);
    const admin = await app.inject({ method: "GET", url: "/inbox", headers: { host: "account.linkn.co.uk" } });
    assert.equal(admin.statusCode, 404);
    const css = await app.inject({ method: "GET", url: "/static/app.css", headers: { host: "account.linkn.co.uk" } });
    assert.equal(css.statusCode, 200);
    // Links for products on their own domain use it; the rest fall back to HQ.
    await handleStripeEvent(checkoutEvent("evt_l", "linkn", "starter"));
    const welcome = await one(`SELECT body_text FROM emails WHERE kind = 'onboarding:welcome'`);
    assert.match(welcome.body_text, /https:\/\/account\.linkn\.co\.uk\/password\//);
  });

  it("keeps clients to their own product and their own data", async () => {
    const cookie = await signUp(app, "linkn", "starter", "evt_l1");
    const other = await app.inject({ method: "GET", url: "/portal/speedtolead/", headers: { cookie } });
    assert.equal(other.statusCode, 303);
    // Another client's report isn't visible.
    await handleStripeEvent(checkoutEvent("evt_l2", "linkn", "starter", "someone@else.co.uk"));
    const theirs = await one(`SELECT id FROM customers WHERE email = 'someone@else.co.uk'`);
    const d = await one(
      `INSERT INTO deliveries (customer_id, product, routine, period, status, content, delivered_at)
       VALUES ($1,'linkn','monthly_report','2026-09','delivered','{"body":"secret"}', now()) RETURNING id`,
      [theirs.id],
    );
    const res = await app.inject({ method: "GET", url: `/portal/linkn/reports/${d.id}`, headers: { cookie } });
    assert.equal(res.statusCode, 404);
  });

  it("signs in with a password, locks after repeated failures, and resets by email", async () => {
    await signUp(app, "speedtolead", "solo");
    const bad = await app.inject({ method: "POST", url: "/portal/speedtolead/login", ...form({ email: "owner@example.co.uk", password: "wrong password" }) });
    assert.equal(bad.statusCode, 401);
    const good = await app.inject({ method: "POST", url: "/portal/speedtolead/login", ...form({ email: "OWNER@example.co.uk", password: "correct horse battery" }) });
    assert.equal(good.statusCode, 303);
    assert.ok(cookieFrom(good).startsWith("client_session="));

    for (let i = 0; i < 8; i++) {
      await app.inject({ method: "POST", url: "/portal/speedtolead/login", ...form({ email: "owner@example.co.uk", password: `nope ${i}` }) });
    }
    const locked = await app.inject({ method: "POST", url: "/portal/speedtolead/login", ...form({ email: "owner@example.co.uk", password: "correct horse battery" }) });
    assert.equal(locked.statusCode, 401);
    assert.match(locked.body, /locked/);

    // Forgotten password: the same answer whether or not the account exists.
    const unknown = await app.inject({ method: "POST", url: "/portal/speedtolead/forgot", ...form({ email: "nobody@example.co.uk" }) });
    const known = await app.inject({ method: "POST", url: "/portal/speedtolead/forgot", ...form({ email: "owner@example.co.uk" }) });
    assert.equal(unknown.statusCode, known.statusCode);
    const email = await one(`SELECT * FROM emails WHERE kind = 'password_reset'`);
    const link = /\/portal\/speedtolead\/password\/[\w-]+/.exec(email.body_text)![0];
    const reset = await app.inject({ method: "POST", url: link, ...form({ password: "a brand new password", confirm: "a brand new password" }) });
    assert.equal(reset.statusCode, 303);
    const reused = await app.inject({ method: "GET", url: link });
    assert.equal(reused.statusCode, 410);
    const signin = await app.inject({ method: "POST", url: "/portal/speedtolead/login", ...form({ email: "owner@example.co.uk", password: "a brand new password" }) });
    assert.equal(signin.statusCode, 303);
  });

  it("shows invoices, upgrades the plan and cancels at the end of the period", async () => {
    const cookie = await signUp(app, "linkn", "starter");
    const c = await one(`SELECT * FROM customers`);
    await handleStripeEvent({
      id: "evt_inv",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1", number: "LNK-0001", status: "paid", total: 19900, created: 1790000000,
          hosted_invoice_url: "https://invoice.stripe.com/i/1", invoice_pdf: "https://pay.stripe.com/invoice/1/pdf",
          parent: { subscription_details: { subscription: "sub_evt_a", metadata: { hq_product: "linkn" } } },
        },
      },
    } as unknown as Stripe.Event);
    const billing = await app.inject({ method: "GET", url: "/portal/linkn/billing", headers: { cookie } });
    assert.match(billing.body, /LNK-0001/);
    assert.match(billing.body, /Download PDF/);
    assert.match(billing.body, /Upgrade to Business/);

    // Stubbed Stripe calls.
    const stripe = getStripe() as any;
    const calls: string[] = [];
    stripe.subscriptions.retrieve = async () => ({ id: "sub_evt_a", metadata: {}, items: { data: [{ id: "si_1", price: { unit_amount: 19900 } }] } });
    stripe.products.create = async () => ({ id: "prod_1" });
    stripe.subscriptions.update = async (_id: string, params: any) => {
      calls.push(JSON.stringify(params));
      return { cancel_at: 1792000000, items: { data: [] } };
    };

    const up = await app.inject({ method: "POST", url: "/portal/linkn/billing/upgrade/business", headers: { cookie } });
    assert.equal(up.statusCode, 303);
    const upgraded = await one(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(upgraded.plan, "business");
    assert.equal(upgraded.amount_pence, 34900);
    assert.match(calls[0]!, /"unit_amount":34900/);
    const extra = await one(`SELECT status FROM onboarding_steps WHERE customer_id = $1 AND key = 'campaign_drafts'`, [c.id]);
    assert.notEqual(extra.status, "skipped");
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'info@felixclarke.com' AND subject LIKE '%upgraded%'`));

    const cancel = await app.inject({ method: "POST", url: "/portal/linkn/billing/cancel", ...form({ reason: "Budget" }, cookie) });
    assert.equal(cancel.statusCode, 303);
    assert.match(calls[1]!, /"cancel_at_period_end":true/);
    const cancelled = await one(`SELECT * FROM customers WHERE id = $1`, [c.id]);
    assert.equal(cancelled.data.cancel_reason, "Budget");
    assert.ok(cancelled.data.cancel_at);
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'info@felixclarke.com' AND kind = 'cancellation'`));
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'owner@example.co.uk' AND kind = 'cancel_confirmed'`));

    const resume = await app.inject({ method: "POST", url: "/portal/linkn/billing/resume", headers: { cookie } });
    assert.equal(resume.statusCode, 303);
    assert.match(calls[2]!, /"cancel_at_period_end":false/);
    assert.equal((await one(`SELECT data FROM customers WHERE id = $1`, [c.id])).data.cancel_at, undefined);
  });

  it("routes support requests to HQ and shows the reply to the client", async () => {
    const cookie = await signUp(app, "emailfirst", "weekly");
    const sent = await app.inject({ method: "POST", url: "/portal/emailfirst/support", ...form({ subject: "Change of audience", message: "Can we target accountants?" }, cookie) });
    assert.equal(sent.statusCode, 303);
    const request = await one(`SELECT * FROM support_requests`);
    assert.ok(await one(`SELECT 1 FROM tasks WHERE id = $1 AND status = 'open'`, [request.task_id]));
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'info@felixclarke.com' AND kind = 'support'`));

    const admin = await adminCookie(app);
    const list = await app.inject({ method: "GET", url: "/support", headers: { cookie: admin } });
    assert.match(list.body, /Change of audience/);
    await app.inject({ method: "POST", url: `/support/${request.id}/reply`, ...form({ reply: "Yes, from Monday." }, admin) });
    const page = await app.inject({ method: "GET", url: "/portal/emailfirst/support", headers: { cookie } });
    assert.match(page.body, /Yes, from Monday\./);
    assert.equal((await one(`SELECT status FROM tasks WHERE id = $1`, [request.task_id])).status, "done");
  });

  it("gives HQ every client account and a read-only view of each dashboard", async () => {
    await signUp(app, "goodquestions", "engagement");
    const c = await one(`SELECT * FROM customers`);
    const admin = await adminCookie(app);
    const clients = await app.inject({ method: "GET", url: "/clients", headers: { cookie: admin } });
    assert.match(clients.body, /owner@example\.co\.uk/);
    const figures = await app.inject({ method: "POST", url: `/customers/${c.id}/metrics`, ...form({ period: "2026-09", m_completions: "42", m_average_score: "" }, admin) });
    assert.equal(figures.statusCode, 303);
    const view = await app.inject({ method: "GET", url: `/customers/${c.id}/dashboard`, headers: { cookie: admin } });
    assert.match(view.body, /read only/);
    assert.match(view.body, />42</);
    const page = await app.inject({ method: "GET", url: `/customers/${c.id}`, headers: { cookie: admin } });
    assert.match(page.body, /See their dashboard/);
    // Client pages aren't reachable without the HQ password.
    const anon = await app.inject({ method: "GET", url: "/clients" });
    assert.equal(anon.statusCode, 302);
  });

  it("locks HQ sign-in after repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/login", ...form({ password: "guess" }) });
    const res = await app.inject({ method: "POST", url: "/login", ...form({ password: "pw" }) });
    assert.equal(res.headers.location, "/login?error=locked");
  });

  it("takes Sbl.so webhook events into the client's figures and the inbox", async () => {
    await handleStripeEvent(checkoutEvent("evt_s", "linkn", "business"));
    const c = await one(`SELECT * FROM customers`);
    const admin = await adminCookie(app);
    await app.inject({ method: "POST", url: `/customers/${c.id}/sbl`, ...form({ campaigns: "camp_1" }, admin) });

    const wrong = await app.inject({ method: "POST", url: "/webhooks/sbl/nope", payload: { event: "message_sent" } });
    assert.equal(wrong.statusCode, 404);
    const post = (body: object) => app.inject({ method: "POST", url: "/webhooks/sbl/sbl-secret-token", payload: body });
    await post({ event: "connection_request_sent", campaign_id: "camp_1" });
    await post({ event: "connection_request_sent", campaign_id: "camp_1" });
    const reply = await post({ event: "prospect_replied", campaign_id: "camp_1", prospect: { name: "Jo Buyer", company: "Acme" }, message: "Sounds interesting" });
    assert.equal(reply.json().matched, true);

    const task = await one(`SELECT * FROM tasks WHERE title LIKE 'LinkedIn reply%'`);
    assert.match(task.body, /Jo Buyer, Acme/);
    const fresh = await one(`SELECT data FROM customers WHERE id = $1`, [c.id]);
    const latest = fresh.data.metrics_history.at(-1);
    assert.equal(latest.values.connection_requests, 2);
    assert.equal(latest.values.replies, 1);

    // An unknown campaign is kept and flagged so it can be linked.
    const other = await post({ event: "message_sent", campaign_id: "camp_x" });
    assert.equal(other.json().matched, false);
    assert.ok(await one(`SELECT 1 FROM tasks WHERE dedupe_key = 'sbl:unlinked:camp_x'`));
  });
});
