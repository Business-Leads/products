import { one, query } from "../db/index.js";
import { upgradeOptions, type MetricsSnapshot } from "../engine/clients.js";
import type { CustomerRow } from "../engine/types.js";
import { fmtDate } from "../lib/util.js";
import { bookingLink, formatPrice, getPlan, type Product } from "../products/index.js";
import { html, raw, type Raw } from "../web/html.js";
import type { ClientUser } from "./accounts.js";

// Pages for a client's account area. Everything is labelled in the product's
// own terms: no tool or supplier names, and nothing about the other products.

export interface View {
  product: Product;
  /** Path prefix for links: "" on the product's own domain, /portal/<slug> otherwise. */
  base: string;
  user?: ClientUser;
  customer?: CustomerRow;
  /** Set when the operator is looking at a client's account from HQ. */
  readOnly?: boolean;
}

const statusLabels: Record<string, [string, string]> = {
  onboarding: ["Setting up", "accent"],
  active: ["Live", "ok"],
  past_due: ["Payment overdue", "warn"],
  paused: ["Paused", "bad"],
  cancelled: ["Ended", "bad"],
};

export function statusChip(status: string): Raw {
  const [label, tone] = statusLabels[status] ?? [status, ""];
  return html`<span class="chip ${tone}">${label}</span>`;
}

function shell(v: View, title: string, body: Raw, active?: string): string {
  const { product, base } = v;
  const link = (href: string, label: string) => html`<a href="${base}${href}" class="${active === href ? "active" : ""}">${label}</a>`;
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${product.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Urbanist:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/static/app.css">
<style>:root { --accent: ${raw(safeColour(product.portal.accent))}; }</style>
</head>
<body>
${v.readOnly ? html`<div class="readonly-banner">You're viewing this client's account as they see it (read only).</div>` : ""}
<header class="portal-top"><div class="inner">
  <a class="name" href="${product.siteUrls[0] ?? base + "/"}">${product.name}</a>
  ${v.user
    ? html`<nav>${link("/", "Dashboard")}${link("/billing", "Billing")}${link("/support", "Contact us")}${link("/account", "Account")}
        <form method="post" action="${base}/logout" class="inline"><button class="small">Sign out</button></form></nav>`
    : html`<nav><a href="${product.siteUrls[0] ?? "/"}">Back to ${product.name}</a></nav>`}
</div></header>
${body}
<footer class="portal-foot">${product.entity}</footer>
</body>
</html>`.value;
}

function safeColour(c: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : "#ff6a4d";
}

/** A page inside the signed-in account. */
export function accountPage(v: View, title: string, body: Raw, active?: string, flash?: string): string {
  return shell(v, title, html`<main class="portal-main">${flash ? html`<div class="flash">${flash}</div>` : ""}${body}</main>`, active);
}

/** Sign-in, password and other pages shown before signing in. */
export function narrowPage(v: View, title: string, body: Raw): string {
  return shell({ ...v, user: undefined }, title, html`<main class="portal-narrow"><div class="panel">${body}</div></main>`);
}

// ------------------------------------------------------------- dashboard

export function firstName(c: CustomerRow): string {
  return (c.name ?? "").split(/\s+/)[0] ?? "";
}

/** The single next thing the client should do, if any. */
export function nextAction(v: View, c: CustomerRow, pendingApproval?: { id: string; title: string }): Raw | null {
  const { base, product } = v;
  const box = (title: string, text: string, href: string, label: string) =>
    html`<div class="panel next"><h2>${title}</h2><p>${text}</p><a class="btn primary" href="${href}">${label}</a></div>`;
  if (c.status === "cancelled") {
    return html`<div class="panel next"><h2>Your subscription has ended</h2><p>Your invoices are still available under Billing.
      If you'd like to come back, <a href="${product.siteUrls[0] ?? "/"}">you can sign up again</a>.</p></div>`;
  }
  if (c.status === "past_due" || c.status === "paused") {
    return box("Your latest payment didn't go through", c.status === "paused"
      ? "We've paused the service until it's paid. Everything restarts automatically once it is."
      : "Please update your card so the service carries on.", `${base}/billing`, "Pay now");
  }
  if (product.bookingAfterPurchase && !c.data.call_booked_at) {
    return box("Book your onboarding call", "A short call with Felix so everything is right from the start.", `${base}/book`, "Choose a time");
  }
  if (!c.data.intake_completed_at && product.intake.length) {
    return box("Tell us about your business", "A few details so we can set everything up. It takes about five minutes.", `${base}/details`, "Fill in the form");
  }
  if (pendingApproval) {
    return box("Ready for you to review", pendingApproval.title, `${base}/updates/${pendingApproval.id}`, "Review it");
  }
  if (c.data.cancel_at) {
    return html`<div class="panel next"><h2>Your subscription ends on ${fmtDate(c.data.cancel_at)}</h2>
      <p>Everything carries on until then. Changed your mind?</p><a class="btn primary" href="${base}/billing">Keep my subscription</a></div>`;
  }
  return null;
}

