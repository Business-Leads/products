import type { FastifyInstance, FastifyReply } from "fastify";
import { one, query } from "../db/index.js";
import { invoicesFor, postUpdate, replyToSupport, saveMetrics } from "../engine/clients.js";
import type { CustomerRow } from "../engine/types.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { ago, fmtDate } from "../lib/util.js";
import { endAllSessions, ensureClientUser, portalUrl, resetLink, setupLink, userForCustomer } from "../portal/accounts.js";
import { accountPage, dashboardBody, periodLabel, type View } from "../portal/views.js";
import { formatPrice, getProduct, products, requireProduct } from "../products/index.js";
import { html, type Raw } from "./html.js";
import { chip, empty } from "./layout.js";

// HQ pages for managing client logins and support, and the client panels on
// each customer page. Registered inside adminRoutes, so all of it needs the
// HQ password.

function back(reply: FastifyReply, to: string, flash?: string) {
  const sep = to.includes("?") ? "&" : "?";
  return reply.redirect(flash ? `${to}${sep}flash=${encodeURIComponent(flash)}` : to, 303);
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Client login, dashboard figures, updates, support and invoices for one customer. */
export async function clientPanels(c: CustomerRow): Promise<Raw> {
  const product = requireProduct(c.product);
  const user = await userForCustomer(c);
  const support = await query(`SELECT * FROM support_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [c.id]);
  const updates = await query(`SELECT * FROM client_updates WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [c.id]);
  const invoices = await invoicesFor(c);
  const latest = (c.data.metrics_history ?? []).slice(-1)[0];
  const approvable = product.onboarding.filter((s) => s.kind !== "auto" && product.portal.steps[s.key]);

  return html`
    <div class="grid-2">
      <div class="panel"><h2>Client account</h2>
        <table>
          <tr><td class="muted">Sign-in</td><td>${user?.email ?? c.email}</td></tr>
          <tr><td class="muted">Password</td><td>${user?.password_hash ? html`set ${fmtDate(user.password_set_at)}` : html`<span class="chip warn">not set yet</span>`}</td></tr>
          <tr><td class="muted">Last signed in</td><td>${user?.last_login_at ? ago(user.last_login_at) : "never"}</td></tr>
          <tr><td class="muted">Status</td><td>${user?.disabled ? html`<span class="chip bad">disabled</span>` : user?.locked_until && new Date(user.locked_until) > new Date() ? html`<span class="chip warn">locked (too many attempts)</span>` : html`<span class="chip ok">active</span>`}</td></tr>
          <tr><td class="muted">Account area</td><td><a href="${portalUrl(product)}/login" target="_blank" rel="noopener">${portalUrl(product)}</a></td></tr>
        </table>
        <div class="row" style="margin-top:12px">
          <a class="btn primary" href="/customers/${c.id}/dashboard">View their dashboard</a>
          <form method="post" action="/customers/${c.id}/login/invite" class="inline"><button class="small">${user?.password_hash ? "Email a password reset link" : "Email a link to set a password"}</button></form>
          ${user ? html`<form method="post" action="/customers/${c.id}/login/${user.disabled ? "enable" : "disable"}" class="inline"><button class="small ${user.disabled ? "" : "danger"}">${user.disabled ? "Enable login" : "Disable login"}</button></form>
            <form method="post" action="/customers/${c.id}/login/signout" class="inline"><button class="small">Sign them out everywhere</button></form>` : ""}
        </div>
      </div>
      <div class="panel"><h2>Dashboard figures</h2>
        <p class="small muted">Filled in automatically from reports. Correct or add figures here; they show on the client's dashboard.</p>
        <form method="post" action="/customers/${c.id}/metrics">
          <label for="period">Period</label><input name="period" id="period" value="${latest?.period ?? thisMonth()}" pattern="\\d{4}-\\d{2}(-\\d{2})?" required>
          ${product.portal.metrics.map((m) => html`<label for="m_${m.key}">${m.label}</label><input name="m_${m.key}" id="m_${m.key}" inputmode="decimal" value="${latest?.values?.[m.key] ?? ""}">`)}
          <p style="margin-top:12px"><button class="small">Save figures</button></p>
        </form>
      </div>
    </div>
    ${product.slug === "linkn" ? html`<div class="panel"><h2>Sbl.so campaigns</h2>
      <p class="small muted">Campaign ids for this client. Events Sbl.so sends for these campaigns (replies, accepted connections) are counted on their dashboard, and replies come to your inbox.</p>
      <form method="post" action="/customers/${c.id}/sbl" class="row">
        <input name="campaigns" value="${(c.data.sbl_campaign_ids ?? []).join(", ")}" placeholder="campaign id, another id" style="flex:1">
        <button class="small">Save</button></form></div>` : ""}
    <div class="grid-2">
      <div class="panel"><h2>Post an update to their dashboard</h2>
        <form method="post" action="/customers/${c.id}/updates">
          <label for="u_title">Title</label><input name="title" id="u_title" placeholder="Your website preview is ready" required>
          <label for="u_body">Message</label><textarea name="body" id="u_body"></textarea>
          <label for="u_link">Link <span class="muted">(optional, e.g. a preview)</span></label><input name="link" id="u_link" type="url">
          <label for="u_step">Ask them to approve <span class="muted">(optional)</span></label>
          <select name="approval_step" id="u_step"><option value="">No approval needed</option>
            ${approvable.map((s) => html`<option value="${s.key}">${product.portal.steps[s.key]}</option>`)}</select>
          <div class="help">When they approve, that onboarding step completes and setup carries on by itself.</div>
          <p style="margin-top:12px"><button class="small">Post and email them</button></p>
        </form>
        ${updates.length ? html`<table style="margin-top:12px">${updates.map((u) => html`<tr><td>${u.title}<div class="small muted">${fmtDate(u.created_at, true)}</div></td>
          <td>${u.approval_step ? (u.response ? chip(u.response === "approved" ? "approved" : "changes requested") : chip("waiting")) : ""}${u.response_note ? html`<div class="small">${u.response_note}</div>` : ""}</td></tr>`)}</table>` : ""}
      </div>
      <div class="panel"><h2>Support requests</h2>
        ${support.length ? support.map((r) => html`<div class="panel" style="box-shadow:none"><div class="spread"><strong>${r.subject}</strong>${chip(r.status)}</div>
            <div class="small muted">${fmtDate(r.created_at, true)}</div><div class="pre small">${r.message}</div>
            ${r.reply ? html`<div class="small" style="margin-top:6px"><strong>Reply:</strong> ${r.reply}</div>` : html`<p><a href="/support#r${r.id}">Reply</a></p>`}</div>`)
          : empty("None.")}
        <h2 style="margin-top:16px">Invoices</h2>
        ${invoices.length ? html`<table>${invoices.map((i) => html`<tr><td>${fmtDate(i.issued_at)}</td><td>${i.number ?? i.id}</td><td class="num">${formatPrice(i.amount_pence)}</td><td>${chip(i.status === "paid" ? "done" : i.status)}</td>
            <td>${i.hosted_url ? html`<a href="${i.hosted_url}" target="_blank" rel="noopener">view</a>` : ""}</td></tr>`)}</table>` : empty("None recorded yet.")}
      </div>
    </div>`;
}

export async function clientAdminRoutes(app: FastifyInstance, send: (reply: FastifyReply, req: any, title: string, body: Raw, active: string) => Promise<unknown>) {
  // Every client login across all product sites.
  app.get<{ Querystring: { product?: string; q?: string } }>("/clients", async (req, reply) => {
    const rows = await query(
      `SELECT u.*, c.id AS customer_id, c.business, c.name, c.status, c.plan, c.created_at AS signed_up
       FROM client_users u
       LEFT JOIN LATERAL (SELECT * FROM customers c WHERE c.product = u.product AND lower(c.email) = lower(u.email)
                          ORDER BY (c.status <> 'cancelled') DESC, c.created_at DESC LIMIT 1) c ON true
       WHERE ($1::text IS NULL OR u.product = $1)
         AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%' OR c.business ILIKE '%' || $2 || '%')
       ORDER BY u.created_at DESC LIMIT 500`,
      [req.query.product || null, req.query.q || null],
    );
    const body = html`
      <h1>Client accounts</h1>
      <p class="muted">Every client login on every product site. Open a client to view their dashboard exactly as they see it, send a password link, or disable their login.</p>
      <form class="row" style="margin-bottom:14px">
        <select name="product" style="width:auto"><option value="">All products</option>${products.map((p) => html`<option value="${p.slug}" ${req.query.product === p.slug ? "selected" : ""}>${p.name}</option>`)}</select>
        <input name="q" value="${req.query.q ?? ""}" placeholder="Email or business" style="width:auto">
        <button class="small">Filter</button></form>
      <div class="panel">${rows.length
        ? html`<table><tr><th>Client</th><th>Product</th><th>Subscription</th><th>Login</th><th>Last signed in</th></tr>
          ${rows.map((r) => html`<tr>
            <td>${r.customer_id ? html`<a href="/customers/${r.customer_id}">${r.business || r.name || r.email}</a>` : r.email}<div class="small muted">${r.email}</div></td>
            <td>${getProduct(r.product)?.name ?? r.product}</td>
            <td>${r.status ? chip(r.status) : ""}</td>
            <td>${r.disabled ? html`<span class="chip bad">disabled</span>` : r.password_hash ? html`<span class="chip ok">active</span>` : html`<span class="chip warn">password not set</span>`}</td>
            <td>${r.last_login_at ? ago(r.last_login_at) : "never"}</td></tr>`)}</table>`
        : empty("No client accounts yet. One is created for every new customer.")}</div>`;
    return send(reply, req, "Client accounts", body, "/clients");
  });

  // The client's dashboard exactly as they see it, read only.
  app.get<{ Params: { id: string } }>("/customers/:id/dashboard", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return reply.code(404).send("Not found");
    const product = requireProduct(c.product);
    const user = (await userForCustomer(c)) ?? (await ensureClientUser(c));
    const v: View = { product, base: `/portal/${product.slug}`, user, customer: c, readOnly: true };
    return reply.type("text/html").header("Cache-Control", "no-store").send(accountPage(v, "Dashboard", html`
      <p class="small"><a href="/customers/${c.id}">← Back to HQ</a></p>${await dashboardBody(v, c)}`, "/"));
  });

  app.post<{ Params: { id: string } }>("/customers/:id/login/invite", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return reply.code(404).send("Not found");
    const product = requireProduct(c.product);
    const user = await ensureClientUser(c);
    const link = user.password_hash ? await resetLink(user) : await setupLink(c);
    await queueEmail({
      product: product.slug,
      customerId: c.id,
      kind: "account_link",
      to: user.email,
      subject: user.password_hash ? `Reset your ${product.name} password` : `Your ${product.name} account`,
      body: user.password_hash
        ? `Hello,\n\nUse this link to choose a new password for your ${product.name} account. It works once and expires in two hours:\n\n${link}\n\nFelix`
        : `Hello,\n\nYour ${product.name} account is where you can follow progress, see reports and download invoices. Create your password here:\n\n${link}\n\nAfter that you can sign in at ${portalUrl(product)}\n\nFelix`,
    });
    await logEvent({ type: "client.link_sent", message: `Account link emailed to ${user.email}`, product: product.slug, customerId: c.id });
    return back(reply, `/customers/${c.id}`, "Link emailed to the client.");
  });

  app.post<{ Params: { id: string; action: string } }>("/customers/:id/login/:action", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    const user = c && (await userForCustomer(c));
    if (!c || !user) return reply.code(404).send("Not found");
    const action = req.params.action;
    if (action === "disable" || action === "enable") {
      await query(`UPDATE client_users SET disabled = $2 WHERE id = $1`, [user.id, action === "disable"]);
      if (action === "disable") await endAllSessions(user.id);
    } else if (action === "signout") {
      await endAllSessions(user.id);
    } else {
      return reply.code(400).send("Unknown action");
    }
    await logEvent({ type: `client.${action}`, message: `${action} login for ${user.email}`, product: c.product, customerId: c.id });
    return back(reply, `/customers/${c.id}`, "Done.");
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>("/customers/:id/metrics", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return reply.code(404).send("Not found");
    const product = requireProduct(c.product);
    const period = String(req.body?.period ?? "").trim();
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) return back(reply, `/customers/${c.id}`, "Period should look like 2026-10.");
    const values: Record<string, number | null> = {};
    for (const m of product.portal.metrics) {
      const raw = String(req.body?.[`m_${m.key}`] ?? "").replace(/[,£%\s]/g, "");
      values[m.key] = raw === "" ? null : Number(raw);
    }
    await saveMetrics(c.id, period, values);
    return back(reply, `/customers/${c.id}`, `Figures for ${periodLabel(period)} saved.`);
  });

  app.post<{ Params: { id: string }; Body: { campaigns?: string } }>("/customers/:id/sbl", async (req, reply) => {
    const ids = String(req.body?.campaigns ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    await query(`UPDATE customers SET data = data || jsonb_build_object('sbl_campaign_ids', $2::jsonb), updated_at = now() WHERE id = $1 AND product = 'linkn'`, [
      req.params.id,
      JSON.stringify(ids),
    ]);
    // Link anything already received for these campaigns.
    await query(`UPDATE sbl_events SET customer_id = $1 WHERE customer_id IS NULL AND campaign_id = ANY($2::text[])`, [req.params.id, ids]);
    return back(reply, `/customers/${req.params.id}`, "Sbl.so campaigns saved.");
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>("/customers/:id/updates", async (req, reply) => {
    const c = await one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return reply.code(404).send("Not found");
    const title = String(req.body?.title ?? "").trim();
    if (!title) return back(reply, `/customers/${c.id}`, "A title is needed.");
    const link = String(req.body?.link ?? "").trim();
    if (link && !/^https?:\/\//.test(link)) return back(reply, `/customers/${c.id}`, "Links must start with http:// or https://");
    const product = requireProduct(c.product);
    const step = String(req.body?.approval_step ?? "");
    await postUpdate(c, {
      title,
      body: String(req.body?.body ?? "").trim(),
      link,
      approvalStep: product.onboarding.some((s) => s.key === step) ? step : undefined,
    });
    return back(reply, `/customers/${c.id}`, "Posted to their dashboard and emailed.");
  });

  // Support requests from every product site.
  app.get<{ Querystring: { all?: string } }>("/support", async (req, reply) => {
    const rows = await query(
      `SELECT s.*, c.business, c.name, c.email FROM support_requests s JOIN customers c ON c.id = s.customer_id
       WHERE ($1::boolean OR s.status = 'open') ORDER BY s.created_at DESC LIMIT 200`,
      [req.query.all === "1"],
    );
    const body = html`
      <div class="spread"><h1>Support</h1><a href="/support${req.query.all === "1" ? "" : "?all=1"}">${req.query.all === "1" ? "Show open only" : "Show all"}</a></div>
      ${rows.length
        ? rows.map((r) => html`<div class="panel" id="r${r.id}">
            <div class="spread"><h3>${r.subject}</h3>${chip(r.status)}</div>
            <div class="small muted"><a href="/customers/${r.customer_id}">${r.business || r.name || r.email}</a> · ${getProduct(r.product)?.name ?? r.product} · ${fmtDate(r.created_at, true)}</div>
            <div class="pre" style="margin:10px 0">${r.message}</div>
            ${r.reply
              ? html`<div class="small"><strong>Replied ${fmtDate(r.replied_at, true)}:</strong><div class="pre">${r.reply}</div></div>`
              : html`<form method="post" action="/support/${r.id}/reply">
                  <textarea name="reply" placeholder="Your reply. It's emailed from ${getProduct(r.product)?.name ?? "the product"} and shown in their account." required></textarea>
                  <p class="row"><button class="primary">Send reply</button></p></form>
                <form method="post" action="/support/${r.id}/close" class="inline"><button class="small">Close without replying</button></form>`}
          </div>`)
        : empty(req.query.all === "1" ? "No support requests yet." : "Nothing open. New requests are emailed to you and appear here.")}`;
    return send(reply, req, "Support", body, "/support");
  });

  app.post<{ Params: { id: string }; Body: { reply?: string } }>("/support/:id/reply", async (req, reply) => {
    const text = String(req.body?.reply ?? "").trim();
    if (!text) return back(reply, "/support", "Write a reply first.");
    await replyToSupport(req.params.id, text);
    return back(reply, "/support", "Reply sent.");
  });

  app.post<{ Params: { id: string } }>("/support/:id/close", async (req, reply) => {
    const r = await one(`UPDATE support_requests SET status = 'closed' WHERE id = $1 RETURNING *`, [req.params.id]);
    if (r?.task_id) await query(`UPDATE tasks SET status = 'dismissed', resolution = 'Closed', resolved_at = now() WHERE id = $1 AND status = 'open'`, [r.task_id]);
    return back(reply, "/support", "Closed.");
  });
}
