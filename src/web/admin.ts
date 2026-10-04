import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertProductionConfig, config } from "../config.js";
import { one, query } from "../db/index.js";
import { decideTask, type Decision } from "../engine/actions.js";
import type { CustomerRow } from "../engine/types.js";
import { importProspects, outreachSettings, suppress } from "../engine/outreach.js";
import { advanceOnboarding, instantiateSteps, retryDelivery, retryStep, setCustomerStatus, skipStep } from "../engine/workflow.js";
import { runJob } from "../engine/scheduler.js";
import { jobs } from "../jobs/index.js";
import { integrations } from "../integrations/index.js";
import { logEvent } from "../lib/events.js";
import { autonomyFor, getSetting, setSetting } from "../lib/settings.js";
import { ago, fmtDate, token } from "../lib/util.js";
import { bookingUrl, formatPrice, getPlan, getProduct, monthlyValuePence, products, requireProduct } from "../products/index.js";
import { buyUrl, portalUrl } from "../portal/accounts.js";
import { dataAdminRoutes } from "./admin-data.js";
import { trainingRoutes } from "./admin-training.js";
import { teamRoutes } from "./team.js";
import { clientAdminRoutes, clientPanels } from "./admin-clients.js";
import { requireAuth } from "./auth.js";
import { html, type Raw } from "./html.js";
import { chip, empty, icon, intro, page, statusLabel, type Area } from "./layout.js";

async function navCounts() {
  const r = await one(`SELECT count(*)::int AS n FROM tasks WHERE status = 'open'`);
  const s = await one(`SELECT count(*)::int AS n FROM support_requests WHERE status = 'open'`);
  return { inbox: r?.n ?? 0, support: s?.n ?? 0 };
}

async function send(reply: FastifyReply, req: FastifyRequest, title: string, body: Raw, active: string) {
  const flash = (req.query as Record<string, string> | undefined)?.flash;
  return reply.type("text/html").send(page(title, body, { active, counts: await navCounts(), flash }));
}

function back(reply: FastifyReply, to: string, flash?: string) {
  const sep = to.includes("?") ? "&" : "?";
  return reply.redirect(flash ? `${to}${sep}flash=${encodeURIComponent(flash)}` : to, 303);
}

/** A big coloured button on the home page leading to one area. */
function tile(href: string, area: Area, name: string, what: string, count: string, urgent = false): Raw {
  return html`<a class="tile area-${area} ${urgent ? "urgent" : ""}" href="${href}"><span class="ti lg" aria-hidden="true">${icon(area)}</span><span class="name">${name}</span>
    <span class="what">${what}</span><span class="count">${count}</span></a>`;
}