export async function timeline(v: View, c: CustomerRow): Promise<Raw> {
  const steps = await query(`SELECT * FROM onboarding_steps WHERE customer_id = $1 AND status <> 'skipped' ORDER BY position`, [c.id]);
  const visible = steps.filter((s) => v.product.portal.steps[s.key]);
  if (!visible.length) return html`<p class="muted">We'll show each stage of your setup here.</p>`;
  const firstOpen = visible.findIndex((s) => s.status !== "done");
  return html`<ul class="timeline">
    <li class="done"><span class="mark"></span><strong>Signed up</strong><div class="small muted">${fmtDate(c.created_at)}</div></li>
    ${visible.map((s, i) => {
      const state = s.status === "done" ? "done" : i === firstOpen ? "current" : "upcoming";
      const note =
        state === "done"
          ? fmtDate(s.completed_at)
          : state === "current"
            ? s.kind === "customer" ? "Waiting on you" : "In progress"
            : "Coming up";
      return html`<li class="${state}"><span class="mark"></span><strong>${v.product.portal.steps[s.key]}</strong>
        <div class="small muted">${note}</div></li>`;
    })}
  </ul>`;
}

function metricValue(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

export function metricsTiles(v: View, c: CustomerRow): Raw {
  const history: MetricsSnapshot[] = c.data.metrics_history ?? [];
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (!latest) {
    return html`<p class="muted">Your first figures will appear here with your first report.</p>`;
  }
  const tiles = v.product.portal.metrics.filter((m) => latest.values[m.key] !== undefined);
  return html`<div class="grid">${tiles.map((m) => {
      const now = latest.values[m.key]!;
      const before = previous?.values[m.key];
      const delta = before === undefined ? null : now - before;
      return html`<div class="stat"><div class="label">${m.label}</div><div class="value">${metricValue(now)}</div>
        ${delta === null || delta === 0 ? html`<div class="sub">${periodLabel(latest.period)}</div>`
          : html`<div class="sub"><span class="delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${metricValue(delta)}</span> on ${periodLabel(previous!.period)}</div>`}</div>`;
    })}</div>
    ${history.length > 1
      ? html`<details><summary class="small muted">Earlier figures</summary><table><tr><th>Period</th>${tiles.map((m) => html`<th class="num">${m.label}</th>`)}</tr>
        ${[...history].reverse().map((h) => html`<tr><td>${periodLabel(h.period)}</td>${tiles.map((m) => html`<td class="num">${h.values[m.key] === undefined ? "" : metricValue(h.values[m.key]!)}</td>`)}</tr>`)}</table></details>`
      : ""}`;
}

export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(period) ? new Date(`${period}T12:00:00Z`) : null;
  return d ? `week of ${fmtDate(d)}` : period;
}

export interface FeedItem {
  at: Date;
  title: string;
  text?: string;
  href?: string;
  badge?: string;
}

/** Reports delivered and updates posted, newest first. */
export async function feed(v: View, c: CustomerRow, limit = 12): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  const deliveries = await query(
    `SELECT * FROM deliveries WHERE customer_id = $1 AND status = 'delivered' ORDER BY delivered_at DESC LIMIT $2`,
    [c.id, limit],
  );
  for (const d of deliveries) {
    const label = v.product.portal.routines[d.routine];
    if (!label) continue;
    const hasContent = Boolean(d.content?.body || d.content?.post);
    items.push({
      at: d.delivered_at,
      title: `${label}: ${periodLabel(d.period)}`,
      text: d.content?.subject,
      href: hasContent ? `${v.base}/reports/${d.id}` : undefined,
    });
  }
  const updates = await query(`SELECT * FROM client_updates WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`, [c.id, limit]);
  for (const u of updates) {
    items.push({
      at: u.created_at,
      title: u.title,
      text: u.body,
      href: `${v.base}/updates/${u.id}`,
      badge: u.approval_step ? (u.response === "approved" ? "Approved" : u.response === "changes" ? "Changes requested" : "Needs your review") : undefined,
    });
  }
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
}

export function feedList(items: FeedItem[]): Raw {
  if (!items.length) return html`<p class="muted">Reports and updates will appear here as we deliver them.</p>`;
  return html`${items.map(
    (i) => html`<div class="feed-item"><div class="spread"><strong>${i.href ? html`<a href="${i.href}">${i.title}</a>` : i.title}</strong>
      <span class="row">${i.badge ? html`<span class="chip ${i.badge === "Needs your review" ? "accent" : ""}">${i.badge}</span>` : ""}<span class="small muted">${fmtDate(i.at)}</span></span></div>
      ${i.text ? html`<div class="small muted">${i.text.length > 180 ? i.text.slice(0, 180) + "…" : i.text}</div>` : ""}</div>`,
  )}`;
}

