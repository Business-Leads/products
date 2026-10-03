import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isProduction } from "../config.js";
import { one, query } from "../db/index.js";
import { syncCheckoutSession } from "../engine/billing.js";
import {
  createSupportRequest,
  customerLabel,
  invoicesFor,
  markCallBooked,
  requestCancellation,
  resumeSubscription,
  respondToUpdate,
  saveIntake,
  upgradeOptions,
  upgradePlan,
} from "../engine/clients.js";
import type { CustomerRow } from "../engine/types.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { clearFailures, passwordProblem, recordFailure, tooManyFailures, verifyPassword } from "../lib/passwords.js";
import { stripeConfigured } from "../lib/stripe.js";
import { errorMessage, fmtDate } from "../lib/util.js";
import { bookingUrl, formatPrice, getPlan, getProduct, type Product } from "../products/index.js";
import { fieldInput } from "../web/fields.js";
import { html, type Raw } from "../web/html.js";
import {
  createSession,
  customersFor,
  endAllSessions,
  endSession,
  ensureClientUser,
  findUser,
  productForHost,
  resetLink,
  SESSION_DAYS,
  setPassword,
  userForLinkToken,
  userForSession,
  type ClientUser,
} from "./accounts.js";
import { accountPage, bookingWidget, calEmbed, widePage, dashboardBody, narrowPage, periodLabel, statusChip, type View } from "./views.js";

const COOKIE = "client_session";
const IP_FAILURE_LIMIT = 20;
const ACCOUNT_FAILURE_LIMIT = 8;

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, string> }>;

function hostOf(req: FastifyRequest): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host;
}

/** Product and link prefix for this request, or undefined if there's no such account area. */
function viewFor(req: Req): View | undefined {
  const product = getProduct(req.params.product ?? "");
  if (!product || product.launched === false) return undefined;
  const onOwnDomain = productForHost(hostOf(req))?.slug === product.slug;
  return { product, base: onOwnDomain ? "" : `/portal/${product.slug}` };
}

function cookiePath(v: View): string {
  return v.base || "/";
}

async function signIn(reply: FastifyReply, v: View, user: ClientUser): Promise<void> {
  const t = await createSession(user.id);
  reply.setCookie(COOKIE, t, {
    path: cookiePath(v),
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: SESSION_DAYS * 86400,
  });
}

/** The client's current subscription: the newest one that's still running, else the newest. */
function currentCustomer(customers: CustomerRow[]): CustomerRow | undefined {
  return customers.find((c) => c.status !== "cancelled") ?? customers[0];
}

/** Where to send a client straight after signing in or signing up. */
function nextStepPath(v: View, c: CustomerRow | undefined): string {
  if (!c || c.status === "cancelled") return `${v.base}/`;
  if (v.product.bookingAfterPurchase && !c.data.call_booked_at) return `${v.base}/book`;
  if (!c.data.intake_completed_at && v.product.intake.length) return `${v.base}/details`;
  return `${v.base}/`;
}

function ipScope(req: FastifyRequest): string {
  return `portal:${req.ip}`;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).type("text/plain").send("Not found");
}

function sendHtml(reply: FastifyReply, page: string, code = 200) {
  return reply.code(code).type("text/html").header("Cache-Control", "no-store").send(page);
}

function loginForm(v: View, opts: { email?: string; error?: string; flash?: string } = {}): Raw {
  return html`<h1>Sign in</h1>
    ${opts.flash ? html`<p class="flash">${opts.flash}</p>` : ""}
    ${opts.error ? html`<p class="flash">${opts.error}</p>` : ""}
    <form method="post" action="${v.base}/login">
      <label for="email">Email</label>
      <input type="email" name="email" id="email" value="${opts.email ?? ""}" autocomplete="username" required>
      <label for="password">Password</label>
      <input type="password" name="password" id="password" autocomplete="current-password" required>
      <p style="margin-top:18px"><button class="primary">Sign in</button></p>
    </form>
    <p class="small"><a href="${v.base}/forgot">Forgotten your password?</a></p>
    <p class="small muted">New here? Your account is created when you sign up to ${v.product.name}.</p>`;
}

function passwordForm(action: string, intro: Raw | string, error?: string, extra: Raw | string = ""): Raw {
  return html`${intro}
    ${error ? html`<p class="flash">${error}</p>` : ""}
    <form method="post" action="${action}">
      ${extra}
      <label for="password">New password</label>
      <input type="password" name="password" id="password" autocomplete="new-password" minlength="10" required>
      <div class="help">At least 10 characters.</div>
      <label for="confirm">Type it again</label>
      <input type="password" name="confirm" id="confirm" autocomplete="new-password" minlength="10" required>
      <p style="margin-top:18px"><button class="primary">Save password</button></p>
    </form>`;
}

