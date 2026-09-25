import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, query } from "../db/index.js";
import { handleStripeEvent } from "../engine/billing.js";
import { createLead } from "../engine/leads.js";
import type { CustomerRow } from "../engine/types.js";
import { advanceOnboarding } from "../engine/workflow.js";
import { logEvent } from "../lib/events.js";
import { createCheckout, stripeConfigured, verifyWebhook } from "../lib/stripe.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage } from "../lib/util.js";
import { getPlan, getProduct, products } from "../products/index.js";
import type { Field } from "../products/types.js";
import { html } from "./html.js";
import { publicPage } from "./layout.js";

/** Origins allowed to post enquiries: every product site plus any extra configured domains. */
function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const p of products) for (const u of p.siteUrls) origins.add(new URL(u).origin);
  for (const o of (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) origins.add(o);
  return origins;
}

function cors(req: FastifyRequest, reply: FastifyReply) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  }
}

// Simple per-IP rate limit for the public enquiry endpoint.
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 20;
}

const LEAD_FIELDS = ["name", "email", "phone", "business", "website", "town", "message"] as const;

function fieldInput(f: Field, value: string) {
  const common = { name: f.key, id: f.key };
  if (f.type === "textarea") {
    return html`<textarea name="${common.name}" id="${common.id}" ${f.required ? "required" : ""}>${value}</textarea>`;
  }
  if (f.type === "select") {
    return html`<select name="${f.key}" id="${f.key}" ${f.required ? "required" : ""}>
      <option value="">Choose…</option>
      ${(f.options ?? []).map((o) => html`<option ${o === value ? "selected" : ""}>${o}</option>`)}
    </select>`;
  }
  return html`<input type="${f.type}" name="${f.key}" id="${f.key}" value="${value}" ${f.required ? "required" : ""}>`;
}

