import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertProductionConfig, config } from "../config.js";
import { one, query } from "../db/index.js";
import { decideTask, type Decision } from "../engine/actions.js";
import type { CustomerRow } from "../engine/types.js";
import { advanceOnboarding, instantiateSteps, retryDelivery, retryStep, setCustomerStatus, skipStep } from "../engine/workflow.js";
import { runJob } from "../engine/scheduler.js";
import { jobs } from "../jobs/index.js";
import { integrations } from "../integrations/index.js";
import { logEvent } from "../lib/events.js";
import { autonomyFor, getSetting, setSetting } from "../lib/settings.js";
import { ago, fmtDate, token } from "../lib/util.js";
import { formatPrice, getPlan, getProduct, monthlyValuePence, products, requireProduct } from "../products/index.js";
import { requireAuth } from "./auth.js";
import { html, type Raw } from "./html.js";
import { chip, empty, page } from "./layout.js";

async function navCounts() {
  const r = await one(`SELECT count(*)::int AS n FROM tasks WHERE status = 'open'`);
  return { inbox: r?.n ?? 0 };
}

async function send(reply: FastifyReply, req: FastifyRequest, title: string, body: Raw, active: string) {
  const flash = (req.query as Record<string, string> | undefined)?.flash;
  return reply.type("text/html").send(page(title, body, { active, counts: await navCounts(), flash }));
}

function back(reply: FastifyReply, to: string, flash?: string) {
  const sep = to.includes("?") ? "&" : "?";
  return reply.redirect(flash ? `${to}${sep}flash=${encodeURIComponent(flash)}` : to, 303);
}

function productName(slug: string | null | undefined): string {
  return (slug && getProduct(slug)?.name) || "General";
}

async function mrrByProduct(): Promise<Map<string, number>> {
  const rows = await query(
    `SELECT product, amount_pence, interval FROM customers WHERE status IN ('active','onboarding','past_due')`,
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.product, (m.get(r.product) ?? 0) + monthlyValuePence(r.amount_pence, r.interval));
  return m;
}

async function siteStatus(): Promise<Map<string, { ok: boolean; at: Date; url: string }[]>> {
  const rows = await query(`SELECT DISTINCT ON (url) target, url, ok, checked_at FROM health_checks ORDER BY url, checked_at DESC`);
  const m = new Map<string, { ok: boolean; at: Date; url: string }[]>();
  for (const r of rows) m.set(r.target, [...(m.get(r.target) ?? []), { ok: r.ok, at: r.checked_at, url: r.url }]);
  return m;
}

// ---------------------------------------------------------------- task card

async function taskCard(t: any): Promise<Raw> {
  const p = t.payload ?? {};
  let form: Raw;
  if (t.action === "send_email" && p.emailId) {
    const email = await one(`SELECT * FROM emails WHERE id = $1`, [p.emailId]);
    const bodyText: string = email?.body_text ?? "";
    const footerAt = bodyText.indexOf("\n\n--\n");
    const inbound = p.inboundId ? await one(`SELECT * FROM inbound_emails WHERE id = $1`, [p.inboundId]) : undefined;
    form = html`<form method="post" action="/tasks/${t.id}">
      ${inbound ? html`<div class="small muted">Their message${inbound.summary ? html` · ${inbound.summary}` : ""}</div>
        <div class="pre small" style="margin-bottom:10px">${inbound.body_text}</div>` : ""}
      <div class="small muted">To ${email?.to_address} · from ${email?.from_address}</div>
      <label>Subject</label><input name="subject" value="${email?.subject ?? ""}">
      <label>Email</label><textarea name="body" style="min-height:220px">${footerAt >= 0 ? bodyText.slice(0, footerAt) : bodyText}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="approve">Approve and send</button>
        <input name="note" placeholder="Reason, if rejecting" style="max-width:260px">
        <button name="decision" value="reject" class="danger">Reject</button>
      </div></form>`;
  } else if (t.action === "approve_review") {
    form = html`<form method="post" action="/tasks/${t.id}">
      <textarea name="body" style="min-height:260px">${t.body}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="approve">Approve</button>
        <input name="note" placeholder="Reason, if rejecting" style="max-width:260px">
        <button name="decision" value="reject" class="danger">Reject</button>
      </div></form>`;
  } else if (t.kind === "manual") {
    form = html`<form method="post" action="/tasks/${t.id}">
      <div class="pre">${t.body}</div>
      ${p.inputLabel ? html`<label>${p.inputLabel}</label><textarea name="input" required></textarea>` : ""}
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="done">Mark done</button>
        <button name="decision" value="dismiss">Dismiss</button>
      </div></form>`;
  } else {
    form = html`<form method="post" action="/tasks/${t.id}">
      <div class="pre">${t.body}</div>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="done">Resolved</button>
        <button name="decision" value="dismiss">Dismiss</button>
      </div></form>`;
  }
  const who = t.customer_id
    ? html` · <a href="/customers/${t.customer_id}">customer</a>`
    : t.lead_id
      ? html` · <a href="/leads/${t.lead_id}">lead</a>`
      : "";
  return html`<div class="panel task ${t.kind} p${t.priority}">
    <div class="spread"><h3>${t.title}</h3>
      <span class="row">${chip(t.kind)}${t.priority === 1 ? html`<span class="chip bad">urgent</span>` : ""}</span></div>
    <div class="small muted" style="margin-bottom:8px">${productName(t.product)}${who} · ${ago(t.created_at)}${
      t.due_at ? html` · due ${fmtDate(t.due_at)}` : ""
    }</div>
    ${form}
  </div>`;
}