interface Authed {
  v: View;
  user: ClientUser;
  customer: CustomerRow;
  customers: CustomerRow[];
}

export async function portalRoutes(app: FastifyInstance) {
  /** Resolve the signed-in client, or send them to sign in. */
  async function authed(req: Req, reply: FastifyReply): Promise<Authed | null> {
    const v = viewFor(req);
    if (!v) {
      notFound(reply);
      return null;
    }
    const user = await userForSession(req.cookies[COOKIE], v.product.slug);
    const customers = user ? await customersFor(user) : [];
    const customer = currentCustomer(customers);
    if (!user || !customer) {
      reply.redirect(`${v.base}/login`, 303);
      return null;
    }
    return { v: { ...v, user, customer }, user, customer, customers };
  }

  const P = "/portal/:product";

  // ---------------------------------------------------------------- sign in

  app.get(`${P}/login`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    if (await userForSession(req.cookies[COOKIE], v.product.slug)) return reply.redirect(`${v.base}/`, 303);
    return sendHtml(reply, narrowPage(v, "Sign in", loginForm(v, { flash: req.query.flash })));
  });

  app.post(`${P}/login`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const email = String(req.body?.email ?? "").trim().slice(0, 320);
    const password = String(req.body?.password ?? "");
    const fail = (error: string) => sendHtml(reply, narrowPage(v, "Sign in", loginForm(v, { email, error })), 401);

    if (await tooManyFailures(ipScope(req), IP_FAILURE_LIMIT)) return fail("Too many attempts. Please wait 15 minutes and try again.");
    const user = email ? await findUser(v.product.slug, email) : undefined;
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return fail("This account is locked for a few minutes after too many attempts. Try again shortly, or reset your password.");
    }
    const ok = await verifyPassword(password, user?.password_hash);
    if (!user || !ok || user.disabled) {
      await recordFailure(ipScope(req));
      if (user) {
        await query(
          `UPDATE client_users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE id = $1`,
          [user.id, ACCOUNT_FAILURE_LIMIT],
        );
      }
      await new Promise((r) => setTimeout(r, 400));
      return fail(user && !user.password_hash
        ? "You haven't set a password yet. Use \"Forgotten your password?\" and we'll email you a link."
        : "That email and password don't match.");
    }
    await clearFailures(ipScope(req));
    await signIn(reply, v, user);
    const customer = currentCustomer(await customersFor(user));
    return reply.redirect(nextStepPath(v, customer), 303);
  });

  app.post(`${P}/logout`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    await endSession(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: cookiePath(v) });
    return reply.redirect(`${v.base}/login`, 303);
  });

  // --------------------------------------------------------- password links

  app.get(`${P}/forgot`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    return sendHtml(reply, narrowPage(v, "Reset your password", html`<h1>Reset your password</h1>
      <p>Enter the email you signed up with and we'll send you a link to choose a new password.</p>
      <form method="post" action="${v.base}/forgot"><label for="email">Email</label>
        <input type="email" name="email" id="email" required>
        <p style="margin-top:18px"><button class="primary">Send link</button></p></form>`));
  });

  app.post(`${P}/forgot`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const email = String(req.body?.email ?? "").trim();
    const scope = `forgot:${req.ip}`;
    if (!(await tooManyFailures(scope, 5))) {
      await recordFailure(scope);
      const user = email ? await findUser(v.product.slug, email) : undefined;
      if (user && !user.disabled) {
        const link = await resetLink(user);
        await queueEmail({
          product: v.product.slug,
          kind: "password_reset",
          to: user.email,
          subject: `Reset your ${v.product.name} password`,
          body: `Hello,\n\nUse this link to choose a new password for your ${v.product.name} account. It works once ` +
            `and expires in two hours:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\nFelix`,
        });
      }
    }
    // The same answer whether or not the account exists.
    return sendHtml(reply, narrowPage(v, "Check your email", html`<h1>Check your email</h1>
      <p>If ${email || "that address"} has a ${v.product.name} account, we've sent a link to reset the password. It can take a minute to arrive.</p>
      <p><a href="${v.base}/login">Back to sign in</a></p>`));
  });

  app.get(`${P}/password/:token`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const user = await userForLinkToken(req.params.token!, v.product.slug);
    if (!user) {
      return sendHtml(reply, narrowPage(v, "Link expired", html`<h1>This link has expired</h1>
        <p>For your security, password links only work once and for a limited time.</p>
        <p><a class="btn primary" href="${v.base}/forgot">Send me a new link</a></p>`), 410);
    }
    return sendHtml(reply, narrowPage(v, "Choose a password", passwordForm(`${v.base}/password/${req.params.token}`,
      html`<h1>${user.password_hash ? "Choose a new password" : "Create your password"}</h1><p class="muted">For ${user.email}</p>`)));
  });

  app.post(`${P}/password/:token`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const user = await userForLinkToken(req.params.token!, v.product.slug);
    if (!user) return reply.redirect(`${v.base}/password/${encodeURIComponent(req.params.token!)}`, 303);
    const problem = passwordProblem(String(req.body?.password ?? ""), String(req.body?.confirm ?? ""));
    if (problem) {
      return sendHtml(reply, narrowPage(v, "Choose a password", passwordForm(`${v.base}/password/${req.params.token}`,
        html`<h1>Choose a password</h1><p class="muted">For ${user.email}</p>`, problem)), 400);
    }
    await setPassword(user.id, String(req.body.password));
    await logEvent({ type: "client.password_set", message: `${user.email} set a password`, product: v.product.slug });
    await signIn(reply, v, user);
    return reply.redirect(nextStepPath(v, currentCustomer(await customersFor(user))), 303);
  });

  // ------------------------------------------------- straight after payment

  async function welcomeCustomer(req: Req, v: View): Promise<CustomerRow | undefined> {
    const sessionId = String(req.query.session_id ?? req.body?.session_id ?? "");
    if (!sessionId) return undefined;
    let customer: CustomerRow | undefined;
    try {
      customer = stripeConfigured()
        ? await syncCheckoutSession(sessionId)
        : await one<CustomerRow>(`SELECT * FROM customers WHERE stripe_checkout_id = $1`, [sessionId]);
    } catch (err) {
      await logEvent({ type: "checkout.sync_failed", level: "warn", message: errorMessage(err), product: v.product.slug });
      customer = await one<CustomerRow>(`SELECT * FROM customers WHERE stripe_checkout_id = $1`, [sessionId]);
    }
    if (!customer || customer.product !== v.product.slug) return undefined;
    return customer;
  }

  /** Creating a password from the checkout return link is allowed for two days after signing up. */
  function welcomeOpen(c: CustomerRow): boolean {
    return Date.now() - new Date(c.created_at).getTime() < 2 * 86_400_000;
  }

  app.get(`${P}/welcome`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const customer = await welcomeCustomer(req, v);
    if (!customer) {
      return sendHtml(reply, narrowPage(v, "Finishing up", html`<meta http-equiv="refresh" content="4">
        <h1>Thank you</h1><p>We're confirming your payment and setting up your account. This page will refresh in a moment.</p>
        <p class="small muted">If nothing happens, check your email: we'll send you a link to your account.</p>`));
    }
    const user = await ensureClientUser(customer);
    const signedIn = await userForSession(req.cookies[COOKIE], v.product.slug);
    if (signedIn?.id === user.id) return reply.redirect(nextStepPath(v, customer), 303);
    if (user.password_hash || !welcomeOpen(customer)) {
      return sendHtml(reply, narrowPage(v, "Sign in", loginForm(v, { email: user.email, flash: "Thank you, your payment has gone through. Sign in to continue." })));
    }
    return sendHtml(reply, narrowPage(v, `Welcome to ${v.product.name}`, passwordForm(`${v.base}/welcome`,
      html`<h1>Welcome to ${v.product.name}</h1>
        <p>Thank you, your payment has gone through. Create a password for your account, where you'll follow progress,
        see your reports and download invoices.</p><p class="muted">Your sign-in email is <strong>${user.email}</strong></p>`,
      undefined, html`<input type="hidden" name="session_id" value="${String(req.query.session_id)}">`)));
  });

  app.post(`${P}/welcome`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const customer = await welcomeCustomer(req, v);
    if (!customer) return reply.redirect(`${v.base}/login`, 303);
    const user = await ensureClientUser(customer);
    if (user.password_hash || !welcomeOpen(customer)) return reply.redirect(`${v.base}/login`, 303);
    const problem = passwordProblem(String(req.body?.password ?? ""), String(req.body?.confirm ?? ""));
    if (problem) {
      return sendHtml(reply, narrowPage(v, "Create your password", passwordForm(`${v.base}/welcome`, html`<h1>Create your password</h1>`, problem,
        html`<input type="hidden" name="session_id" value="${String(req.body.session_id)}">`)), 400);
    }
    await setPassword(user.id, String(req.body.password));
    await logEvent({ type: "client.account_created", message: `${user.email} created their account`, product: v.product.slug, customerId: customer.id });
    await signIn(reply, v, user);
    return reply.redirect(nextStepPath(v, customer), 303);
  });

  // -------------------------------------------------------------- dashboard

  app.get(`${P}`, async (req: Req, reply) => reply.redirect(`/portal/${encodeURIComponent(req.params.product ?? "")}/`, 301));

  app.get(`${P}/`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    return sendHtml(reply, accountPage(a.v, "Dashboard", await dashboardBody(a.v, a.customer), "/", req.query.flash));
  });

  // The product sites' "Book a chat" buttons land here: the booking calendar on the product's own page,
  // then our thank-you page. (Without Cal.com set up, it sends people to the old booking link.)
  app.get(`${P}/chat`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const page = new URL(bookingUrl(v.product, "chat"));
    if (page.hostname !== "cal.com") return reply.redirect(page.toString(), 302);
    const user = await userForSession(req.cookies[COOKIE], v.product.slug);
    const customer = user ? currentCustomer(await customersFor(user)) : undefined;
    if (customer?.name) page.searchParams.set("name", customer.name);
    if (customer?.email) page.searchParams.set("email", customer.email);
    return sendHtml(reply, widePage(v, `Book a chat · ${v.product.name}`, html`
      <h1>Book a chat with Felix</h1>
      <p>Pick a time that suits you for a relaxed 20-minute chat about your business and ${v.product.name}. No preparation needed.</p>
      ${calEmbed(page.toString(), `${v.base}/booked?kind=chat`)}`));
  });

  // The booking pages send people here after they book. Signed-in clients go back to their account.
  app.get(`${P}/booked`, async (req: Req, reply) => {
    const v = viewFor(req);
    if (!v) return notFound(reply);
    const onboarding = req.query.kind === "onboarding";
    const user = await userForSession(req.cookies[COOKIE], v.product.slug);
    if (user && (await customersFor(user)).length) {
      const msg = onboarding ? "Thank you, your onboarding call is booked. You'll find it below, and the details are in your email." : "Thank you, your call is booked. The details are in your email.";
      return reply.redirect(`${v.base}/?flash=${encodeURIComponent(msg)}`, 303);
    }
    const site = v.product.siteUrls[0] ?? "/";
    return sendHtml(reply, narrowPage(v, "Your call is booked", onboarding
      ? html`<h1>Thank you, your call is booked</h1>
        <p>We've emailed you the details, with the link to join. You can also see the call in your account.</p>
        <p><a class="btn primary" href="${v.base}/login">Go to your account</a></p>
        <p class="small muted">Before we speak, it helps if you fill in a few details in your account.</p>`
      : html`<h1>Thank you, your call is booked</h1>
        <p>We've emailed you the details, with the link to join. Felix is looking forward to speaking with you.</p>
        <p>It's a relaxed chat: no preparation needed.</p>
        <p><a class="btn primary" href="${site}">Back to ${v.product.name}</a></p>`));
  });

  // ------------------------------------------------------------- onboarding

  app.get(`${P}/book`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    if (!a.v.product.bookingAfterPurchase) return reply.redirect(`${a.v.base}/`, 303);
    const c = a.customer;
    return sendHtml(reply, accountPage(a.v, "Book your onboarding call", html`
      <h1>Book your onboarding call</h1>
      ${c.data.call_booked_at
        ? html`<div class="flash">Your call is booked. You'll find the details in your email and calendar. Need to change it? Use the link in the confirmation email.</div>`
        : html`<p>Pick a time for a short call with Felix. We'll go through what you need so everything is right from the start.</p>`}
      <div class="panel">${bookingWidget(a.v, c)}</div>
      ${c.data.call_booked_at ? "" : html`<form method="post" action="${a.v.base}/book/done"><button>I've already booked my call</button></form>`}`, "/"));
  });

  app.post(`${P}/book/done`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    await markCallBooked(a.customer);
    if ((req.headers["content-type"] ?? "").includes("application/json")) return { ok: true };
    const fresh = (await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [a.customer.id]))!;
    return reply.redirect(nextStepPath(a.v, fresh), 303);
  });

  app.get(`${P}/details`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const c = a.customer;
    const answers = c.data.intake ?? {};
    return sendHtml(reply, accountPage(a.v, "Your business details", html`
      <div class="panel" style="max-width:720px">
        <h1>Tell us about your business</h1>
        ${c.data.intake_completed_at
          ? html`<p class="flash">Thanks, we have your answers. You can update them here at any time.</p>`
          : html`<p>A few details so we can set everything up. It takes about five minutes.</p>`}
        <form method="post" action="${a.v.base}/details">
          <label for="name">Your name</label>
          <input name="name" id="name" value="${c.name ?? ""}" required>
          ${a.v.product.intake.map(
            (f) => html`<label for="${f.key}">${f.label}${f.required ? "" : html` <span class="muted">(optional)</span>`}</label>
              ${fieldInput(f, answers[f.key] ?? "")}${f.help ? html`<div class="help">${f.help}</div>` : ""}`,
          )}
          <p style="margin-top:20px"><button class="primary">Save</button></p>
        </form>
      </div>`, "/"));
  });

  app.post(`${P}/details`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const missing = await saveIntake(a.customer, req.body ?? {});
    if (missing.length) {
      return sendHtml(reply, accountPage(a.v, "Missing details", html`<div class="panel"><p>Please fill in: ${missing.join(", ")}.</p>
        <p><a href="${a.v.base}/details">Go back</a></p></div>`), 400);
    }
    return reply.redirect(`${a.v.base}/?flash=${encodeURIComponent("Thank you, that's everything we need. We'll keep you posted here as each part is ready.")}`, 303);
  });

  // ------------------------------------------------------ reports & updates

  app.get(`${P}/reports/:id`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const d = await one(`SELECT * FROM deliveries WHERE id = $1 AND status = 'delivered'`, [req.params.id]);
    const label = d && a.v.product.portal.routines[d.routine];
    if (!d || !label || !a.customers.some((c) => c.id === d.customer_id)) return notFound(reply);
    const text = d.content?.body ?? d.content?.post ?? "";
    return sendHtml(reply, accountPage(a.v, label, html`
      <p><a href="${a.v.base}/">← Dashboard</a></p>
      <div class="panel" style="max-width:760px"><h1>${label}</h1><p class="muted">${periodLabel(d.period)} · delivered ${fmtDate(d.delivered_at)}</p>
        ${d.content?.subject ? html`<h2>${d.content.subject}</h2>` : ""}
        <div style="white-space:pre-wrap">${text}</div></div>`, "/"));
  });

  app.get(`${P}/updates/:id`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const u = await one(`SELECT * FROM client_updates WHERE id = $1`, [req.params.id]);
    if (!u || !a.customers.some((c) => c.id === u.customer_id)) return notFound(reply);
    return sendHtml(reply, accountPage(a.v, u.title, html`
      <p><a href="${a.v.base}/">← Dashboard</a></p>
      <div class="panel" style="max-width:760px"><h1>${u.title}</h1><p class="muted">${fmtDate(u.created_at)}</p>
        ${u.body ? html`<div style="white-space:pre-wrap">${u.body}</div>` : ""}
        ${u.link ? html`<p><a class="btn" href="${u.link}" target="_blank" rel="noopener">Open</a></p>` : ""}
        ${u.approval_step
          ? u.response
            ? html`<p class="flash">${u.response === "approved" ? "You approved this" : "You asked for changes"} on ${fmtDate(u.responded_at)}.${u.response_note ? ` “${u.response_note}”` : ""}</p>`
            : html`<form method="post" action="${a.v.base}/updates/${u.id}">
                <label for="note">Comments <span class="muted">(needed if you'd like changes)</span></label>
                <textarea name="note" id="note"></textarea>
                <p class="row" style="margin-top:14px"><button class="primary" name="decision" value="approve">Approve</button>
                  <button name="decision" value="changes">Ask for changes</button></p></form>`
          : ""}
      </div>`, "/"));
  });

  app.post(`${P}/updates/:id`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const u = await one(`SELECT * FROM client_updates WHERE id = $1`, [req.params.id]);
    const owner = u && a.customers.find((c) => c.id === u.customer_id);
    if (!owner) return notFound(reply);
    const approved = req.body?.decision === "approve";
    const note = String(req.body?.note ?? "").trim();
    if (!approved && !note) return reply.redirect(`${a.v.base}/updates/${u.id}`, 303);
    await respondToUpdate(owner, u.id, approved, note);
    return reply.redirect(`${a.v.base}/?flash=${encodeURIComponent(approved ? "Thank you, approved." : "Thanks, we'll make those changes and let you know.")}`, 303);
  });

  // ---------------------------------------------------------------- billing

  app.get(`${P}/billing`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const c = a.customer;
    const plan = getPlan(a.v.product, c.plan);
    const invoices = (await Promise.all(a.customers.map(invoicesFor))).flat()
      .filter((i, n, all) => all.findIndex((j) => j.id === i.id) === n)
      .sort((x, y) => new Date(y.issued_at).getTime() - new Date(x.issued_at).getTime());
    const unpaid = invoices.find((i) => i.status === "open" && i.hosted_url);
    const upgrades = c.status === "cancelled" || c.data.cancel_at ? [] : upgradeOptions(c);
    return sendHtml(reply, accountPage(a.v, "Billing", html`
      <h1>Billing</h1>
      ${unpaid ? html`<div class="panel next"><h2>Payment due</h2><p>Invoice ${unpaid.number ?? ""} for ${formatPrice(unpaid.amount_pence)} is unpaid.</p>
        <a class="btn primary" href="${unpaid.hosted_url}">Pay now</a></div>` : ""}
      <div class="grid-2">
        <div class="panel"><h2>Your plan</h2>
          <table><tr><td class="muted">Plan</td><td>${plan?.name ?? c.plan}</td></tr>
            <tr><td class="muted">Price</td><td>${c.amount_pence ? formatPrice(c.amount_pence, c.interval) : "As agreed"}</td></tr>
            <tr><td class="muted">Status</td><td>${statusChip(c.status)}</td></tr>
            <tr><td class="muted">Member since</td><td>${fmtDate(c.created_at)}</td></tr></table>
          ${plan?.summary ? html`<p class="small muted">${plan.summary}</p>` : ""}
        </div>
        <div class="panel"><h2>${upgrades.length ? "Upgrade" : "Your subscription"}</h2>
          ${upgrades.length
            ? upgrades.map((p) => html`<div class="feed-item"><div class="spread"><strong>${p.name}</strong><span>${formatPrice(p.amountPence, p.interval)}</span></div>
                <div class="small muted">${p.summary}</div><p><a class="btn" href="${a.v.base}/billing/upgrade/${p.id}">Upgrade to ${p.name}</a></p></div>`)
            : html`<p class="muted">${c.status === "cancelled" ? "Your subscription has ended." : "You're on our top plan for this service."}</p>`}
        </div>
      </div>
      <div class="panel"><h2>Invoices</h2>
        ${invoices.length
          ? html`<table><tr><th>Date</th><th>Invoice</th><th class="num">Amount</th><th>Status</th><th></th></tr>
            ${invoices.map((i) => html`<tr><td>${fmtDate(i.issued_at)}</td><td>${i.number ?? ""}</td><td class="num">${formatPrice(i.amount_pence)}</td>
              <td>${i.status === "paid" ? html`<span class="chip ok">Paid</span>` : i.status === "open" ? html`<span class="chip warn">Due</span>` : html`<span class="chip">${i.status}</span>`}</td>
              <td class="row">${i.pdf_url ? html`<a href="${i.pdf_url}">Download PDF</a>` : ""}${i.hosted_url ? html`<a href="${i.hosted_url}" target="_blank" rel="noopener">View</a>` : ""}</td></tr>`)}</table>`
          : html`<p class="muted">Your invoices will appear here. They're also emailed to you when you pay.</p>`}
      </div>
      ${c.status !== "cancelled"
        ? c.data.cancel_at || c.data.cancel_requested_at
          ? html`<div class="panel"><h2>Cancellation</h2><p>Your subscription ${c.data.cancel_at ? html`ends on <strong>${fmtDate(c.data.cancel_at)}</strong>` : "is being cancelled"}.</p>
              <form method="post" action="${a.v.base}/billing/resume"><button class="primary">Keep my subscription</button></form></div>`
          : html`<div class="panel"><h2>Cancel</h2><p class="small muted">You can cancel at any time. The service carries on until the end of the period you've paid for.</p>
              <a class="btn" href="${a.v.base}/billing/cancel">Cancel my subscription</a></div>`
        : ""}`, "/billing", req.query.flash));
  });

  app.get(`${P}/billing/upgrade/:plan`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const plan = upgradeOptions(a.customer).find((p) => p.id === req.params.plan);
    if (!plan) return reply.redirect(`${a.v.base}/billing`, 303);
    const current = getPlan(a.v.product, a.customer.plan);
    return sendHtml(reply, accountPage(a.v, `Upgrade to ${plan.name}`, html`<div class="panel" style="max-width:600px">
      <h1>Upgrade to ${plan.name}</h1><p>${plan.summary}</p>
      <table><tr><td class="muted">Now</td><td>${current?.name} · ${current ? formatPrice(current.amountPence, current.interval) : ""}</td></tr>
        <tr><td class="muted">New</td><td><strong>${plan.name} · ${formatPrice(plan.amountPence, plan.interval)}</strong></td></tr></table>
      <p class="small muted">The upgrade starts straight away. For the rest of this billing period you pay only the difference, added to your next invoice, using the card you already pay with.</p>
      <form method="post" action="${a.v.base}/billing/upgrade/${plan.id}" class="row"><button class="primary">Confirm upgrade</button><a href="${a.v.base}/billing">Not now</a></form>
    </div>`, "/billing"));
  });

  app.post(`${P}/billing/upgrade/:plan`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    try {
      await upgradePlan(a.customer, req.params.plan!);
    } catch (err) {
      await logEvent({ type: "upgrade.failed", level: "error", message: `${customerLabel(a.customer)}: ${errorMessage(err)}`, product: a.v.product.slug, customerId: a.customer.id });
      return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent("Sorry, we couldn't change your plan just now. Please try again, or contact us.")}`, 303);
    }
    return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent("Done. You're now on the new plan.")}`, 303);
  });

  app.get(`${P}/billing/cancel`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    return sendHtml(reply, accountPage(a.v, "Cancel", html`<div class="panel" style="max-width:600px">
      <h1>Cancel your subscription</h1>
      <p>Your ${a.v.product.name} service carries on until the end of the period you've paid for, and you won't be charged again.</p>
      <form method="post" action="${a.v.base}/billing/cancel">
        <label for="reason">Would you tell us why? <span class="muted">(optional)</span></label>
        <textarea name="reason" id="reason"></textarea>
        <p class="row" style="margin-top:14px"><button class="danger">Cancel my subscription</button><a href="${a.v.base}/billing">Keep it</a></p>
      </form></div>`, "/billing"));
  });

  app.post(`${P}/billing/cancel`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    if (a.customer.status === "cancelled" || a.customer.data.cancel_requested_at) return reply.redirect(`${a.v.base}/billing`, 303);
    try {
      const endsAt = await requestCancellation(a.customer, String(req.body?.reason ?? "").trim());
      return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent(endsAt ? `Cancelled. Everything carries on until ${fmtDate(endsAt)}.` : "Your cancellation is in. We'll confirm by email.")}`, 303);
    } catch (err) {
      await logEvent({ type: "cancel.failed", level: "error", message: `${customerLabel(a.customer)}: ${errorMessage(err)}`, product: a.v.product.slug, customerId: a.customer.id });
      return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent("Sorry, something went wrong. Please try again, or contact us and we'll do it for you.")}`, 303);
    }
  });

  app.post(`${P}/billing/resume`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    try {
      await resumeSubscription(a.customer);
    } catch (err) {
      await logEvent({ type: "resume.failed", level: "error", message: `${customerLabel(a.customer)}: ${errorMessage(err)}`, product: a.v.product.slug, customerId: a.customer.id });
      return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent("Sorry, something went wrong. Please contact us.")}`, 303);
    }
    return reply.redirect(`${a.v.base}/billing?flash=${encodeURIComponent("Great, your subscription carries on as normal.")}`, 303);
  });

  // ---------------------------------------------------------------- support

  app.get(`${P}/support`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const requests = await query(
      `SELECT * FROM support_requests WHERE customer_id = ANY($1::bigint[]) ORDER BY created_at DESC LIMIT 50`,
      [a.customers.map((c) => c.id)],
    );
    return sendHtml(reply, accountPage(a.v, "Contact us", html`
      <h1>Contact us</h1>
      <div class="grid-2">
        <div class="panel"><h2>Send us a message</h2>
          <form method="post" action="${a.v.base}/support">
            <label for="subject">Subject</label><input name="subject" id="subject" maxlength="200" required>
            <label for="message">Message</label><textarea name="message" id="message" required></textarea>
            <p style="margin-top:14px"><button class="primary">Send</button></p>
          </form>
          <p class="small muted">We reply within one working day, by email and here. Prefer to talk? <a href="${bookingUrl(a.v.product)}">Book a call</a>.</p>
        </div>
        <div class="panel"><h2>Your messages</h2>
          ${requests.length
            ? requests.map((r) => html`<div class="feed-item"><div class="spread"><strong>${r.subject}</strong><span class="small muted">${fmtDate(r.created_at)}</span></div>
                <div class="small" style="white-space:pre-wrap">${r.message}</div>
                ${r.reply ? html`<div class="pre small" style="margin-top:8px"><strong>Our reply (${fmtDate(r.replied_at)}):</strong>\n${r.reply}</div>` : html`<div class="small muted">We'll reply soon.</div>`}</div>`)
            : html`<p class="muted">No messages yet.</p>`}
        </div>
      </div>`, "/support", req.query.flash));
  });

  app.post(`${P}/support`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const subject = String(req.body?.subject ?? "").trim();
    const message = String(req.body?.message ?? "").trim();
    if (!subject || !message) return reply.redirect(`${a.v.base}/support`, 303);
    const scope = `support:${a.user.id}`;
    if (await tooManyFailures(scope, 10)) {
      return reply.redirect(`${a.v.base}/support?flash=${encodeURIComponent("You've sent a lot of messages; please wait a little before sending more.")}`, 303);
    }
    await recordFailure(scope);
    await createSupportRequest(a.customer, subject, message);
    return reply.redirect(`${a.v.base}/support?flash=${encodeURIComponent("Thanks, we've got your message and will reply soon.")}`, 303);
  });

  // ---------------------------------------------------------------- account

  app.get(`${P}/account`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const c = a.customer;
    return sendHtml(reply, accountPage(a.v, "Account", html`
      <h1>Account</h1>
      <div class="grid-2">
        <div class="panel"><h2>Your details</h2>
          <table><tr><td class="muted">Sign-in email</td><td>${a.user.email}</td></tr>
            <tr><td class="muted">Name</td><td>${c.name ?? ""}</td></tr>
            <tr><td class="muted">Business</td><td>${c.business ?? ""}</td></tr>
            <tr><td class="muted">Phone</td><td>${c.phone ?? ""}</td></tr></table>
          <p class="small"><a href="${a.v.base}/details">Update your business details</a> · To change your sign-in email, <a href="${a.v.base}/support">contact us</a>.</p>
        </div>
        <div class="panel"><h2>Change password</h2>
          <form method="post" action="${a.v.base}/account/password">
            <label for="current">Current password</label><input type="password" name="current" id="current" autocomplete="current-password" required>
            <label for="password">New password</label><input type="password" name="password" id="password" autocomplete="new-password" minlength="10" required>
            <label for="confirm">Type it again</label><input type="password" name="confirm" id="confirm" autocomplete="new-password" minlength="10" required>
            <p style="margin-top:14px"><button class="primary">Change password</button></p>
          </form>
          <form method="post" action="${a.v.base}/account/signout-all"><button class="small">Sign out on all devices</button></form>
        </div>
      </div>`, "/account", req.query.flash));
  });

  app.post(`${P}/account/password`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    const back = (msg: string) => reply.redirect(`${a.v.base}/account?flash=${encodeURIComponent(msg)}`, 303);
    if (!(await verifyPassword(String(req.body?.current ?? ""), a.user.password_hash))) return back("Your current password isn't right.");
    const problem = passwordProblem(String(req.body?.password ?? ""), String(req.body?.confirm ?? ""));
    if (problem) return back(problem);
    await setPassword(a.user.id, String(req.body.password));
    await signIn(reply, a.v, a.user);
    return back("Password changed. You've been signed out everywhere else.");
  });

  app.post(`${P}/account/signout-all`, async (req: Req, reply) => {
    const a = await authed(req, reply);
    if (!a) return;
    await endAllSessions(a.user.id);
    reply.clearCookie(COOKIE, { path: cookiePath(a.v) });
    return reply.redirect(`${a.v.base}/login?flash=${encodeURIComponent("You've been signed out on all devices.")}`, 303);
  });
}

/** Map requests on a product's own account domain onto its /portal/<slug> routes. */
export function rewritePortalUrl(host: string | undefined, url: string): string {
  const product: Product | undefined = productForHost(host);
  // Checkout links and enquiry forms also work on the product's own domain.
  const shared = ["/static/", "/webhooks/", "/buy/", "/api/leads/"];
  if (!product || url === "/healthz" || shared.some((p) => url.startsWith(p))) return url;
  return `/portal/${product.slug}${url.startsWith("/") ? url : `/${url}`}`;
}