export async function publicRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => {
    await query("SELECT 1");
    return { ok: true };
  });

  // ------------------------------------------------------------ enquiries

  app.options("/api/leads/:product", async (req, reply) => {
    cors(req, reply);
    return reply.code(204).send();
  });

  app.post<{ Params: { product: string }; Body: Record<string, string> }>("/api/leads/:product", async (req, reply) => {
    cors(req, reply);
    const product = getProduct(req.params.product);
    if (!product) return reply.code(404).send({ ok: false, error: "Unknown product" });
    const body = (req.body ?? {}) as Record<string, string>;
    const wantsJson = (req.headers["content-type"] ?? "").includes("application/json");

    // Honeypot fields used by the product sites; bots fill them in, people don't.
    if (body["company-name"] || body._gotcha) return wantsJson ? { ok: true } : reply.redirect(body._redirect || "/");
    if (rateLimited(req.ip)) return reply.code(429).send({ ok: false, error: "Too many requests" });
    if (!body.email && !body.phone) return reply.code(400).send({ ok: false, error: "An email or phone number is needed" });

    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!(LEAD_FIELDS as readonly string[]).includes(k) && !k.startsWith("_") && typeof v === "string") data[k] = v;
    }
    const lead = await createLead({
      product: product.slug,
      name: body.name,
      email: body.email,
      phone: body.phone,
      business: body.business ?? body.company,
      website: body.website,
      town: body.town,
      message: body.message,
      source: body._source || "website",
      data,
    });
    if (wantsJson) return { ok: true, id: lead.id };
    if (body._redirect) return reply.redirect(body._redirect, 303);
    return reply.type("text/html").send(
      publicPage(
        `Thank you · ${product.name}`,
        html`<div class="panel"><h1>Thank you</h1><p>We've got your details and will reply by email shortly.</p>
        <p><a href="${product.siteUrls[0]}">Back to ${product.name}</a></p></div>`,
      ),
    );
  });

  // ------------------------------------------------------------- checkout

  app.get<{ Params: { product: string; plan: string }; Querystring: { lead?: string; email?: string; addons?: string } }>(
    "/buy/:product/:plan",
    async (req, reply) => {
      const product = getProduct(req.params.product);
      const plan = product && getPlan(product, req.params.plan);
      if (!product || !plan) return reply.code(404).send("Not found");
      if (product.quoted) return reply.redirect(product.bookingUrl);
      if (rateLimited(`buy:${req.ip}`)) return reply.code(429).send("Too many requests. Please try again later.");
      if (!stripeConfigured()) {
        await createTask({
          kind: "alert",
          priority: 1,
          title: "Someone tried to buy but Stripe isn't connected",
          body: `${product.name} ${plan.name}. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.`,
          dedupeKey: "alert:stripe-not-configured",
        });
        return reply.type("text/html").send(
          publicPage(
            product.name,
            html`<div class="panel"><h1>Almost there</h1><p>Online sign-up is being switched on. Please book a
            short call instead and we'll set you up: <a href="${product.bookingUrl}">book a call</a>.</p></div>`,
          ),
        );
      }
      try {
        const url = await createCheckout(product, plan, {
          leadId: req.query.lead,
          email: req.query.email,
          addOns: (req.query.addons ?? "").split(",").filter(Boolean),
        });
        return reply.redirect(url, 303);
      } catch (err) {
        await logEvent({ type: "checkout.error", level: "error", message: errorMessage(err), product: product.slug });
        return reply.code(502).type("text/html").send(
          publicPage(
            product.name,
            html`<div class="panel"><h1>Sorry, something went wrong</h1><p>Please try again in a minute, or
            <a href="${product.bookingUrl}">book a call</a> and we'll set you up.</p></div>`,
          ),
        );
      }
    },
  );

  app.get<{ Querystring: { session_id?: string } }>("/welcome", async (req, reply) => {
    const customer = req.query.session_id
      ? await one<CustomerRow>(`SELECT * FROM customers WHERE stripe_checkout_id = $1`, [req.query.session_id])
      : undefined;
    const product = customer ? getProduct(customer.product) : undefined;
    const body = customer && product
      ? html`<div class="panel"><h1>Welcome to ${product.name}</h1>
          <p>Thank you. The next step is a short form so we can set everything up for you.</p>
          <p><a class="btn primary" href="/start/${customer.intake_token}">Tell us about your business</a></p>
          <p class="muted small">We've also emailed you this link.</p></div>`
      : html`<div class="panel"><h1>Thank you</h1><p>Your payment has gone through. We've emailed you a short
          setup form; it can take a minute to arrive.</p></div>`;
    return reply.type("text/html").send(publicPage("Welcome", body));
  });

  // --------------------------------------------------------------- intake

  app.get<{ Params: { token: string } }>("/start/:token", async (req, reply) => {
    const customer = await one<CustomerRow>(`SELECT * FROM customers WHERE intake_token = $1`, [req.params.token]);
    const product = customer && getProduct(customer.product);
    if (!customer || !product) return reply.code(404).send("This link isn't valid.");
    const answers = customer.data.intake ?? {};
    const done = Boolean(customer.data.intake_completed_at);
    return reply.type("text/html").send(
      publicPage(
        `Set up ${product.name}`,
        html`<div class="panel">
          <h1>Set up ${product.name}</h1>
          ${done
            ? html`<p class="flash">Thanks, we have your answers. You can update them below at any time.</p>`
            : html`<p>A few details so we can set everything up. It takes about five minutes.</p>`}
          <form method="post">
            <label for="name">Your name</label>
            <input name="name" id="name" value="${customer.name ?? ""}" required>
            ${product.intake.map(
              (f) => html`<label for="${f.key}">${f.label}${f.required ? "" : html` <span class="muted">(optional)</span>`}</label>
                ${fieldInput(f, answers[f.key] ?? "")}
                ${f.help ? html`<div class="help">${f.help}</div>` : ""}`,
            )}
            <p style="margin-top:20px"><button class="primary">Send</button></p>
          </form>
          <p class="muted small">${product.entity}</p>
        </div>`,
      ),
    );
  });

  app.post<{ Params: { token: string }; Body: Record<string, string> }>("/start/:token", async (req, reply) => {
    const customer = await one<CustomerRow>(`SELECT * FROM customers WHERE intake_token = $1`, [req.params.token]);
    const product = customer && getProduct(customer.product);
    if (!customer || !product) return reply.code(404).send("This link isn't valid.");
    const body = req.body ?? {};
    const answers: Record<string, string> = {};
    for (const f of product.intake) answers[f.key] = String(body[f.key] ?? "").trim().slice(0, 5000);
    const missing = product.intake.filter((f) => f.required && !answers[f.key]);
    if (missing.length) {
      return reply.code(400).type("text/html").send(
        publicPage("Missing details", html`<div class="panel"><p>Please fill in: ${missing.map((m) => m.label).join(", ")}.</p>
          <p><a href="/start/${req.params.token}">Go back</a></p></div>`),
      );
    }
    const first = !customer.data.intake_completed_at;
    await query(
      `UPDATE customers SET name = COALESCE(NULLIF($2,''), name), business = COALESCE(NULLIF($3,''), business),
         data = data || jsonb_build_object('intake', $4::jsonb, 'intake_completed_at', to_jsonb(now())), updated_at = now()
       WHERE id = $1`,
      [customer.id, String(body.name ?? "").trim(), answers.business || answers.company || answers.organisation || "", JSON.stringify(answers)],
    );
    await logEvent({
      type: first ? "intake.completed" : "intake.updated",
      message: `${answers.business || answers.company || customer.email} ${first ? "completed" : "updated"} the intake form`,
      product: product.slug,
      customerId: customer.id,
    });
    await advanceOnboarding(customer.id);
    return reply.type("text/html").send(
      publicPage(
        "Thank you",
        html`<div class="panel"><h1>Thank you</h1><p>That's everything we need to get started. We'll be in touch
          by email as each part is ready.</p></div>`,
      ),
    );
  });

  // --------------------------------------------------------------- Stripe

  app.post("/webhooks/stripe", async (req, reply) => {
    // server.ts keeps this route's body as a Buffer so the signature can be verified.
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") return reply.code(400).send("Missing signature");
    let event;
    try {
      event = verifyWebhook(req.body as Buffer, signature);
    } catch (err) {
      return reply.code(400).send(`Webhook error: ${errorMessage(err)}`);
    }
    try {
      await handleStripeEvent(event);
    } catch (err) {
      await logEvent({ type: "stripe.error", level: "error", message: `${event.type}: ${errorMessage(err)}` });
      return reply.code(500).send("Handler failed");
    }
    return { received: true };
  });

}
