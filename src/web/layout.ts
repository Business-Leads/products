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
export type Area = "home" | "todo" | "messages" | "customers" | "logins" | "leads" | "outreach" | "products" | "system" | "learn";

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
  learn: "Learn HQ",
};

// Cute little characters, to match the logo: a white shape with a smiley face.
const face = (x: number, y: number) =>
  `<g fill="#3B2440"><circle cx="${x - 2.1}" cy="${y}" r="1"/><circle cx="${x + 2.1}" cy="${y}" r="1"/></g>` +
  `<path d="M${x - 1.3} ${y + 1.7}q1.3 1.2 2.6 0" fill="none" stroke="#3B2440" stroke-width="1" stroke-linecap="round"/>` +
  `<g fill="#FF8FA3" opacity=".75"><circle cx="${x - 3.6}" cy="${y + 1.5}" r=".9"/><circle cx="${x + 3.6}" cy="${y + 1.5}" r=".9"/></g>`;

const ICONS: Record<Area, string> = {
  home: `<path d="M12 2.6 2.4 10.4a1 1 0 0 0 .6 1.8H4.5V20a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-7.8H21a1 1 0 0 0 .6-1.8z" fill="#fff"/>${face(12, 14)}`,
  todo: `<rect x="4" y="3.5" width="16" height="18.5" rx="3.5" fill="#fff"/><rect x="8.5" y="2" width="7" height="3.6" rx="1.6" fill="#FFE08A"/><path d="M15.3 8.4l1.3 1.3 2.4-2.6" fill="none" stroke="#2BB38A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>${face(12, 13.5)}`,
  messages: `<path d="M5.5 3.5h13a3.5 3.5 0 0 1 3.5 3.5v7.5a3.5 3.5 0 0 1-3.5 3.5H11l-5 3.5V18h-.5A3.5 3.5 0 0 1 2 14.5V7a3.5 3.5 0 0 1 3.5-3.5z" fill="#fff"/>${face(12, 10)}`,
  customers: `<circle cx="16.5" cy="11" r="5.5" fill="#FFE6EE"/><path d="M10 22a6.5 6.5 0 0 1 13 0z" fill="#FFE6EE"/><circle cx="9" cy="10" r="6" fill="#fff"/><path d="M1.5 22.5a7.5 7.5 0 0 1 15 0z" fill="#fff"/>${face(9, 9.6)}`,
  logins: `<path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><rect x="3.5" y="10" width="17" height="12.5" rx="4" fill="#fff"/>${face(12, 15.3)}`,
  leads: `<path d="M6 2.5h8.5l5.5 5.5v12a2.5 2.5 0 0 1-2.5 2.5h-11.5A2.5 2.5 0 0 1 3.5 20V5A2.5 2.5 0 0 1 6 2.5z" fill="#fff"/><path d="M14.5 2.5V6.5a1.5 1.5 0 0 0 1.5 1.5h4z" fill="#D6E4FF"/>${face(11.8, 14)}`,
  outreach: `<rect x="2" y="5" width="20" height="15" rx="3.5" fill="#fff"/><path d="M3 6.5l9 6 9-6" fill="none" stroke="#FFC44D" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.6 1.6c.9-.9 2.6-.3 2.4 1.2-.2 1.2-2.4 2.6-2.4 2.6s-2.2-1.4-2.4-2.6c-.2-1.5 1.5-2.1 2.4-1.2z" fill="#FF8FA3"/>${face(12, 15.2)}`,
  products: `<path d="M12 2 21.5 6.5v11L12 22 2.5 17.5v-11z" fill="#fff"/><path d="M2.5 6.5 12 11l9.5-4.5" fill="none" stroke="#CFF5E4" stroke-width="1.4" stroke-linejoin="round"/>${face(12, 15)}`,
  // a little graduate
  learn: `<circle cx="12" cy="15" r="6.8" fill="#fff"/>${face(12, 15)}<path d="M12 2.5 1.8 7 12 11.5 22.2 7z" fill="#FFF6D6"/><path d="M19.5 8.2v4.6" stroke="#FFE08A" stroke-width="1.4" stroke-linecap="round"/><circle cx="19.5" cy="13.4" r="1.1" fill="#FFE08A"/>`,
  system: `<g fill="#fff"><circle cx="12" cy="12" r="7.5"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="10" y="1.5" width="4" height="5" rx="1.6" transform="rotate(${a} 12 12)"/>`).join("")}</g>${face(12, 11.4)}`,
};

// Each product has its own little character, about what it does.
const PRODUCT_ICONS: Record<string, string> = {
  // a map pin: be found locally
  firstpagelocal: `<path d="M12 1.8a8 8 0 0 0-8 8c0 5.6 6.4 11.4 7.3 12.2a1 1 0 0 0 1.4 0c.9-.8 7.3-6.6 7.3-12.2a8 8 0 0 0-8-8z" fill="#fff"/>${face(12, 9.6)}`,
  // two linked friends
  linkn: `<circle cx="16.2" cy="13.5" r="6.3" fill="#D8E9FF"/><circle cx="8.6" cy="11" r="7" fill="#fff"/><path d="M12.4 15.6a6.3 6.3 0 0 0 3.8 4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>${face(8.6, 10.4)}`,
  // a phone that answers in a flash
  speedtolead: `<rect x="5" y="2" width="12.5" height="20" rx="3.5" fill="#fff"/><rect x="9" y="3.6" width="4.5" height="1.3" rx=".65" fill="#FFD9B8"/><path d="M20.4 2.5l-2.6 4.6h2.4l-1.8 4" fill="none" stroke="#FFF3A6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>${face(11.25, 12)}`,
  // a letter popping out of its envelope
  emailfirst: `<rect x="5.5" y="2.5" width="13" height="12" rx="2.5" fill="#FFE6F4"/>${face(12, 7.6)}<path d="M2 11.5 12 17l10-5.5V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="#fff"/><path d="M12 20.6c-.9-.8-2.6-1.9-2.6-3.1a1.3 1.3 0 0 1 2.6-.4 1.3 1.3 0 0 1 2.6.4c0 1.2-1.7 2.3-2.6 3.1z" fill="#FF8FA3"/>`,
  // a bright idea
  goodquestions: `<path d="M12 1.8a7.6 7.6 0 0 0-4.4 13.8V18h8.8v-2.4A7.6 7.6 0 0 0 12 1.8z" fill="#fff"/><rect x="8.4" y="19" width="7.2" height="3.2" rx="1.6" fill="#FFE08A"/>${face(12, 9.4)}`,
  // a happy little website
  onlinebusinessbuilder: `<rect x="2" y="3.5" width="20" height="17" rx="3.5" fill="#fff"/><path d="M2 8.5h20" stroke="#FFD2C2" stroke-width="1.4"/><g fill="#FF8A5B"><circle cx="5" cy="6" r=".9"/><circle cx="7.6" cy="6" r=".9"/></g><path d="M18.5 1.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="#FFF6D6"/>${face(12, 13.6)}`,
};

