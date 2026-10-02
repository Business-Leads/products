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

// Each part of HQ has a colour and an icon, used in the menu, the page header and the home tiles.
export type Area = "home" | "todo" | "messages" | "customers" | "logins" | "leads" | "outreach" | "products" | "system";

const AREA_NAMES: Record<Area, string> = {
  home: "Home",
  todo: "To-do list",
  messages: "Messages",
  customers: "Customers",
  logins: "Client logins",
  leads: "Enquiries",
  outreach: "Cold emails",
  products: "Products",
  system: "Behind the scenes",
};

const ICONS: Record<Area, string> = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  todo: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
  messages: '<path d="M4 5h16v11H8l-4 4z"/>',
  customers: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.6c2.6.2 4.6 1.9 5.3 5.4"/>',
  logins: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  leads: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 14h6"/>',
  outreach: '<path d="M3 5h18v14H3z"/><path d="M3 6l9 7 9-7"/>',
  products: '<path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

export function icon(area: Area): Raw {
  return raw(`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[area]}</svg>`);
}

function areaFor(active: string | undefined): Area {
  const a = active ?? "/";
  if (a === "/") return "home";
  if (a.startsWith("/inbox")) return "todo";
  if (a.startsWith("/support")) return "messages";
  if (a.startsWith("/customers")) return "customers";
  if (a.startsWith("/clients")) return "logins";
  if (a.startsWith("/leads")) return "leads";
  if (a.startsWith("/outreach")) return "outreach";
  if (a.startsWith("/products")) return "products";
  return "system";
}

export function page(title: string, body: Raw, opts: { active?: string; counts?: NavCounts; flash?: string } = {}): string {
  const link = (href: string, label: string, area: Area, badge?: number, badgeLabel?: string) => {
    const current = opts.active === href;
    return html`<a href="${href}" class="area-${area} ${current ? "active" : ""}" ${current ? raw('aria-current="page"') : ""}>${icon(area)}<span class="label">${label}</span>${
      badge ? html`<span class="chip" aria-label="${badge} ${badgeLabel ?? "waiting"}">${badge}</span>` : ""
    }</a>`;
  };
  const area = areaFor(opts.active);

  // The page's first heading and intro move into the coloured header band.
  let content = body.value;
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(content);
  if (h1) content = content.replace(h1[0], "");
  const introBox = /<div class="intro">([\s\S]*?)<\/div>/.exec(content);
  if (introBox) content = content.replace(introBox[0], "");

  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${config.brand}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap">
<link rel="stylesheet" href="/static/app.css">
<link rel="stylesheet" href="/static/hq.css">
</head>
<body class="hq area-${area}">
<a class="skip" href="#content">Skip to the page</a>
<div class="shell">
  <nav class="nav" aria-label="Main menu">
    <div class="brand">${config.brand}<span>Your control room</span></div>
    ${link("/", "Home", "home")}
    ${link("/inbox", "To-do list", "todo", opts.counts?.inbox, "things waiting for you")}
    ${link("/support", "Messages", "messages", opts.counts?.support, "unanswered messages")}
    <div class="section">People</div>
    ${link("/customers", "Customers", "customers")}
    ${link("/leads", "Enquiries", "leads")}
    ${link("/clients", "Client logins", "logins")}
    ${link("/outreach", "Cold emails", "outreach")}
    <div class="section">Products</div>
    ${products.map((p) => link(`/products/${p.slug}`, p.name, "products"))}
    <div class="section">Behind the scenes</div>
    ${link("/activity", "What's happened", "system")}
    ${link("/system", "Settings", "system")}
    <form method="post" action="/logout" style="margin:20px 10px 8px"><button class="small">Sign out</button></form>
    <form method="post" action="/logout-everywhere" style="margin:0 10px"><button class="small">Sign out everywhere</button></form>
  </nav>
  <main class="main" id="content" tabindex="-1">
    <div class="area-band">
      <p class="where">${icon(area)} ${AREA_NAMES[area]}</p>
      <h1>${raw(h1?.[1] ?? title)}</h1>
      ${introBox ? html`<div class="intro-text">${raw(introBox[1]!)}</div>` : ""}
    </div>
    ${opts.flash ? html`<div class="flash" role="status">${opts.flash}</div>` : ""}
    ${raw(content)}
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
