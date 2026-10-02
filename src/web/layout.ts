import { config } from "../config.js";
import { products } from "../products/index.js";
import { html, raw, type Raw } from "./html.js";

export interface NavCounts {
  inbox: number;
  support?: number;
}

const FONTS = html`<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=Urbanist:wght@400..700&display=swap">`;

export function page(title: string, body: Raw, opts: { active?: string; counts?: NavCounts; flash?: string } = {}): string {
  const link = (href: string, label: string, badge?: number, badgeLabel?: string) => {
    const current = opts.active === href;
    return html`<a href="${href}" class="${current ? "active" : ""}" ${current ? raw('aria-current="page"') : ""}><span>${label}</span>${
      badge ? html`<span class="chip accent" aria-label="${badge} ${badgeLabel ?? "waiting"}">${badge}</span>` : ""
    }</a>`;
  };
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${config.brand}</title>
${FONTS}
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<div class="shell">
  <nav class="nav" aria-label="Main menu">
    <div class="brand">${config.brand}<span>Your control room</span></div>
    ${link("/", "Home")}
    ${link("/inbox", "Your to-do list", opts.counts?.inbox, "things waiting for you")}
    ${link("/support", "Messages from clients", opts.counts?.support, "unanswered messages")}
    <div class="section">People</div>
    ${link("/customers", "Customers")}
    ${link("/clients", "Client logins")}
    ${link("/leads", "Enquiries")}
    ${link("/outreach", "Cold emails")}
    <div class="section">Products</div>
    ${products.map((p) => link(`/products/${p.slug}`, p.name))}
    <div class="section">Behind the scenes</div>
    ${link("/activity", "What's happened")}
    ${link("/system", "Automation and connections")}
    <form method="post" action="/logout" style="margin:16px 10px 6px"><button class="small">Sign out</button></form>
    <form method="post" action="/logout-everywhere" style="margin:0 10px"><button class="small">Sign out on all devices</button></form>
  </nav>
  <main class="main" id="content" tabindex="-1">
    ${opts.flash ? html`<div class="flash" role="status">${opts.flash}</div>` : ""}
    ${body}
  </main>
</div>
</body>
</html>`.value;
}

/** A short, friendly explanation at the top of a page. */
export function intro(text: Raw | string): Raw {
  return html`<div class="intro">${typeof text === "string" ? html`<p>${text}</p>` : text}</div>`;
}

export function publicPage(title: string, body: Raw): string {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
${FONTS}
<link rel="stylesheet" href="/static/app.css">
</head>
<body><main class="public" id="content">${body}</main></body>
</html>`.value;
}

// Plain-English names for the statuses stored in the database.
const labels: Record<string, [string, string]> = {
  // customers
  onboarding: ["Setting up", "accent"],
  active: ["Live", "ok"],
  past_due: ["Payment late", "warn"],
  paused: ["Paused", "bad"],
  cancelled: ["Left", "bad"],
  // onboarding steps and recurring work
  pending: ["Not started", ""],
  waiting: ["Waiting", "warn"],
  done: ["Done", "ok"],
  skipped: ["Skipped", ""],
  failed: ["Needs a look", "bad"],
  due: ["Due", ""],
  working: ["In progress", "violet"],
  awaiting_approval: ["Waiting for your OK", "warn"],
  delivered: ["Delivered", "ok"],
  blocked: ["Waiting on you", "warn"],
  // emails
  draft: ["Waiting for your OK", "warn"],
  queued: ["Sending soon", "violet"],
  sent: ["Sent", "ok"],
  // onboarding step kinds
  auto: ["Automatic", "ok"],
  customer: ["Customer does this", ""],
  // tasks
  approval: ["Needs your OK", "violet"],
  manual: ["For you to do", "accent"],
  alert: ["Heads up", "warn"],
  approved: ["Approved", "ok"],
  rejected: ["Not sent", "bad"],
  dismissed: ["Not needed", ""],
  // enquiries and prospects
  new: ["New", "accent"],
  contacted: ["Replied to", "violet"],
  followed_up: ["Followed up", "violet"],
  replied: ["They replied", "ok"],
  won: ["Became a customer", "ok"],
  lost: ["Didn't go ahead", ""],
  unsubscribed: ["Asked us to stop", "bad"],
  in_sequence: ["Being emailed", "violet"],
  suppressed: ["Do not contact", "bad"],
  // support and jobs
  open: ["Needs a reply", "accent"],
  answered: ["Answered", "ok"],
  closed: ["Closed", ""],
  ok: ["OK", "ok"],
  error: ["Problem", "bad"],
  running: ["Running", "violet"],
};

export function statusLabel(status: string | null | undefined): string {
  const s = status ?? "";
  return labels[s]?.[0] ?? s.replace(/_/g, " ");
}

export function chip(status: string | null | undefined): Raw {
  const s = status ?? "";
  const [label, tone] = labels[s] ?? [s.replace(/_/g, " "), ""];
  return html`<span class="chip ${tone}">${label}</span>`;
}

export function empty(text: string): Raw {
  return html`<div class="empty">${text}</div>`;
}

export { raw };