// ---------------------------------------------------------------- routes

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Overview ---------------------------------------------------------------
  app.get("/", async (req, reply) => {
    const mrr = await mrrByProduct();
    const totalMrr = [...mrr.values()].reduce((a, b) => a + b, 0);
    const counts = await query(
      `SELECT product, count(*) FILTER (WHERE status IN ('active','past_due'))::int AS live,
              count(*) FILTER (WHERE status = 'onboarding')::int AS onboarding,
              count(*) FILTER (WHERE status IN ('past_due','paused'))::int AS trouble
       FROM customers GROUP BY product`,
    );
    const leads = await query(
      `SELECT product, count(*)::int AS n FROM leads WHERE created_at > now() - interval '7 days' GROUP BY product`,
    );
    const tasks = await query(`SELECT product, count(*)::int AS n FROM tasks WHERE status = 'open' GROUP BY product`);
    const sites = await siteStatus();
    const by = (rows: any[], slug: string, key = "n") => rows.find((r) => r.product === slug)?.[key] ?? 0;
    const allSites = [...sites.values()].flat();
    const urgent = await query(`SELECT * FROM tasks WHERE status = 'open' ORDER BY priority, created_at LIMIT 5`);
    const events = await query(`SELECT * FROM events ORDER BY at DESC LIMIT 12`);
    const openTotal = tasks.reduce((s, r) => s + r.n, 0);
    const warnings = assertProductionConfig();
    const disconnected = integrations.filter((i) => !i.configured());

    const body = html`
      <div class="spread"><h1>Overview</h1><span class="muted small">${fmtDate(new Date(), true)}</span></div>
      ${warnings.length ? html`<div class="flash">Setup needed: ${warnings.join("; ")}.</div>` : ""}
      <div class="grid">
        <div class="stat"><div class="label">Monthly recurring revenue</div><div class="value">${formatPrice(totalMrr)}</div></div>
        <div class="stat"><div class="label">Live customers</div><div class="value">${counts.reduce((s, r) => s + r.live, 0)}</div>
          <div class="sub">${counts.reduce((s, r) => s + r.onboarding, 0)} onboarding</div></div>
        <div class="stat"><div class="label">Enquiries, last 7 days</div><div class="value">${leads.reduce((s, r) => s + r.n, 0)}</div></div>
        <div class="stat"><div class="label">Waiting on you</div><div class="value">${openTotal}</div>
          <div class="sub"><a href="/inbox">Open inbox</a></div></div>
        <div class="stat"><div class="label">Sites up</div><div class="value">${allSites.filter((s) => s.ok).length}/${allSites.length}</div></div>
      </div>

      <div class="panel"><h2>Products</h2>
        <table><tr><th>Product</th><th class="num">Live</th><th class="num">Onboarding</th><th class="num">MRR</th>
          <th class="num">Enquiries (7d)</th><th class="num">Tasks</th><th>Site</th></tr>
        ${products.map((p) => {
          const s = sites.get(p.slug) ?? [];
          return html`<tr><td><a href="/products/${p.slug}">${p.name}</a>
              ${by(counts, p.slug, "trouble") ? html` <span class="chip warn">${by(counts, p.slug, "trouble")} payment issue</span>` : ""}</td>
            <td class="num">${by(counts, p.slug, "live")}</td><td class="num">${by(counts, p.slug, "onboarding")}</td>
            <td class="num">${formatPrice(mrr.get(p.slug) ?? 0)}</td><td class="num">${by(leads, p.slug)}</td>
            <td class="num">${by(tasks, p.slug)}</td>
            <td>${s.length ? s.map((x) => html`<span class="dot ${x.ok ? "ok" : "bad"}"></span>`) : html`<span class="muted small">not checked yet</span>`}</td></tr>`;
        })}
        </table>
      </div>

      <div class="grid-2">
        <div class="panel"><div class="spread"><h2>Top of the inbox</h2><a href="/inbox" class="small">All ${openTotal}</a></div>
          ${urgent.length ? html`<table>${urgent.map(
            (t) => html`<tr><td>${t.priority === 1 ? html`<span class="dot bad"></span>` : ""}<a href="/inbox#t${t.id}">${t.title}</a>
              <div class="small muted">${productName(t.product)} · ${ago(t.created_at)}</div></td><td>${chip(t.kind)}</td></tr>`,
          )}</table>` : empty("Nothing needs you right now.")}
        </div>
        <div class="panel"><div class="spread"><h2>Recent activity</h2><a href="/activity" class="small">All</a></div>
          ${events.length ? html`<table>${events.map(
            (e) => html`<tr><td><span class="dot ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok"}"></span>${e.message}
              <div class="small muted">${productName(e.product)} · ${ago(e.at)}</div></td></tr>`,
          )}</table>` : empty("No activity yet.")}
        </div>
      </div>
      ${disconnected.length ? html`<div class="panel"><h2>Not connected yet</h2><p class="small muted">Work that needs these
        becomes a manual task in the inbox until they're connected.</p>
        <div class="row">${disconnected.map((i) => html`<span class="chip warn">${i.name}</span>`)}</div>
        <p class="small"><a href="/system">See what each one needs</a></p></div>` : ""}`;
    return send(reply, req, "Overview", body, "/");
  });

  // Inbox -----------------------------------------------------------------
  app.get<{ Querystring: { product?: string } }>("/inbox", async (req, reply) => {
    const filter = req.query.product;
    const tasks = await query(
      `SELECT * FROM tasks WHERE status = 'open' AND ($1::text IS NULL OR product = $1)
       ORDER BY priority, COALESCE(due_at, created_at), created_at LIMIT 100`,
      [filter ?? null],
    );
    const cards = [];
    for (const t of tasks) cards.push(html`<a id="t${t.id}"></a>${await taskCard(t)}`);
    const body = html`
      <div class="spread"><h1>Inbox</h1>
        <form class="row" method="get"><select name="product" onchange="this.form.submit()">
          <option value="">All products</option>
          ${products.map((p) => html`<option value="${p.slug}" ${filter === p.slug ? "selected" : ""}>${p.name}</option>`)}
        </select></form></div>
      <p class="muted">Everything that needs a person: approvals, manual steps and alerts. Approving carries the
        work on automatically.</p>
      ${cards.length ? cards : html`<div class="panel">${empty("Inbox zero. Everything is running by itself.")}</div>`}`;
    return send(reply, req, "Inbox", body, "/inbox");
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>("/tasks/:id", async (req, reply) => {
    const b = req.body ?? {};
    const decision = b.decision as Decision;
    if (!["approve", "reject", "done", "dismiss"].includes(decision)) return reply.code(400).send("Bad decision");
    await decideTask(req.params.id, decision, { subject: b.subject, body: b.body, input: b.input, note: b.note });
    const ref = req.headers.referer;
    return back(reply, ref && new URL(ref).pathname.startsWith("/") ? new URL(ref).pathname + new URL(ref).search.replace(/[?&]flash=[^&]*/, "") : "/inbox", "Done.");
  });

  // Products --------------------------------------------------------------
  app.get<{ Params: { slug: string } }>("/products/:slug", async (req, reply) => {
    const product = getProduct(req.params.slug);
    if (!product) return reply.code(404).send("Unknown product");
    const paused = await getSetting<boolean>(`paused:${product.slug}`, false);
    const customers = await query<CustomerRow>(
      `SELECT * FROM customers WHERE product = $1 ORDER BY status = 'cancelled', created_at DESC LIMIT 50`,
      [product.slug],
    );
    const leads = await query(`SELECT * FROM leads WHERE product = $1 ORDER BY created_at DESC LIMIT 15`, [product.slug]);
    const pipeline = await query(
      `SELECT s.key, count(*)::int AS n FROM onboarding_steps s JOIN customers c ON c.id = s.customer_id
       WHERE c.product = $1 AND c.status = 'onboarding' AND s.status NOT IN ('done','skipped')
         AND s.position = (SELECT min(position) FROM onboarding_steps x WHERE x.customer_id = s.customer_id AND x.status NOT IN ('done','skipped'))
       GROUP BY s.key`,
      [product.slug],
    );
    const leadAutonomy = await autonomyFor(product.slug, "lead_replies", "approve");
    const routineAutonomy = await Promise.all(
      product.routines.map(async (r) => autonomyFor(product.slug, `routine:${r.key}`, r.approval ? "approve" : "auto")),
    );
    const sites = (await siteStatus()).get(product.slug) ?? [];
    const tools = integrations.filter((i) => product.tools.includes(i.id));
    const autonomySelect = (name: string, value: string) =>
      html`<select name="${name}"><option value="approve" ${value === "approve" ? "selected" : ""}>Needs my approval</option>
        <option value="auto" ${value === "auto" ? "selected" : ""}>Fully automatic</option></select>`;
    const formSnippet = `<form method="post" action="${config.baseUrl}/api/leads/${product.slug}">
  <input name="name" required> <input name="email" type="email" required>
  <input name="business"> <textarea name="message"></textarea>
  <input name="company-name" style="display:none" tabindex="-1" autocomplete="off">
  <input type="hidden" name="_redirect" value="${product.siteUrls[0]}/thanks/">
  <button>Send</button>
</form>`;

    const body = html`
      <div class="spread"><div><h1>${product.name}</h1><div class="muted">${product.tagline}</div></div>
        <form method="post" action="/products/${product.slug}/pause">
          ${paused ? html`<span class="chip bad">Paused</span> <button class="primary" name="paused" value="false">Resume</button>`
                   : html`<button name="paused" value="true" class="danger">Pause all automation</button>`}
        </form></div>
      <p>${product.description}</p>

      <div class="grid-2">
        <div class="panel"><h2>Plans and sign-up links</h2>
          <table>${product.plans.map((p) => html`<tr><td><strong>${p.name}</strong><div class="small muted">${p.summary}</div></td>
            <td class="num">${product.quoted ? "Quoted" : formatPrice(p.amountPence, p.interval)}${p.setupFeePence ? html`<div class="small muted">+ ${formatPrice(p.setupFeePence)} setup</div>` : ""}</td></tr>
            ${product.quoted ? "" : html`<tr><td colspan="2"><input readonly value="${config.baseUrl}/buy/${product.slug}/${p.id}" onclick="this.select()"></td></tr>`}`)}</table>
          ${product.addOns?.length ? html`<p class="small muted">Add-ons: ${product.addOns.map((a) => `${a.name} (${formatPrice(a.amountPence)}${a.recurring ? " recurring" : " one-off"}, ?addons=${a.id})`).join("; ")}</p>` : ""}
        </div>
        <div class="panel"><h2>Autonomy</h2>
          <form method="post" action="/products/${product.slug}/autonomy">
            <label>Replies to new enquiries and follow-ups</label>${autonomySelect("lead_replies", leadAutonomy)}
            ${product.routines.map((r, i) => html`<label>${r.title}</label>${autonomySelect(`routine:${r.key}`, routineAutonomy[i]!)}`)}
            <p class="help">Start with approval on and switch to fully automatic once you're happy with the drafts.</p>
            <button class="primary">Save</button>
          </form>
        </div>
      </div>

      <div class="grid-2">
        <div class="panel"><h2>Onboarding</h2>
          <table>${product.onboarding.map((s) => {
            const n = pipeline.find((p) => p.key === s.key)?.n ?? 0;
            return html`<tr><td>${s.title}${s.plans ? html` <span class="chip">${s.plans.join(", ")}</span>` : ""}</td>
              <td>${chip(s.kind)}</td><td class="num">${n ? html`<strong>${n}</strong> here` : ""}</td></tr>`;
          })}</table>
        </div>
        <div class="panel"><h2>Tools and site</h2>
          <table>${tools.map((i) => html`<tr><td>${i.name}</td><td>${i.configured()
            ? i.automation === "full" ? html`<span class="chip ok">connected</span>` : html`<span class="chip warn">key set, manual</span>`
            : html`<span class="chip bad">not connected</span>`}</td></tr>`)}
          ${sites.map((s) => html`<tr><td><a href="${s.url}">${s.url}</a></td><td><span class="chip ${s.ok ? "ok" : "bad"}">${s.ok ? "up" : "down"}</span> <span class="small muted">${ago(s.at)}</span></td></tr>`)}
          </table>
        </div>
      </div>

      <div class="panel"><div class="spread"><h2>Customers</h2>
        <a class="btn" href="/customers/new?product=${product.slug}">Add customer manually</a></div>
        ${customers.length ? customersTable(customers) : empty("No customers yet.")}</div>

      <div class="panel"><div class="spread"><h2>Recent enquiries</h2><a class="small" href="/leads?product=${product.slug}">All</a></div>
        ${leads.length ? leadsTable(leads) : empty("No enquiries yet.")}</div>

      <div class="panel"><h2>Connect the website form</h2>
        <p class="small muted">Point the site's enquiry form at this address. Any extra fields are kept with the lead.</p>
        <pre class="pre small">${formSnippet}</pre></div>`;
    return send(reply, req, product.name, body, `/products/${product.slug}`);
  });

  app.post<{ Params: { slug: string }; Body: { paused?: string } }>("/products/:slug/pause", async (req, reply) => {
    const product = requireProduct(req.params.slug);
    const paused = req.body?.paused === "true";
    await setSetting(`paused:${product.slug}`, paused);
    await logEvent({ type: "product.paused", level: "warn", message: `${product.name} automation ${paused ? "paused" : "resumed"}`, product: product.slug });
    return back(reply, `/products/${product.slug}`, paused ? "Paused." : "Resumed.");
  });

  app.post<{ Params: { slug: string }; Body: Record<string, string> }>("/products/:slug/autonomy", async (req, reply) => {
    const product = requireProduct(req.params.slug);
    const keys = ["lead_replies", ...product.routines.map((r) => `routine:${r.key}`)];
    for (const k of keys) {
      const v = req.body?.[k];
      if (v === "auto" || v === "approve") await setSetting(`autonomy:${product.slug}:${k}`, v);
    }
    await logEvent({ type: "product.autonomy", message: `${product.name} autonomy settings updated`, product: product.slug });
    return back(reply, `/products/${product.slug}`, "Saved.");
  });

  // Customers -------------------------------------------------------------
  app.get<{ Querystring: { product?: string; status?: string } }>("/customers", async (req, reply) => {
    const rows = await query<CustomerRow>(
      `SELECT * FROM customers WHERE ($1::text IS NULL OR product = $1) AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 300`,
      [req.query.product || null, req.query.status || null],
    );
    const statuses = ["onboarding", "active", "past_due", "paused", "cancelled"];
    const body = html`<div class="spread"><h1>Customers</h1>
      <form class="row" method="get">
        <select name="product"><option value="">All products</option>${products.map((p) => html`<option value="${p.slug}" ${req.query.product === p.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <select name="status"><option value="">Any status</option>${statuses.map((s) => html`<option ${req.query.status === s ? "selected" : ""}>${s}</option>`)}</select>
        <button>Filter</button></form></div>
      <div class="panel">${rows.length ? customersTable(rows, true) : empty("No customers match.")}</div>`;
    return send(reply, req, "Customers", body, "/customers");
  });

  app.get<{ Querystring: { product?: string } }>("/customers/new", async (req, reply) => {
    const product = getProduct(req.query.product ?? "") ?? products[0]!;
    const body = html`<h1>Add a customer manually</h1>
      <div class="panel"><p class="muted">For quoted work (Good Questions) or anyone who signed up outside the website.
        Onboarding starts straight away, beginning with the welcome email and intake form.</p>
      <form method="post" action="/customers/new">
        <label>Product</label><select name="product">${products.map((p) => html`<option value="${p.slug}" ${p.slug === product.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <label>Plan id</label><input name="plan" value="${product.plans[0]?.id}" required>
        <div class="help">Plans: ${products.map((p) => `${p.name}: ${p.plans.map((x) => x.id).join(", ")}`).join(" · ")}</div>
        <label>Name</label><input name="name" required>
        <label>Business</label><input name="business">
        <label>Email</label><input name="email" type="email" required>
        <label>Monthly value in pounds (optional)</label><input name="amount" inputmode="decimal">
        <p style="margin-top:16px"><button class="primary">Create and start onboarding</button></p>
      </form></div>`;
    return send(reply, req, "Add customer", body, "/customers");
  });

  app.post<{ Body: Record<string, string> }>("/customers/new", async (req, reply) => {
    const b = req.body ?? {};
    const product = requireProduct(b.product ?? "");
    const plan = getPlan(product, b.plan ?? "");
    if (!plan) return reply.code(400).send(`Unknown plan for ${product.name}`);
    const amount = b.amount ? Math.round(Number.parseFloat(b.amount) * 100) : plan.amountPence;
    const customer = await one<CustomerRow>(
      `INSERT INTO customers (product, plan, name, business, email, intake_token, amount_pence, interval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'month') RETURNING *`,
      [product.slug, plan.id, b.name, b.business || null, b.email, token(), Number.isFinite(amount) ? amount : 0],
    );
    await logEvent({ type: "customer.created", message: `Added ${b.name} to ${product.name} by hand`, product: product.slug, customerId: customer!.id });
    await instantiateSteps(customer!);
    await advanceOnboarding(customer!.id);
    return back(reply, `/customers/${customer!.id}`, "Customer created and onboarding started.");
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return reply.code(404).send("Not found");
    const product = requireProduct(c.product);
    const steps = await query(`SELECT * FROM onboarding_steps WHERE customer_id = $1 ORDER BY position`, [c.id]);
    const deliveries = await query(`SELECT * FROM deliveries WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`, [c.id]);
    const emails = await query(`SELECT * FROM emails WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`, [c.id]);
    const events = await query(`SELECT * FROM events WHERE customer_id = $1 ORDER BY at DESC LIMIT 30`, [c.id]);
    const tasks = await query(`SELECT * FROM tasks WHERE customer_id = $1 AND status = 'open' ORDER BY created_at`, [c.id]);
    const intake = c.data.intake ?? {};
    const saved = Object.entries(c.data).filter(([k]) => !["intake", "intake_completed_at", "intake_reminders", "intake_reminded_at", "addOns"].includes(k));
    const plan = getPlan(product, c.plan);

    const body = html`
      <div class="spread"><div><h1>${c.business || c.name || c.email}</h1>
        <div class="muted">${product.name} · ${plan?.name ?? c.plan} · ${formatPrice(c.amount_pence, c.interval)} · since ${fmtDate(c.created_at)}</div></div>
        <form method="post" action="/customers/${c.id}/status" class="row">
          ${chip(c.status)}
          ${c.status !== "active" && c.status !== "cancelled" ? html`<button class="small" name="status" value="active">Mark live</button>` : ""}
          ${c.status === "active" ? html`<button class="small" name="status" value="paused">Pause</button>` : ""}
          ${c.status !== "cancelled" ? html`<button class="small danger" name="status" value="cancelled" onclick="return confirm('Cancel this customer? Their Stripe subscription must be cancelled in Stripe.')">Cancel</button>` : ""}
        </form></div>
      <div class="grid-2">
        <div class="panel"><h2>Contact</h2>
          <table><tr><td class="muted">Name</td><td>${c.name}</td></tr>
            <tr><td class="muted">Email</td><td><a href="mailto:${c.email}">${c.email}</a></td></tr>
            <tr><td class="muted">Phone</td><td>${c.phone}</td></tr>
            <tr><td class="muted">Intake form</td><td>${c.intake_token ? html`<a href="/start/${c.intake_token}">${config.baseUrl}/start/${c.intake_token}</a>` : ""}</td></tr>
            ${c.stripe_customer_id ? html`<tr><td class="muted">Stripe</td><td><a href="https://dashboard.stripe.com/customers/${c.stripe_customer_id}">${c.stripe_customer_id}</a></td></tr>` : ""}
          </table></div>
        <div class="panel"><h2>Onboarding</h2>
          <table>${steps.map((s) => html`<tr><td>${s.title}${s.last_error ? html`<div class="small" style="color:var(--bad)">${s.last_error}</div>` : ""}</td>
            <td>${chip(s.status)}</td>
            <td class="row">${s.status === "failed" ? html`<form method="post" action="/customers/${c.id}/steps/${s.id}/retry" class="inline"><button class="small">Retry</button></form>` : ""}
              ${["pending", "waiting", "failed"].includes(s.status) ? html`<form method="post" action="/customers/${c.id}/steps/${s.id}/skip" class="inline" onsubmit="return confirm('Skip this step?')"><button class="small">Skip</button></form>` : ""}</td></tr>`)}</table>
        </div>
      </div>
      ${tasks.length ? html`<h2>Waiting on you</h2>${await Promise.all(tasks.map(taskCard))}` : ""}
      <div class="grid-2">
        <div class="panel"><h2>Intake answers</h2>
          ${Object.keys(intake).length ? html`<table>${product.intake.map((f) => html`<tr><td class="muted">${f.label}</td><td style="white-space:pre-wrap">${intake[f.key]}</td></tr>`)}</table>` : empty("Not filled in yet.")}
        </div>
        <div class="panel"><h2>Saved work</h2>
          ${saved.length ? saved.map(([k, v]) => html`<h3>${k.replace(/_/g, " ")}</h3><div class="pre small">${typeof v === "string" ? v : JSON.stringify(v, null, 2)}</div>`) : empty("Nothing saved yet.")}
        </div>
      </div>
      <div class="panel"><h2>Recurring work</h2>
        ${deliveries.length ? html`<table><tr><th>Routine</th><th>Period</th><th>Status</th><th></th></tr>${deliveries.map((d) => html`<tr>
          <td>${product.routines.find((r) => r.key === d.routine)?.title ?? d.routine}${d.last_error ? html`<div class="small" style="color:var(--bad)">${d.last_error}</div>` : ""}</td>
          <td>${d.period}</td><td>${chip(d.status)}</td>
          <td>${d.status === "failed" ? html`<form method="post" action="/customers/${c.id}/deliveries/${d.id}/retry" class="inline"><button class="small">Retry</button></form>` : ""}</td></tr>`)}</table>` : empty("Starts once the customer is live.")}
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Emails</h2>${emails.length ? html`<table>${emails.map((e) => html`<tr><td>${e.subject}<div class="small muted">${e.kind} · ${ago(e.created_at)}</div></td><td>${chip(e.status)}</td></tr>`)}</table>` : empty("None yet.")}</div>
        <div class="panel"><h2>History</h2>${events.length ? html`<table>${events.map((e) => html`<tr><td>${e.message}<div class="small muted">${fmtDate(e.at, true)}</div></td></tr>`)}</table>` : empty("None yet.")}</div>
      </div>`;
    return send(reply, req, c.business || c.email, body, "/customers");
  });

  app.post<{ Params: { id: string; stepId: string } }>("/customers/:id/steps/:stepId/retry", async (req, reply) => {
    await retryStep(req.params.stepId);
    return back(reply, `/customers/${req.params.id}`, "Retried.");
  });

  app.post<{ Params: { id: string; stepId: string } }>("/customers/:id/steps/:stepId/skip", async (req, reply) => {
    await skipStep(req.params.stepId);
    return back(reply, `/customers/${req.params.id}`, "Skipped.");
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/customers/:id/status", async (req, reply) => {
    const status = req.body?.status;
    if (status !== "active" && status !== "paused" && status !== "cancelled") return reply.code(400).send("Bad status");
    await setCustomerStatus(req.params.id, status);
    return back(reply, `/customers/${req.params.id}`, status === "cancelled" ? "Cancelled here. Also cancel the subscription in Stripe if they had one." : "Updated.");
  });

  app.post<{ Params: { id: string; deliveryId: string } }>("/customers/:id/deliveries/:deliveryId/retry", async (req, reply) => {
    await retryDelivery(req.params.deliveryId);
    return back(reply, `/customers/${req.params.id}`, "Retried.");
  });

  // Leads -----------------------------------------------------------------
  app.get<{ Querystring: { product?: string; status?: string } }>("/leads", async (req, reply) => {
    const rows = await query(
      `SELECT * FROM leads WHERE ($1::text IS NULL OR product = $1) AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 300`,
      [req.query.product || null, req.query.status || null],
    );
    const statuses = ["new", "contacted", "followed_up", "replied", "won", "lost", "unsubscribed"];
    const body = html`<div class="spread"><h1>Leads</h1>
      <form class="row" method="get">
        <select name="product"><option value="">All products</option>${products.map((p) => html`<option value="${p.slug}" ${req.query.product === p.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <select name="status"><option value="">Any status</option>${statuses.map((s) => html`<option ${req.query.status === s ? "selected" : ""}>${s}</option>`)}</select>
        <button>Filter</button></form></div>
      <div class="panel">${rows.length ? leadsTable(rows, true) : empty("No enquiries match.")}</div>`;
    return send(reply, req, "Leads", body, "/leads");
  });

  app.get<{ Params: { id: string } }>("/leads/:id", async (req, reply) => {
    const l = await one(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
    if (!l) return reply.code(404).send("Not found");
    const emails = await query(`SELECT * FROM emails WHERE lead_id = $1 ORDER BY created_at`, [l.id]);
    const fields = [["Name", l.name], ["Email", l.email], ["Phone", l.phone], ["Business", l.business], ["Website", l.website], ["Town", l.town], ["Message", l.message], ["Source", l.source]];
    const body = html`<div class="spread"><div><h1>${l.business || l.name || l.email}</h1>
        <div class="muted">${productName(l.product)} enquiry · ${fmtDate(l.created_at, true)}</div></div>${chip(l.status)}</div>
      <div class="grid-2">
        <div class="panel"><h2>Details</h2><table>${fields.filter(([, v]) => v).map(([k, v]) => html`<tr><td class="muted">${k}</td><td style="white-space:pre-wrap">${v}</td></tr>`)}
          ${Object.entries(l.data ?? {}).map(([k, v]) => html`<tr><td class="muted">${k}</td><td>${String(v)}</td></tr>`)}</table>
          <form method="post" action="/leads/${l.id}/status" class="row" style="margin-top:12px">
            <button name="status" value="lost">Mark lost</button>
            <button name="status" value="unsubscribed">Asked to stop</button>
            ${l.next_touch_at ? html`<span class="small muted">Next follow-up ${fmtDate(l.next_touch_at, true)}</span>` : ""}
          </form></div>
        <div class="panel"><h2>Emails</h2>${emails.length ? emails.map((e) => html`<h3>${e.subject} ${chip(e.status)}</h3><div class="pre small">${e.body_text}</div>`) : empty("None yet. A reply is drafted within five minutes of the enquiry.")}</div>
      </div>`;
    return send(reply, req, "Lead", body, "/leads");
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/leads/:id/status", async (req, reply) => {
    const status = req.body?.status;
    if (status === "lost" || status === "unsubscribed") {
      await query(`UPDATE leads SET status = $2, next_touch_at = NULL, updated_at = now() WHERE id = $1`, [req.params.id, status]);
      await query(`UPDATE emails SET status = 'cancelled' WHERE lead_id = $1 AND status IN ('draft','queued')`, [req.params.id]);
      await query(`UPDATE tasks SET status = 'dismissed', resolved_at = now() WHERE lead_id = $1 AND status = 'open'`, [req.params.id]);
    }
    return back(reply, `/leads/${req.params.id}`, "Updated.");
  });

  // Activity and system ----------------------------------------------------
  app.get<{ Querystring: { level?: string } }>("/activity", async (req, reply) => {
    const events = await query(
      `SELECT * FROM events WHERE ($1::text IS NULL OR level = $1) ORDER BY at DESC LIMIT 300`,
      [req.query.level || null],
    );
    const body = html`<div class="spread"><h1>Activity</h1>
        <div class="row"><a href="/activity">All</a><a href="/activity?level=warn">Warnings</a><a href="/activity?level=error">Errors</a></div></div>
      <div class="panel">${events.length ? html`<table><tr><th>When</th><th>Product</th><th>What happened</th></tr>${events.map((e) => html`<tr>
        <td class="small muted" style="white-space:nowrap">${fmtDate(e.at, true)}</td><td class="small">${productName(e.product)}</td>
        <td><span class="dot ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok"}"></span>${e.message}
          ${e.customer_id ? html` <a class="small" href="/customers/${e.customer_id}">customer</a>` : ""}
          ${e.lead_id ? html` <a class="small" href="/leads/${e.lead_id}">lead</a>` : ""}</td></tr>`)}</table>` : empty("Nothing yet.")}</div>`;
    return send(reply, req, "Activity", body, "/activity");
  });

  app.get("/system", async (req, reply) => {
    const lastRuns = await query(`SELECT DISTINCT ON (job) * FROM job_runs ORDER BY job, started_at DESC`);
    const lastOk = await query(`SELECT job, max(started_at) AS at FROM job_runs WHERE status = 'ok' GROUP BY job`);
    const pausedAll = await getSetting<boolean>("paused:all", false);
    const warnings = assertProductionConfig();
    const body = html`<div class="spread"><h1>Automation</h1>
        <form method="post" action="/system/pause">
          ${pausedAll ? html`<span class="chip bad">Everything paused</span> <button class="primary" name="paused" value="false">Resume everything</button>`
                      : html`<button class="danger" name="paused" value="true">Pause everything</button>`}
        </form></div>
      ${warnings.length ? html`<div class="flash">${warnings.join("; ")}</div>` : ""}
      <div class="panel"><h2>Scheduled jobs</h2>
        <table><tr><th>Job</th><th>Schedule</th><th>Last run</th><th>Result</th><th></th></tr>
        ${jobs.map((j) => {
          const r = lastRuns.find((x) => x.job === j.name);
          const ok = lastOk.find((x) => x.job === j.name);
          return html`<tr><td><strong>${j.name}</strong><div class="small muted">${j.description}</div></td>
            <td class="small">${"everyMinutes" in j.schedule ? `every ${j.schedule.everyMinutes} min` : `daily ${j.schedule.dailyAt}`}</td>
            <td class="small">${r ? ago(r.started_at) : "never"}${ok && r?.status === "error" ? html`<div class="muted">last ok ${ago(ok.at)}</div>` : ""}</td>
            <td>${r ? chip(r.status) : ""}<div class="small muted">${r?.error ?? r?.summary ?? ""}</div></td>
            <td><form method="post" action="/system/jobs/${j.name}/run"><button class="small">Run now</button></form></td></tr>`;
        })}</table></div>
      <div class="panel"><h2>Connections</h2>
        <table><tr><th>Service</th><th>Used for</th><th>Settings needed</th><th>Status</th></tr>
        ${integrations.map((i) => html`<tr><td>${i.name}${i.notes ? html`<div class="small muted">${i.notes}</div>` : ""}</td><td class="small">${i.purpose}</td>
          <td class="small"><code>${i.envVars.join(", ")}</code></td>
          <td>${i.configured() ? (i.automation === "full" ? html`<span class="chip ok">connected</span>` : html`<span class="chip warn">key set; manual tasks for now</span>`) : html`<span class="chip bad">not connected</span>`}</td></tr>`)}
        </table>
        <p class="small muted">Settings are environment variables on the DigitalOcean app. Stripe webhook URL:
          <code>${config.baseUrl}/webhooks/stripe</code></p></div>`;
    return send(reply, req, "Automation", body, "/system");
  });

  app.post<{ Params: { name: string } }>("/system/jobs/:name/run", async (req, reply) => {
    const job = jobs.find((j) => j.name === req.params.name);
    if (!job) return reply.code(404).send("Unknown job");
    const summary = await runJob(job);
    return back(reply, "/system", summary === null ? `${job.name} is already running or failed; see below.` : `${job.name}: ${summary}`);
  });

  app.post<{ Body: { paused?: string } }>("/system/pause", async (req, reply) => {
    const paused = req.body?.paused === "true";
    await setSetting("paused:all", paused);
    await logEvent({ type: "system.paused", level: "warn", message: `All automation ${paused ? "paused" : "resumed"}` });
    return back(reply, "/system", paused ? "Everything is paused." : "Resumed.");
  });
}

function customersTable(rows: CustomerRow[], showProduct = false): Raw {
  return html`<table><tr><th>Customer</th>${showProduct ? html`<th>Product</th>` : ""}<th>Plan</th><th class="num">Value</th><th>Status</th><th>Since</th></tr>
    ${rows.map((c) => html`<tr><td><a href="/customers/${c.id}">${c.business || c.name || c.email}</a><div class="small muted">${c.email}</div></td>
      ${showProduct ? html`<td>${productName(c.product)}</td>` : ""}<td>${c.plan}</td>
      <td class="num">${formatPrice(c.amount_pence, c.interval)}</td><td>${chip(c.status)}</td><td class="small">${fmtDate(c.created_at)}</td></tr>`)}</table>`;
}

function leadsTable(rows: any[], showProduct = false): Raw {
  return html`<table><tr><th>Enquiry</th>${showProduct ? html`<th>Product</th>` : ""}<th>Status</th><th>Received</th></tr>
    ${rows.map((l) => html`<tr><td><a href="/leads/${l.id}">${l.business || l.name || l.email || l.phone}</a>
      <div class="small muted">${l.email ?? ""} ${l.message ? `· ${String(l.message).slice(0, 90)}` : ""}</div></td>
      ${showProduct ? html`<td>${productName(l.product)}</td>` : ""}<td>${chip(l.status)}</td><td class="small">${ago(l.created_at)}</td></tr>`)}</table>`;
}