export function accountSummary(v: View, c: CustomerRow): Raw {
  const plan = getPlan(v.product, c.plan);
  const upgrades = upgradeOptions(c);
  return html`<table>
    <tr><td class="muted">Plan</td><td>${plan?.name ?? c.plan}</td></tr>
    <tr><td class="muted">Price</td><td>${c.amount_pence ? formatPrice(c.amount_pence, c.interval) : "As agreed"}</td></tr>
    <tr><td class="muted">Status</td><td>${statusChip(c.status)}${c.data.cancel_at ? html` <span class="small muted">ends ${fmtDate(c.data.cancel_at)}</span>` : ""}</td></tr>
    <tr><td class="muted">Member since</td><td>${fmtDate(c.created_at)}</td></tr>
    ${c.activated_at ? html`<tr><td class="muted">Live since</td><td>${fmtDate(c.activated_at)}</td></tr>` : ""}
    ${v.product.bookingAfterPurchase
      ? html`<tr><td class="muted">Onboarding call</td><td>${c.data.call_booked_at ? "Booked" : html`<a href="${v.base}/book">Book now</a>`}</td></tr>`
      : ""}
  </table>
  ${upgrades.length && c.status !== "cancelled" ? html`<p class="small" style="margin-top:12px"><a href="${v.base}/billing">Upgrade to ${upgrades.map((p) => p.name).join(" or ")}</a></p>` : ""}`;
}

export async function dashboardBody(v: View, c: CustomerRow): Promise<Raw> {
  const pending = await one<{ id: string; title: string }>(
    `SELECT id, title FROM client_updates WHERE customer_id = $1 AND approval_step IS NOT NULL AND response IS NULL ORDER BY created_at DESC LIMIT 1`,
    [c.id],
  );
  const next = nextAction(v, c, pending);
  return html`
    <div class="spread" style="margin-bottom:18px"><div><h1>${firstName(c) ? `Hello ${firstName(c)}` : "Your account"}</h1>
      <div class="muted">${c.business ?? c.email}</div></div>${statusChip(c.status)}</div>
    ${next ?? ""}
    <div class="panel"><h2>${v.product.portal.resultsTitle}</h2><p class="small muted">${v.product.portal.resultsIntro}</p>${metricsTiles(v, c)}</div>
    <div class="grid-2">
      <div class="panel"><h2>Progress</h2>${await timeline(v, c)}</div>
      <div>
        <div class="panel"><h2>Your account</h2>${accountSummary(v, c)}</div>
        <div class="panel"><h2>Reports and updates</h2>${feedList(await feed(v, c))}</div>
      </div>
    </div>`;
}

/** JSON that is safe inside a <script> element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function bookingWidget(v: View, c: CustomerRow): Raw {
  const link = new URL(bookingLink(v.product, c.name, c.email, "onboarding", c.id));
  const done = `fetch(${JSON.stringify(`${v.base}/book/done`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin" })` +
    `.finally(function () { window.location.href = ${JSON.stringify(`${v.base}/`)}; });`;
  if (link.hostname === "cal.com") {
    const calLink = link.pathname.replace(/^\//, "");
    const prefill: Record<string, string> = {};
    link.searchParams.forEach((value, key) => { prefill[key] = value; });
    // Cal.com's own inline embed; HQ also hears about the booking from Cal.com directly.
    return html`<div id="cal-booking" class="booking-widget"></div>
      <script>
        (function (C, A, L) { var p = function (a, ar) { a.q.push(ar); }; var d = C.document; C.Cal = C.Cal || function () { var cal = C.Cal; var ar = arguments; if (!cal.loaded) { cal.ns = {}; cal.q = cal.q || []; d.head.appendChild(d.createElement("script")).src = A; cal.loaded = true; } if (ar[0] === L) { var api = function () { p(api, arguments); }; var namespace = ar[1]; api.q = api.q || []; if (typeof namespace === "string") { cal.ns[namespace] = cal.ns[namespace] || api; p(cal.ns[namespace], ar); p(cal, ["initNamespace", namespace]); } else p(cal, ar); return; } p(cal, ar); }; })(window, "https://app.cal.com/embed/embed.js", "init");
        Cal("init", { origin: "https://cal.com" });
        Cal("inline", { elementOrSelector: "#cal-booking", calLink: ${raw(safeJson(calLink))}, config: ${raw(safeJson(prefill))} });
        Cal("on", { action: "bookingSuccessful", callback: function () { ${raw(done)} } });
      </script>`;
  }
  link.searchParams.set("hide_gdpr_banner", "1");
  return html`<div class="calendly-inline-widget" data-url="${link.toString()}"></div>
    <script src="https://assets.calendly.com/assets/external/widget.js" async></script>
    <script>
      window.addEventListener("message", function (e) {
        if (e.origin !== "https://calendly.com" || !e.data || e.data.event !== "calendly.event_scheduled") return;
        ${raw(done)}
      });
    </script>`;
}
