import { products } from "../products/index.js";
import { html, raw, type Raw } from "./html.js";

export interface NavCounts {
  inbox: number;
}

export function page(title: string, body: Raw, opts: { active?: string; counts?: NavCounts; flash?: string } = {}): string {
  const link = (href: string, label: string, badge?: number) =>
    html`<a href="${href}" class="${opts.active === href ? "active" : ""}"><span>${label}</span>${
      badge ? html`<span class="chip accent">${badge}</span>` : ""
    }</a>`;
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Products HQ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Urbanist:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<div class="shell">
  <nav class="nav">
    <div class="brand">Products HQ</div>
    ${link("/", "Overview")}
    ${link("/inbox", "Inbox", opts.counts?.inbox)}
    ${link("/customers", "Customers")}
    ${link("/leads", "Leads")}
    <div class="section">Products</div>
    ${products.map((p) => link(`/products/${p.slug}`, p.name))}
    <div class="section">System</div>
    ${link("/activity", "Activity")}
    ${link("/system", "Automation")}
    <form method="post" action="/logout" style="margin:14px 10px"><button class="small">Sign out</button></form>
  </nav>
  <main class="main">
    ${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ""}
    ${body}
  </main>
</div>
</body>
</html>`.value;
}

export function publicPage(title: string, body: Raw): string {
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Urbanist:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/static/app.css">
</head>
<body><div class="public">${body}</div></body>
</html>`.value;
}

const tones: Record<string, string> = {
  active: "ok",
  delivered: "ok",
  done: "ok",
  sent: "ok",
  won: "ok",
  approved: "ok",
  onboarding: "accent",
  waiting: "warn",
  awaiting_approval: "warn",
  blocked: "warn",
  past_due: "warn",
  draft: "warn",
  pending: "",
  due: "",
  working: "",
  paused: "bad",
  failed: "bad",
  cancelled: "bad",
  rejected: "bad",
  lost: "bad",
  error: "bad",
  ok: "ok",
};

export function chip(status: string | null | undefined): Raw {
  const s = status ?? "";
  return html`<span class="chip ${tones[s] ?? ""}">${s.replace(/_/g, " ")}</span>`;
}

export function empty(text: string): Raw {
  return html`<div class="empty">${text}</div>`;
}

export { raw };