export function productIcon(slug: string): Raw {
  const body = PRODUCT_ICONS[slug] ?? ICONS.products;
  return raw(`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`);
}

export function icon(area: Area): Raw {
  return raw(`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[area]}</svg>`);
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
  if (a.startsWith("/training")) return "learn";
  return "system";
}

export function page(title: string, body: Raw, opts: { active?: string; counts?: NavCounts; flash?: string } = {}): string {
  const link = (href: string, label: string, area: Area, badge?: number, badgeLabel?: string, slug?: string) => {
    const current = opts.active === href;
    return html`<a href="${href}" class="area-${area} ${current ? "active" : ""}" ${current ? raw('aria-current="page"') : ""}><span class="ti ${slug ? `prod-${slug}` : ""}">${slug ? productIcon(slug) : icon(area)}</span><span class="label">${label}</span>${
      badge ? html`<span class="chip" aria-label="${badge} ${badgeLabel ?? "waiting"}">${badge}</span>` : ""
    }</a>`;
  };
  const area = areaFor(opts.active);
  const productSlug = /^\/products\/([a-z]+)/.exec(opts.active ?? "")?.[1];

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
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<link rel="stylesheet" href="/static/hq.css">
</head>
<body class="hq area-${area}">
<a class="skip" href="#content">Skip to the page</a>
<div class="shell">
  <nav class="nav" aria-label="Main menu">
    <div class="brand"><img class="logo" src="/static/logo.svg" alt="" width="52" height="52"><span class="words">${config.brand}<small>Your control room</small></span></div>
    ${link("/", "Home", "home")}
    ${link("/inbox", "To-do list", "todo", opts.counts?.inbox, "things waiting for you")}
    ${link("/support", "Messages", "messages", opts.counts?.support, "unanswered messages")}
    ${link("/training", "Learn HQ", "learn")}
    <div class="section">People</div>
    ${link("/customers", "Customers", "customers")}
    ${link("/leads", "Enquiries", "leads")}
    ${link("/clients", "Client logins", "logins")}
    ${link("/outreach", "Cold emails", "outreach")}
    <div class="section">Products</div>
    ${products.map((p) => link(`/products/${p.slug}`, p.name, "products", undefined, undefined, p.slug))}
    <div class="section">Behind the scenes</div>
    ${link("/activity", "What's happened", "system")}
    ${link("/system", "Settings", "system")}
    <form method="post" action="/logout" style="margin:20px 10px 8px"><button class="small">Sign out</button></form>
    <form method="post" action="/logout-everywhere" style="margin:0 10px"><button class="small">Sign out everywhere</button></form>
  </nav>
  <main class="main" id="content" tabindex="-1">
    <div class="area-band">
      <span class="ti big ${productSlug ? `prod-${productSlug}` : ""}" aria-hidden="true">${productSlug ? productIcon(productSlug) : icon(area)}</span>
      <div class="band-text">
        <p class="where">${AREA_NAMES[area]}</p>
        <h1>${raw(h1?.[1] ?? title)}</h1>
        ${introBox ? html`<div class="intro-text">${raw(introBox[1]!)}</div>` : ""}
      </div>
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

export function publicPage(title: string, body: Raw, opts: { hq?: boolean } = {}): string {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
${FONTS}
${opts.hq ? html`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap"><link rel="icon" href="/static/logo.svg" type="image/svg+xml">` : ""}
<link rel="stylesheet" href="/static/app.css">
${opts.hq ? html`<link rel="stylesheet" href="/static/hq.css">` : ""}
</head>
<body${opts.hq ? raw(' class="hq"') : ""}><main class="public" id="content">${body}</main></body>
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
  assessment: ["Took the assessment", "violet"],
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