/** "Good morning" and so on, in UK time. */
function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(new Date()));
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
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
      ${inbound ? html`<div class="small muted">What they wrote${inbound.summary ? html` · ${inbound.summary}` : ""}</div>
        <div class="pre small" style="margin-bottom:10px">${inbound.body_text}</div>` : ""}
      <div class="small muted">To ${email?.to_address} · from ${email?.from_address}</div>
      <label for="subj${t.id}">Subject</label><input name="subject" id="subj${t.id}" value="${email?.subject ?? ""}">
      <label for="body${t.id}">The email <span class="muted">(you can edit it before sending)</span></label><textarea name="body" id="body${t.id}" style="min-height:220px">${footerAt >= 0 ? bodyText.slice(0, footerAt) : bodyText}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="approve">Looks good, send it</button>
        <input name="note" aria-label="Why not? (optional)" placeholder="Why not? (optional)" style="max-width:260px">
        <button name="decision" value="reject" class="danger">Don't send</button>
      </div></form>`;
  } else if (t.action === "publish") {
    form = html`<form method="post" action="/tasks/${t.id}">
      ${t.resolution ? html`<p class="flash">${t.resolution}</p>` : ""}
      <label for="body${t.id}" class="sr-only">What will be published</label>
      <textarea name="body" id="body${t.id}" style="min-height:220px">${t.body}</textarea>
      <div class="help">You can edit this. Approving publishes it straight away; nothing else to do.</div>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="approve">Looks good, publish it</button>
        <input name="note" aria-label="What's wrong with it? (optional)" placeholder="What's wrong with it? (optional)" style="max-width:260px">
        <button name="decision" value="reject" class="danger">Don't publish</button>
      </div></form>`;
  } else if (t.action === "approve_review") {
    form = html`<form method="post" action="/tasks/${t.id}">
      <label for="body${t.id}" class="sr-only">Draft</label>
      <textarea name="body" id="body${t.id}" style="min-height:260px">${t.body}</textarea>
      <div class="help">You can edit this before approving.</div>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="approve">Looks good, approve it</button>
        <input name="note" aria-label="What's wrong with it? (optional)" placeholder="What's wrong with it? (optional)" style="max-width:260px">
        <button name="decision" value="reject" class="danger">Not right</button>
      </div></form>`;
  } else if (t.kind === "manual") {
    const g = p.guide as { why: string; minutes: number; steps: string[] } | undefined;
    form = html`<form method="post" action="/tasks/${t.id}">
      ${g
        ? html`<div class="guide">
            <p class="why"><strong>Why this needs you:</strong> ${g.why}</p>
            <p class="time">About ${g.minutes} minutes</p>
            <ol class="steps">${g.steps.map((x) => html`<li>${x}</li>`)}</ol>
          </div>
          <details><summary class="small">More detail</summary><div class="pre small">${t.body}</div></details>`
        : html`<div class="pre">${t.body}</div>`}
      ${p.inputLabel ? html`<label for="input${t.id}">${p.inputLabel}</label><textarea name="input" id="input${t.id}" required></textarea>` : ""}
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="done">I've done this</button>
        <button name="decision" value="dismiss">Not needed</button>
      </div></form>`;
  } else {
    form = html`<form method="post" action="/tasks/${t.id}">
      <div class="pre">${t.body}</div>
      <div class="row" style="margin-top:10px">
        <button class="primary" name="decision" value="done">Sorted</button>
        <button name="decision" value="dismiss">Not needed</button>
      </div></form>`;
  }
  const who = t.customer_id
    ? html` · <a href="/customers/${t.customer_id}">open customer</a>`
    : t.lead_id
      ? html` · <a href="/leads/${t.lead_id}">open enquiry</a>`
      : "";
  return html`<div class="panel task ${t.kind} p${t.priority}">
    <div class="spread"><h3>${t.title}</h3>
      <span class="row">${chip(t.kind)}${t.priority === 1 ? html`<span class="chip bad">Urgent</span>` : ""}</span></div>
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
    const openSupport = (await one(`SELECT count(*)::int AS n FROM support_requests WHERE status = 'open'`))?.n ?? 0;
    const disconnected = integrations.filter((i) => !i.configured());

    const body = html`
      <div class="spread"><h1>${greeting()}</h1><span class="muted small">${fmtDate(new Date(), true)}</span></div>
      ${intro(openTotal
        ? `Here's how everything is doing. Most of it runs by itself. There ${openTotal === 1 ? "is 1 thing" : `are ${openTotal} things`} waiting for you in your to-do list.`
        : "Here's how everything is doing. Most of it runs by itself, and nothing needs you right now.")}
      ${warnings.length ? html`<div class="flash">One thing to set up: ${warnings.join("; ")}.</div>` : ""}
      <div class="tiles">
        ${tile("/inbox", "todo", "To-do list", "Things that need you", openTotal ? `${openTotal} waiting` : "All done", openTotal > 0)}
        ${tile("/support", "messages", "Messages", "Questions from clients", openSupport ? `${openSupport} to answer` : "None waiting", openSupport > 0)}
        ${tile("/customers", "customers", "Customers", "Everyone who has signed up", `${counts.reduce((s, r) => s + r.live, 0)} live, ${counts.reduce((s, r) => s + r.onboarding, 0)} being set up`)}
        ${tile("/leads", "leads", "Enquiries", "People who filled in a form", `${leads.reduce((s, r) => s + r.n, 0)} this week`)}
        ${tile("/outreach", "outreach", "Cold emails", "Emails to new businesses", "Settings and lists")}
        ${tile("/clients", "logins", "Client logins", "Clients' own accounts", "See their dashboards")}
      </div>
      <p class="small"><strong>Coming in each month:</strong> ${formatPrice(totalMrr)} · <strong>Websites working:</strong> ${allSites.filter((s) => s.ok).length} of ${allSites.length}</p>

      <div class="panel"><h2>Your products</h2>
        <table><tr><th>Product</th><th class="num">Live</th><th class="num">Being set up</th><th class="num">Each month</th>
          <th class="num">Enquiries this week</th><th class="num">To-dos</th><th>Website</th></tr>
        ${products.map((p) => {
          const s = sites.get(p.slug) ?? [];
          return html`<tr><td><a href="/products/${p.slug}">${p.name}</a>
              ${by(counts, p.slug, "trouble") ? html` <span class="chip warn">${by(counts, p.slug, "trouble")} late payment</span>` : ""}</td>
            <td class="num">${by(counts, p.slug, "live")}</td><td class="num">${by(counts, p.slug, "onboarding")}</td>
            <td class="num">${formatPrice(mrr.get(p.slug) ?? 0)}</td><td class="num">${by(leads, p.slug)}</td>
            <td class="num">${by(tasks, p.slug)}</td>
            <td>${s.length ? s.map((x) => html`<span class="dot ${x.ok ? "ok" : "bad"}"></span><span class="sr-only">${x.ok ? "working" : "not responding"}</span>`) : html`<span class="muted small">Not checked yet</span>`}</td></tr>`;
        })}
        </table>
      </div>

      <div class="grid-2">
        <div class="panel"><div class="spread"><h2>Next on your to-do list</h2><a href="/inbox" class="small">See all ${openTotal}</a></div>
          ${urgent.length ? html`<table>${urgent.map(
            (t) => html`<tr><td>${t.priority === 1 ? html`<span class="dot bad"></span>` : ""}<a href="/inbox#t${t.id}">${t.title}</a>
              <div class="small muted">${productName(t.product)} · ${ago(t.created_at)}</div></td><td>${chip(t.kind)}</td></tr>`,
          )}</table>` : empty("Nothing needs you right now. Everything is running by itself.")}
        </div>
        <div class="panel"><div class="spread"><h2>What's just happened</h2><a href="/activity" class="small">See everything</a></div>
          ${events.length ? html`<table>${events.map(
            (e) => html`<tr><td><span class="dot ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok"}"></span>${e.message}
              <div class="small muted">${productName(e.product)} · ${ago(e.at)}</div></td></tr>`,
          )}</table>` : empty("Nothing has happened yet. It'll fill up as customers arrive.")}
        </div>
      </div>
      ${disconnected.length ? html`<div class="panel"><h2>Not connected yet</h2><p class="small muted">Until these are
        connected, the work they would do comes to your to-do list instead, with instructions.</p>
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
      <div class="spread"><h1>Your to-do list</h1>
        <form class="row" method="get"><label for="f-product" class="sr-only">Show to-dos for</label><select name="product" id="f-product" onchange="this.form.submit()" style="width:auto">
          <option value="">All products</option>
          ${products.map((p) => html`<option value="${p.slug}" ${filter === p.slug ? "selected" : ""}>${p.name}</option>`)}
        </select></form></div>
      ${intro("These are the only things that need you. When you approve something or mark it done, the rest carries on by itself. The most urgent are at the top.")}
      ${cards.length ? cards : html`<div class="panel">${empty("You're all caught up. Everything is running by itself.")}</div>`}`;
    return send(reply, req, "Inbox", body, "/inbox");
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>("/tasks/:id", async (req, reply) => {
    const b = req.body ?? {};
    const decision = b.decision as Decision;
    if (!["approve", "reject", "done", "dismiss"].includes(decision)) return reply.code(400).send("Bad decision");
    await decideTask(req.params.id, decision, { subject: b.subject, body: b.body, input: b.input, note: b.note });
    const ref = req.headers.referer;
    return back(reply, ref && new URL(ref).pathname.startsWith("/") ? new URL(ref).pathname + new URL(ref).search.replace(/[?&]flash=[^&]*/, "") : "/inbox", "Thanks, that's done.");
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
    const outreachAutonomy = await autonomyFor(product.slug, "outreach", "approve");
    const routineAutonomy = await Promise.all(
      product.routines.map(async (r) => autonomyFor(product.slug, `routine:${r.key}`, r.approval ? "approve" : "auto")),
    );
    const sites = (await siteStatus()).get(product.slug) ?? [];
    const tools = integrations.filter((i) => product.tools.includes(i.id));
    const autonomySelect = (name: string, value: string) =>
      html`<select name="${name}" id="a-${name}"><option value="approve" ${value === "approve" ? "selected" : ""}>Ask me first</option>
        <option value="auto" ${value === "auto" ? "selected" : ""}>Just do it</option></select>`;
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
          ${product.launched === false ? html`<span class="chip warn">Not launched yet, so nothing runs for it</span>` : ""}
          ${paused ? html`<span class="chip bad">Paused</span> <button class="primary" name="paused" value="false">Switch back on</button>`
                   : html`<button name="paused" value="true" class="danger" onclick="return confirm('Pause everything for ${product.name}? No emails or work will go out until you switch it back on.')">Pause this product</button>`}
        </form></div>
      <p>${product.description}</p>

      <div class="grid-2">
        <div class="panel"><h2>Prices and sign-up links</h2>
          <p class="small muted">Each link takes a customer straight to payment. Use them for the buttons on the website.</p>
          <table>${product.plans.map((p) => html`<tr><td><strong>${p.name}</strong><div class="small muted">${p.summary}</div></td>
            <td class="num">${product.quoted ? "Quoted" : formatPrice(p.amountPence, p.interval)}${p.setupFeePence ? html`<div class="small muted">+ ${formatPrice(p.setupFeePence)} setup</div>` : ""}</td></tr>
            ${product.quoted ? "" : html`<tr><td colspan="2"><input readonly aria-label="Sign-up link for ${p.name}" value="${buyUrl(product, p.id)}" onclick="this.select()"></td></tr>`}`)}</table>
          ${product.addOns?.length ? html`<p class="small muted">Add-ons: ${product.addOns.map((a) => `${a.name} (${formatPrice(a.amountPence)}${a.recurring ? " recurring" : " one-off"}, ?addons=${a.id})`).join("; ")}</p>` : ""}
        </div>
        <div class="panel"><h2>How much runs by itself</h2>
          <p class="small muted">For each kind of work, choose whether it goes out on its own or waits in your to-do list for a quick check.</p>
          <form method="post" action="/products/${product.slug}/autonomy">
            <label for="a-lead_replies">Replies to new enquiries, and follow-ups</label>${autonomySelect("lead_replies", leadAutonomy)}
            <label for="a-outreach">Cold emails (<a href="/outreach">settings</a>)</label>${autonomySelect("outreach", outreachAutonomy)}
            ${product.routines.map((r, i) => html`<label for="a-routine:${r.key}">${r.title}</label>${autonomySelect(`routine:${r.key}`, routineAutonomy[i]!)}`)}
            <p class="help">Tip: start with "Ask me first". Once you're happy with what it writes, switch to "Just do it".</p>
            <button class="primary">Save my choices</button>
          </form>
        </div>
      </div>

      <div class="grid-2">
        <div class="panel"><h2>Connections and website</h2>
          <table>${tools.map((i) => html`<tr><td>${i.name}</td><td>${i.configured()
            ? i.automation === "full" ? html`<span class="chip ok">Connected</span>` : html`<span class="chip warn">Key added, not automatic yet</span>`
            : html`<span class="chip bad">Not connected</span>`}</td></tr>`)}
          ${sites.map((s) => html`<tr><td><a href="${s.url}">${s.url}</a></td><td><span class="chip ${s.ok ? "ok" : "bad"}">${s.ok ? "Working" : "Not responding"}</span> <span class="small muted">checked ${ago(s.at)}</span></td></tr>`)}
          </table>
        </div>
      </div>

      <div class="panel"><h2>Onboarding checklist</h2>
        <p class="small muted">What happens for every new ${product.name} customer, in order. Steps marked "You" or "Your OK" come to your to-do list with these instructions.</p>
        <table class="checklist"><tr><th>#</th><th>Step</th><th>Who</th><th class="num">Customers here now</th></tr>
        ${product.onboarding.map((s, i) => {
          const n = pipeline.find((p) => p.key === s.key)?.n ?? 0;
          const who = s.kind === "auto" ? (s.guide ? "You, for now" : "Automatic") : s.kind === "manual" ? "You" : s.kind === "customer" ? "Client" : "Your OK";
          return html`<tr><td class="mark">${i + 1}</td>
            <td><strong>${s.title}</strong>${s.plans ? html` <span class="chip">${s.plans.join(", ")} only</span>` : ""}
              ${s.guide ? html`<details><summary class="small">How to do it (about ${s.guide.minutes} min)</summary>
                <p class="small"><strong>Why it needs you:</strong> ${s.guide.why}</p>
                <ol class="small">${s.guide.steps.map((x) => html`<li>${x}</li>`)}</ol></details>` : ""}</td>
            <td>${who}</td><td class="num">${n ? html`<strong>${n}</strong>` : "0"}</td></tr>`;
        })}</table>
      </div>

      <div class="panel"><div class="spread"><h2>Customers</h2>
        <a class="btn" href="/customers/new?product=${product.slug}">Add a customer by hand</a></div>
        ${customers.length ? customersTable(customers) : empty("No customers yet. They'll appear here as soon as someone signs up.")}</div>

      <div class="panel"><div class="spread"><h2>Recent enquiries</h2><a class="small" href="/leads?product=${product.slug}">See all</a></div>
        ${leads.length ? leadsTable(leads) : empty("No enquiries yet.")}</div>

      <div class="panel"><h2>Linking up the website</h2>
        <p class="small muted">For whoever edits the website. The enquiry form should send to this address. Any extra questions on the form are kept with the enquiry.</p>
        <pre class="pre small">${formSnippet}</pre>
        <h3 style="margin-top:14px">Client log-in button</h3>
        <p class="small muted">Link the site's "Log in" button here. Clients sign in with their email and password.</p>
        <input readonly aria-label="Client log-in link" value="${portalUrl(product)}/login" onclick="this.select()">
        <h3 style="margin-top:14px">Booking links</h3>
        <p class="small muted">Each kind of call has its own link, so the calendar shows which product it's for and whether it's a sales chat or an onboarding call. HQ hears about every booking. Customers get their onboarding link automatically after they pay.</p>
        <label class="small" for="book-chat">Sales chat (for the website's "Book a chat" buttons)</label>
        <input readonly id="book-chat" value="${portalUrl(product)}/chat" onclick="this.select()">
        <label class="small" for="book-onboarding" style="margin-top:8px">Onboarding call</label>
        <input readonly id="book-onboarding" value="${bookingUrl(product, "onboarding")}" onclick="this.select()">
        ${product.slug === "linkn" ? html`<h3 style="margin-top:14px">Sbl.so webhook address</h3>
          ${config.sbl.webhookToken
            ? html`<p class="small muted">In Sbl.so: Webhooks → Add webhook. Paste this, tick all six events, keep "All campaigns". Keep it private.</p>
              <input readonly aria-label="Sbl.so webhook address" value="${config.baseUrl}/webhooks/sbl/${config.sbl.webhookToken}" onclick="this.select()">`
            : html`<p class="small muted">Appears after the next deploy.</p>`}` : ""}
        ${product.slug === "speedtolead" ? html`<h3 style="margin-top:14px">Awaz webhook address</h3>
          ${process.env.AWAZ_WEBHOOK_TOKEN
            ? html`<p class="small muted">In Awaz, paste this as the webhook address for calls. Keep it private.</p>
              <input readonly aria-label="Awaz webhook address" value="${config.baseUrl}/webhooks/awaz/${process.env.AWAZ_WEBHOOK_TOKEN}" onclick="this.select()">`
            : html`<p class="small muted">Appears after the next deploy.</p>`}` : ""}</div>`;
    return send(reply, req, product.name, body, `/products/${product.slug}`);
  });

  app.post<{ Params: { slug: string }; Body: { paused?: string } }>("/products/:slug/pause", async (req, reply) => {
    const product = requireProduct(req.params.slug);
    const paused = req.body?.paused === "true";
    await setSetting(`paused:${product.slug}`, paused);
    await logEvent({ type: "product.paused", level: "warn", message: `${product.name} automation ${paused ? "paused" : "resumed"}`, product: product.slug });
    return back(reply, `/products/${product.slug}`, paused ? `${product.name} is paused. Nothing will go out until you switch it back on.` : `${product.name} is back on. Everything is running again.`);
  });

  app.post<{ Params: { slug: string }; Body: Record<string, string> }>("/products/:slug/autonomy", async (req, reply) => {
    const product = requireProduct(req.params.slug);
    const keys = ["lead_replies", "outreach", ...product.routines.map((r) => `routine:${r.key}`)];
    for (const k of keys) {
      const v = req.body?.[k];
      if (v === "auto" || v === "approve") await setSetting(`autonomy:${product.slug}:${k}`, v);
    }
    await logEvent({ type: "product.autonomy", message: `${product.name} autonomy settings updated`, product: product.slug });
    return back(reply, `/products/${product.slug}`, "Saved your choices.");
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
        <label for="c-product" class="sr-only">Product</label>
        <select name="product" id="c-product" style="width:auto"><option value="">All products</option>${products.map((p) => html`<option value="${p.slug}" ${req.query.product === p.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <label for="c-status" class="sr-only">Status</label>
        <select name="status" id="c-status" style="width:auto"><option value="">Any status</option>${statuses.map((s) => html`<option value="${s}" ${req.query.status === s ? "selected" : ""}>${statusLabel(s)}</option>`)}</select>
        <button>Show</button></form></div>
      ${intro("Everyone who's signed up, newest first. Click a name to see everything about them, including their dashboard as they see it.")}
      <div class="panel">${rows.length ? customersTable(rows, true) : empty(req.query.product || req.query.status ? "No customers match those choices." : "No customers yet. They'll appear here as soon as someone signs up.")}</div>`;
    return send(reply, req, "Customers", body, "/customers");
  });

  app.get<{ Querystring: { product?: string } }>("/customers/new", async (req, reply) => {
    const product = getProduct(req.query.product ?? "") ?? products[0]!;
    const body = html`<h1>Add a customer by hand</h1>
      ${intro("Use this for quoted work (like Good Questions) or anyone who signed up without using the website. As soon as you save, they get a welcome email and a link to set up their account, and setup starts by itself.")}
      <div class="panel" style="max-width:640px">
      <form method="post" action="/customers/new">
        <label for="n-choice">Product and plan</label>
        <select name="choice" id="n-choice" required>${products.map((p) => html`<optgroup label="${p.name}">${p.plans.map((pl) => html`<option value="${p.slug}|${pl.id}" ${p.slug === product.slug && pl.id === product.plans[0]?.id ? "selected" : ""}>${p.name}: ${pl.name}${p.quoted ? "" : ` (${formatPrice(pl.amountPence, pl.interval)})`}</option>`)}</optgroup>`)}</select>
        <label for="n-name">Their name</label><input name="name" id="n-name" autocomplete="off" required>
        <label for="n-business">Business name <span class="muted">(optional)</span></label><input name="business" id="n-business">
        <label for="n-email">Their email</label><input name="email" id="n-email" type="email" required>
        <label for="n-amount">How much they pay each month, in pounds <span class="muted">(optional)</span></label><input name="amount" id="n-amount" inputmode="decimal">
        <div class="help">Leave this empty to use the plan's normal price.</div>
        <p style="margin-top:18px"><button class="primary">Add them and start setting up</button></p>
      </form></div>`;
    return send(reply, req, "Add customer", body, "/customers");
  });

  app.post<{ Body: Record<string, string> }>("/customers/new", async (req, reply) => {
    const b = req.body ?? {};
    if (b.choice) [b.product, b.plan] = b.choice.split("|");
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
    return back(reply, `/customers/${customer!.id}`, "Added. They've been sent a welcome email and setup has started.");
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
    const saved = Object.entries(c.data).filter(([k]) => !["intake", "intake_completed_at", "intake_reminders", "intake_reminded_at", "addOns", "metrics_history", "call_booked_at", "call_time", "cancel_requested_at", "cancel_reason", "cancel_at"].includes(k));
    const plan = getPlan(product, c.plan);

    const body = html`
      <div class="spread"><div><h1>${c.business || c.name || c.email}</h1>
        <div class="muted">${product.name} · ${plan?.name ?? c.plan} · ${formatPrice(c.amount_pence, c.interval)} · since ${fmtDate(c.created_at)}</div></div>
        <form method="post" action="/customers/${c.id}/status" class="row">
          ${chip(c.status)}
          ${c.status !== "active" && c.status !== "cancelled" ? html`<button class="small" name="status" value="active">Mark as live</button>` : ""}
          ${c.status === "active" ? html`<button class="small" name="status" value="paused">Pause their service</button>` : ""}
          ${c.status !== "cancelled" ? html`<button class="small danger" name="status" value="cancelled" onclick="return confirm('Mark this customer as having left? This stops all work for them. If they pay by card, also cancel their subscription in Stripe.')">Mark as left</button>` : ""}
        </form></div>
      <div class="panel"><h2>Onboarding checklist</h2>
        <p class="small muted">Every step for this customer, including the ones done automatically, so you can check nothing was missed.</p>
        <table class="checklist"><tr><th></th><th>Step</th><th>Who</th><th>Status</th><th>When</th><th>What happened</th><th></th></tr>
        ${steps.map((s) => {
          const who = s.kind === "auto" ? (s.task_id && s.status === "waiting" ? "You (not automated yet)" : "Automatic")
            : s.kind === "manual" ? "You" : s.kind === "customer" ? "Client" : "Your OK";
          const mark = s.status === "done" ? "✓" : s.status === "skipped" ? "–" : s.status === "failed" ? "!" : "○";
          return html`<tr class="cl-${s.status}"><td class="mark" aria-hidden="true">${mark}</td>
            <td>${s.title}</td><td>${who}</td><td>${chip(s.status)}</td>
            <td class="small">${s.completed_at ? fmtDate(s.completed_at, true) : s.started_at ? `started ${ago(s.started_at)}` : ""}</td>
            <td class="small">${s.last_error ? html`<span style="color:var(--bad)">${s.last_error}</span>` : s.note ?? (s.status === "waiting" && s.task_id ? html`<a href="/inbox#t${s.task_id}">On your to-do list</a>` : "")}</td>
            <td><div class="row">${s.status === "failed" ? html`<form method="post" action="/customers/${c.id}/steps/${s.id}/retry" class="inline"><button class="small">Try again</button></form>` : ""}
              ${["pending", "waiting", "failed"].includes(s.status) ? html`<form method="post" action="/customers/${c.id}/steps/${s.id}/skip" class="inline" onsubmit="return confirm('Skip this step? It won\'t be done for this customer.')"><button class="small">Skip</button></form>` : ""}</div></td></tr>`;
        })}</table>
        <p class="small" style="margin-top:10px"><strong>${steps.filter((s) => s.status === "done" || s.status === "skipped").length} of ${steps.length}</strong> steps complete.</p>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Contact details</h2>
          <table><tr><td class="muted">Name</td><td>${c.name}</td></tr>
            <tr><td class="muted">Email</td><td><a href="mailto:${c.email}">${c.email}</a></td></tr>
            <tr><td class="muted">Phone</td><td>${c.phone}</td></tr>
            <tr><td class="muted">Onboarding form</td><td>${c.data.intake_completed_at ? html`completed ${fmtDate(c.data.intake_completed_at)}` : html`<span class="chip warn">not yet</span>`}</td></tr>
            ${product.bookingAfterPurchase ? html`<tr><td class="muted">Onboarding call</td><td>${c.data.call_booked_at ? html`booked ${fmtDate(c.data.call_booked_at)}` : html`<span class="chip warn">not booked yet</span>`}</td></tr>` : ""}
            ${c.data.cancel_requested_at ? html`<tr><td class="muted">Cancelling</td><td><span class="chip bad">${c.data.cancel_at ? `ends ${fmtDate(c.data.cancel_at)}` : "requested"}</span>${c.data.cancel_reason ? html`<div class="small">${c.data.cancel_reason}</div>` : ""}</td></tr>` : ""}
            ${c.stripe_customer_id ? html`<tr><td class="muted">Stripe</td><td><a href="https://dashboard.stripe.com/customers/${c.stripe_customer_id}">${c.stripe_customer_id}</a></td></tr>` : ""}
          </table></div>
      </div>
      ${tasks.length ? html`<h2>Waiting for you</h2>${await Promise.all(tasks.map(taskCard))}` : ""}
      ${await clientPanels(c)}
      <div class="grid-2">
        <div class="panel"><h2>What they told us</h2>
          ${Object.keys(intake).length ? html`<table>${product.intake.map((f) => html`<tr><td class="muted">${f.label}</td><td style="white-space:pre-wrap">${intake[f.key]}</td></tr>`)}</table>` : empty("They haven't filled in their form yet.")}
        </div>
        <div class="panel"><h2>Notes and drafts</h2>
          ${saved.length ? saved.map(([k, v]) => html`<h3>${k.replace(/_/g, " ")}</h3><div class="pre small">${typeof v === "string" ? v : JSON.stringify(v, null, 2)}</div>`) : empty("Nothing yet.")}
        </div>
      </div>
      <div class="panel"><h2>Regular work for them</h2>
        ${deliveries.length ? html`<table><tr><th>What</th><th>For</th><th>Status</th><th></th></tr>${deliveries.map((d) => html`<tr>
          <td>${product.routines.find((r) => r.key === d.routine)?.title ?? d.routine}${d.last_error ? html`<div class="small" style="color:var(--bad)">${d.last_error}</div>` : ""}</td>
          <td>${d.period}</td><td>${chip(d.status)}</td>
          <td>${d.status === "failed" ? html`<form method="post" action="/customers/${c.id}/deliveries/${d.id}/retry" class="inline"><button class="small">Try again</button></form>` : ""}</td></tr>`)}</table>` : empty("This starts once they're live.")}
      </div>
      <div class="grid-2">
        <div class="panel"><h2>Emails to them</h2>${emails.length ? html`<table>${emails.map((e) => html`<tr><td>${e.subject}<div class="small muted">${ago(e.created_at)}</div></td><td>${chip(e.status)}</td></tr>`)}</table>` : empty("None yet.")}</div>
        <div class="panel"><h2>History</h2>${events.length ? html`<table>${events.map((e) => html`<tr><td>${e.message}<div class="small muted">${fmtDate(e.at, true)}</div></td></tr>`)}</table>` : empty("None yet.")}</div>
      </div>`;
    return send(reply, req, c.business || c.email, body, "/customers");
  });

  app.post<{ Params: { id: string; stepId: string } }>("/customers/:id/steps/:stepId/retry", async (req, reply) => {
    await retryStep(req.params.stepId);
    return back(reply, `/customers/${req.params.id}`, "Trying that step again now.");
  });

  app.post<{ Params: { id: string; stepId: string } }>("/customers/:id/steps/:stepId/skip", async (req, reply) => {
    await skipStep(req.params.stepId);
    return back(reply, `/customers/${req.params.id}`, "Skipped that step.");
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/customers/:id/status", async (req, reply) => {
    const status = req.body?.status;
    if (status !== "active" && status !== "paused" && status !== "cancelled") return reply.code(400).send("Bad status");
    await setCustomerStatus(req.params.id, status);
    return back(reply, `/customers/${req.params.id}`, status === "cancelled" ? "Marked as left and all work for them has stopped. If they pay by card, also cancel their subscription in Stripe." : "Updated.");
  });

  app.post<{ Params: { id: string; deliveryId: string } }>("/customers/:id/deliveries/:deliveryId/retry", async (req, reply) => {
    await retryDelivery(req.params.deliveryId);
    return back(reply, `/customers/${req.params.id}`, "Trying again now.");
  });

  // Leads -----------------------------------------------------------------
  app.get<{ Querystring: { product?: string; status?: string } }>("/leads", async (req, reply) => {
    const rows = await query(
      `SELECT * FROM leads WHERE ($1::text IS NULL OR product = $1) AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 300`,
      [req.query.product || null, req.query.status || null],
    );
    const statuses = ["new", "contacted", "followed_up", "replied", "won", "lost", "unsubscribed"];
    const body = html`<div class="spread"><h1>Enquiries</h1>
      <form class="row" method="get">
        <label for="l-product" class="sr-only">Product</label>
        <select name="product" id="l-product" style="width:auto"><option value="">All products</option>${products.map((p) => html`<option value="${p.slug}" ${req.query.product === p.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <label for="l-status" class="sr-only">Status</label>
        <select name="status" id="l-status" style="width:auto"><option value="">Any status</option>${statuses.map((s) => html`<option value="${s}" ${req.query.status === s ? "selected" : ""}>${statusLabel(s)}</option>`)}</select>
        <button>Show</button></form></div>
      ${intro("People who've filled in a form on one of the websites, or replied to a cold email. Each one gets a reply within a few minutes, then a couple of friendly follow-ups.")}
      <div class="panel">${rows.length ? leadsTable(rows, true) : empty(req.query.product || req.query.status ? "No enquiries match those choices." : "No enquiries yet.")}</div>`;
    return send(reply, req, "Leads", body, "/leads");
  });

  app.get<{ Params: { id: string } }>("/leads/:id", async (req, reply) => {
    const l = await one(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
    if (!l) return reply.code(404).send("Not found");
    const emails = await query(`SELECT * FROM emails WHERE lead_id = $1 ORDER BY created_at`, [l.id]);
    const fields = [["Name", l.name], ["Email", l.email], ["Phone", l.phone], ["Business", l.business], ["Website", l.website], ["Town", l.town], ["Message", l.message], ["Source", l.source]];
    const body = html`<div class="spread"><div><h1>${l.business || l.name || l.email}</h1>
        <div class="muted">${productName(l.product)} enquiry, received ${fmtDate(l.created_at, true)}</div></div>${chip(l.status)}</div>
      <div class="grid-2">
        <div class="panel"><h2>Details</h2><table>${fields.filter(([, v]) => v).map(([k, v]) => html`<tr><td class="muted">${k}</td><td style="white-space:pre-wrap">${v}</td></tr>`)}
          ${Object.entries(l.data ?? {}).map(([k, v]) => html`<tr><td class="muted">${k}</td><td>${String(v)}</td></tr>`)}</table>
          <form method="post" action="/leads/${l.id}/status" class="row" style="margin-top:12px">
            <button name="status" value="lost">They're not interested</button>
            <button name="status" value="unsubscribed">They asked us to stop</button>
            ${l.next_touch_at ? html`<span class="small muted">Next follow-up: ${fmtDate(l.next_touch_at, true)}</span>` : ""}
          </form></div>
        <div class="panel"><h2>Emails</h2>${emails.length ? emails.map((e) => html`<h3>${e.subject} ${chip(e.status)}</h3><div class="pre small">${e.body_text}</div>`) : empty("None yet. A reply is written within about five minutes of the enquiry.")}</div>
      </div>`;
    return send(reply, req, "Lead", body, "/leads");
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/leads/:id/status", async (req, reply) => {
    const status = req.body?.status;
    if (status === "unsubscribed") {
      const lead = await one(`SELECT email FROM leads WHERE id = $1`, [req.params.id]);
      if (lead?.email) await suppress(lead.email, "Asked to stop (marked by hand)");
    }
    if (status === "lost" || status === "unsubscribed") {
      await query(`UPDATE leads SET status = $2, next_touch_at = NULL, updated_at = now() WHERE id = $1`, [req.params.id, status]);
      await query(`UPDATE emails SET status = 'cancelled' WHERE lead_id = $1 AND status IN ('draft','queued')`, [req.params.id]);
      await query(`UPDATE tasks SET status = 'dismissed', resolved_at = now() WHERE lead_id = $1 AND status = 'open'`, [req.params.id]);
    }
    return back(reply, `/leads/${req.params.id}`, "Updated. We won't email them again.");
  });

  // Outreach --------------------------------------------------------------
  app.get<{ Querystring: { product?: string } }>("/outreach", async (req, reply) => {
    const product = getProduct(req.query.product ?? "") ?? products[0]!;
    const s = await outreachSettings(product.slug);
    const counts = await query(
      `SELECT status, count(*)::int AS n FROM prospects WHERE product = $1 GROUP BY status`,
      [product.slug],
    );
    const byType = await query(
      `SELECT company_type, count(*)::int AS n FROM prospects WHERE product = $1 AND status IN ('new','in_sequence') GROUP BY company_type`,
      [product.slug],
    );
    const recent = await query(`SELECT * FROM prospects WHERE product = $1 ORDER BY updated_at DESC LIMIT 40`, [product.slug]);
    const sentWeek = await one(
      `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'draft')::int AS drafts
       FROM emails WHERE product = $1 AND kind LIKE 'outreach%' AND created_at > now() - interval '7 days'`,
      [product.slug],
    );
    const replies = await one(
      `SELECT count(*)::int AS n FROM inbound_emails WHERE product = $1 AND prospect_id IS NOT NULL AND received_at > now() - interval '7 days'`,
      [product.slug],
    );
    const n = (st: string) => counts.find((c) => c.status === st)?.n ?? 0;
    const eligible = byType.filter((t) => ["limited", "llp", "plc", "public_sector"].includes(t.company_type) || (s.allowUnknown && t.company_type === "unknown"))
      .reduce((a, t) => a + t.n, 0);
    const excluded = byType.filter((t) => !["limited", "llp", "plc", "public_sector"].includes(t.company_type) && !(s.allowUnknown && t.company_type === "unknown"));

    const body = html`<div class="spread"><h1>Cold emails</h1>
        <form class="row" method="get"><label for="o-product" class="sr-only">Product</label><select name="product" id="o-product" onchange="this.form.submit()" style="width:auto">
          ${products.map((p) => html`<option value="${p.slug}" ${p.slug === product.slug ? "selected" : ""}>${p.name}</option>`)}
        </select></form></div>
      ${intro(html`<p>Short, individually written emails to businesses you've added below. They go out on weekdays between 9 and 5,
        never more than your daily limit. Anyone who replies becomes an enquiry. Anyone who asks us to stop is never emailed again, by any product.</p>`)}
      <div class="grid">
        <div class="stat"><div class="label">Ready to email</div><div class="value">${eligible}</div>
          ${excluded.length ? html`<div class="sub">${excluded.map((t) => `${t.n} ${t.company_type.replace("_", " ")}`).join(", ")} can't be emailed (UK rules)</div>` : ""}</div>
        <div class="stat"><div class="label">Being emailed now</div><div class="value">${n("in_sequence")}</div></div>
        <div class="stat"><div class="label">Sent this week</div><div class="value">${sentWeek?.sent ?? 0}</div>
          <div class="sub">${sentWeek?.drafts ?? 0} waiting for your OK</div></div>
        <div class="stat"><div class="label">Replies this week</div><div class="value">${replies?.n ?? 0}</div></div>
        <div class="stat"><div class="label">Asked us to stop</div><div class="value">${n("suppressed")}</div></div>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>${product.name} settings</h2>
          <form method="post" action="/outreach/${product.slug}/settings">
            <label><input type="checkbox" name="enabled" value="1" ${s.enabled ? "checked" : ""}> Send cold emails for ${product.name}</label>
            <label for="o-cap">Most emails to send in a day</label><input name="dailyCap" id="o-cap" type="number" min="0" max="200" value="${s.dailyCap}">
            <div class="help">This counts first emails and follow-ups together.</div>
            <label for="o-days">Send follow-ups this many days after the first email</label><input name="days" id="o-days" value="${s.days.slice(1).join(", ")}">
            <div class="help">For example "3, 7" sends one follow-up after 3 days and another after 7.</div>
            <label><input type="checkbox" name="allowUnknown" value="1" ${s.allowUnknown ? "checked" : ""}> Also email businesses when we don't know what type of company they are</label>
            <div class="help">Sole traders and partnerships are never cold-emailed, because UK rules (PECR) need their permission first.
              Start at 20 a day or fewer and build up slowly, so emails keep landing in inboxes rather than spam.</div>
            <p><button class="primary">Save</button></p>
          </form></div>
        <div class="panel"><h2>Add people to email</h2>
          <form method="post" action="/outreach/${product.slug}/import">
            <label for="o-csv">Paste a spreadsheet (CSV), including the heading row</label>
            <textarea name="csv" id="o-csv" placeholder="email,first_name,last_name,company,company_type,website,town" required></textarea>
            <div class="help">Useful columns: email, name (or first_name and last_name), company, company_type, website, town.
              Other columns are kept too. If company type is missing, we work it out from "Ltd", "LLP" or "PLC" in the name.</div>
            <label for="o-source">Where this list came from</label><input name="source" id="o-source" placeholder="For example: Apollo, Sept 2026, Stockport electricians">
            <p><button class="primary">Add them</button></p>
          </form></div>
      </div>
      <div class="panel"><h2>People on the list</h2>
        ${recent.length ? html`<table><tr><th>Business</th><th>Type</th><th>Status</th><th class="num">Emails sent</th><th>Next email</th></tr>
          ${recent.map((p) => html`<tr><td>${p.business || p.name || p.email}<div class="small muted">${p.email} · ${p.source}</div></td>
            <td class="small">${p.company_type.replace("_", " ")}</td><td>${chip(p.status)}${p.lead_id ? html` <a class="small" href="/leads/${p.lead_id}">open enquiry</a>` : ""}</td>
            <td class="num">${p.step}</td><td class="small">${p.next_send_at ? fmtDate(p.next_send_at) : ""}</td></tr>`)}</table>` : empty("No one added yet. Paste a list above to get started.")}
      </div>
      <div class="panel"><h2>Never email</h2>
        <p class="small muted">Anyone here is never emailed by any product. People who reply asking us to stop are added automatically.</p>
        <form method="post" action="/outreach/suppress" class="row">
          <label for="o-sup" class="sr-only">Email address or domain</label>
          <input name="value" id="o-sup" placeholder="name@example.com, or @example.com for a whole company" style="max-width:380px" required>
          <label for="o-reason" class="sr-only">Reason</label>
          <input name="reason" id="o-reason" placeholder="Reason (optional)" style="max-width:220px">
          <button>Add</button></form></div>`;
    return send(reply, req, "Outreach", body, "/outreach");
  });

  app.post<{ Params: { slug: string }; Body: Record<string, string> }>("/outreach/:slug/settings", async (req, reply) => {
    const product = requireProduct(req.params.slug);
    const b = req.body ?? {};
    const followUps = String(b.days ?? "").split(/[,\s]+/).map(Number).filter((d) => Number.isFinite(d) && d > 0).sort((a, c) => a - c);
    const cap = Math.max(0, Math.min(200, Number.parseInt(b.dailyCap ?? "20", 10) || 0));
    await setSetting(`outreach:${product.slug}`, { enabled: b.enabled === "1", dailyCap: cap, allowUnknown: b.allowUnknown === "1", days: [0, ...followUps.slice(0, 4)] });
    await logEvent({ type: "outreach.settings", message: `${product.name} outreach ${b.enabled === "1" ? `on, ${cap} a day` : "off"}`, product: product.slug });
    return back(reply, `/outreach?product=${product.slug}`, "Saved.");
  });

  app.post<{ Params: { slug: string }; Body: { csv?: string; source?: string } }>("/outreach/:slug/import", async (req, reply) => {
    const r = await importProspects(req.params.slug, req.body?.csv ?? "", req.body?.source ?? "import");
    return back(reply, `/outreach?product=${req.params.slug}`,
      `Added ${r.added}. Skipped ${r.duplicates} already on the list, ${r.invalid} without a proper email address and ${r.suppressed} on the never-email list.`);
  });

  app.post<{ Body: { value?: string; reason?: string } }>("/outreach/suppress", async (req, reply) => {
    await suppress(req.body?.value ?? "", req.body?.reason || "Added by hand");
    const ref = req.headers.referer;
    return back(reply, ref ? new URL(ref).pathname + new URL(ref).search.replace(/[?&]flash=[^&]*/, "") : "/outreach", "Added. They'll never be emailed.");
  });

  // Activity and system ----------------------------------------------------
  app.get<{ Querystring: { level?: string } }>("/activity", async (req, reply) => {
    const events = await query(
      `SELECT * FROM events WHERE ($1::text IS NULL OR level = $1) ORDER BY at DESC LIMIT 300`,
      [req.query.level || null],
    );
    const body = html`<div class="spread"><h1>What's happened</h1>
        <nav class="row" aria-label="Filter"><a href="/activity">Everything</a><a href="/activity?level=warn">Worth a look</a><a href="/activity?level=error">Problems</a></nav></div>
      ${intro("A diary of everything the system has done, newest first. You don't need to read it. It's here if you ever want to check what happened and when.")}
      <div class="panel">${events.length ? html`<table><tr><th>When</th><th>Product</th><th>What happened</th></tr>${events.map((e) => html`<tr>
        <td class="small muted" style="white-space:nowrap">${fmtDate(e.at, true)}</td><td class="small">${productName(e.product)}</td>
        <td><span class="dot ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok"}"></span>${e.message}
          ${e.customer_id ? html` <a class="small" href="/customers/${e.customer_id}">open customer</a>` : ""}
          ${e.lead_id ? html` <a class="small" href="/leads/${e.lead_id}">open enquiry</a>` : ""}</td></tr>`)}</table>` : empty("Nothing yet.")}</div>`;
    return send(reply, req, "Activity", body, "/activity");
  });

  app.get("/system", async (req, reply) => {
    const lastRuns = await query(`SELECT DISTINCT ON (job) * FROM job_runs ORDER BY job, started_at DESC`);
    const lastOk = await query(`SELECT job, max(started_at) AS at FROM job_runs WHERE status = 'ok' GROUP BY job`);
    const pausedAll = await getSetting<boolean>("paused:all", false);
    const warnings = assertProductionConfig();
    const body = html`<div class="spread"><h1>Automation and connections</h1>
        <form method="post" action="/system/pause">
          ${pausedAll ? html`<span class="chip bad">Everything is paused</span> <button class="primary" name="paused" value="false">Switch everything back on</button>`
                      : html`<button class="danger" name="paused" value="true" onclick="return confirm('Pause everything? No emails or work will go out for any product until you switch it back on.')">Pause everything</button>`}
        </form></div>
      ${intro("This is the engine room. You shouldn't need to come here often: if anything stops working, it shows up on your to-do list. The pause button above is an emergency stop for every product.")}
      ${warnings.length ? html`<div class="flash">${warnings.join("; ")}</div>` : ""}
      <div class="panel"><h2>People who can sign in</h2><p>Give someone their own login with their email address. <a href="/system/team">See and add people</a>.</p></div>
      <div class="panel"><h2>Prospect database</h2><p>The contacts EmailFirst and Good Questions email. <a href="/system/prospects">Upload or update the master prospect file</a>.</p></div>
      <div class="panel"><h2>Regular jobs</h2>
        <table><tr><th>What it does</th><th>How often</th><th>Last ran</th><th>Result</th><th></th></tr>
        ${jobs.map((j) => {
          const r = lastRuns.find((x) => x.job === j.name);
          const ok = lastOk.find((x) => x.job === j.name);
          return html`<tr><td><strong>${j.name}</strong><div class="small muted">${j.description}</div></td>
            <td class="small">${"everyMinutes" in j.schedule ? `every ${j.schedule.everyMinutes} min` : `every day at ${j.schedule.dailyAt}`}</td>
            <td class="small">${r ? ago(r.started_at) : "never"}${ok && r?.status === "error" ? html`<div class="muted">last worked ${ago(ok.at)}</div>` : ""}</td>
            <td>${r ? chip(r.status) : ""}<div class="small muted">${r?.error ?? r?.summary ?? ""}</div></td>
            <td><form method="post" action="/system/jobs/${j.name}/run"><button class="small">Run now</button></form></td></tr>`;
        })}</table></div>
      <div class="panel"><h2>Connections</h2>
        <table><tr><th>Service</th><th>What it's for</th><th>Key name</th><th>Status</th></tr>
        ${integrations.map((i) => html`<tr><td>${i.name}${i.notes ? html`<div class="small muted">${i.notes}</div>` : ""}</td><td class="small">${i.purpose}</td>
          <td class="small"><code>${i.envVars.join(", ")}</code></td>
          <td>${i.configured() ? (i.automation === "full" ? html`<span class="chip ok">Connected</span>` : html`<span class="chip warn">Key added; you get to-dos for now</span>`) : html`<span class="chip bad">Not connected</span>`}</td></tr>`)}
        </table>
        <p class="small muted">Keys are kept as secrets in GitHub and handed to the app each time it's deployed.
          Stripe sends payment updates to <code>${config.baseUrl}/webhooks/stripe</code>.</p></div>`;
    return send(reply, req, "Automation", body, "/system");
  });

  app.post<{ Params: { name: string } }>("/system/jobs/:name/run", async (req, reply) => {
    const job = jobs.find((j) => j.name === req.params.name);
    if (!job) return reply.code(404).send("Unknown job");
    const summary = await runJob(job);
    return back(reply, "/system", summary === null ? `${job.name} is already running, or it hit a problem. See below.` : `Done. ${job.name}: ${summary}`);
  });

  app.post<{ Body: { paused?: string } }>("/system/pause", async (req, reply) => {
    const paused = req.body?.paused === "true";
    await setSetting("paused:all", paused);
    await logEvent({ type: "system.paused", level: "warn", message: `All automation ${paused ? "paused" : "resumed"}` });
    return back(reply, "/system", paused ? "Everything is paused. Nothing will go out until you switch it back on." : "Everything is back on.");
  });

  await clientAdminRoutes(app, send);
  await dataAdminRoutes(app, send);
  await trainingRoutes(app, send);
  await teamRoutes(app, send);
}

function customersTable(rows: CustomerRow[], showProduct = false): Raw {
  return html`<table><tr><th>Customer</th>${showProduct ? html`<th>Product</th>` : ""}<th>Plan</th><th class="num">Pays</th><th>Status</th><th>Joined</th></tr>
    ${rows.map((c) => html`<tr><td><a href="/customers/${c.id}">${c.business || c.name || c.email}</a><div class="small muted">${c.email}</div></td>
      ${showProduct ? html`<td>${productName(c.product)}</td>` : ""}<td>${getPlan(requireProduct(c.product), c.plan)?.name ?? c.plan}</td>
      <td class="num">${formatPrice(c.amount_pence, c.interval)}</td><td>${chip(c.status)}</td><td class="small">${fmtDate(c.created_at)}</td></tr>`)}</table>`;
}

function leadsTable(rows: any[], showProduct = false): Raw {
  return html`<table><tr><th>Enquiry</th>${showProduct ? html`<th>Product</th>` : ""}<th>Status</th><th>Received</th></tr>
    ${rows.map((l) => html`<tr><td><a href="/leads/${l.id}">${l.business || l.name || l.email || l.phone}</a>
      <div class="small muted">${l.email ?? ""} ${l.message ? `· ${String(l.message).slice(0, 90)}` : ""}</div></td>
      ${showProduct ? html`<td>${productName(l.product)}</td>` : ""}<td>${chip(l.status)}</td><td class="small">${ago(l.created_at)}</td></tr>`)}</table>`;
}

