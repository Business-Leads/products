import { NotConfiguredError } from "../lib/util.js";

// MailWizz landing pages (portal.emailfirst.co.uk). MailWizz has no API for
// these, so HQ signs in to the customer area like a person would and fills in
// the same forms (learnt with the mailwizz-landing-inspect workflow, Oct 2026):
//   create:  POST /customer/landing-pages/create   LandingPageRevision[template_id|title|description]
//            -> redirects to /customer/index.php/landing-pages/<id>/overview
//   content: GET  /customer/index.php/landing-pages/variants/<id>/index  (JSON { html } with the variant's Edit link)
//            POST /customer/index.php/landing-pages/variants/<variant>/update
//                 LandingPageRevisionVariant[title|content]  (content is the page's HTML)
//   publish: the overview's "Publish" link, /customer/index.php/landing-pages/<id>/publish
// Forms carry a CSRF field, so each POST first reads its form.

const UA = "Mozilla/5.0 (OnlineBusinessBuilder HQ)";

function settings(): { base: string; email: string; password: string } {
  const url = process.env.MAILWIZZ_API_URL?.trim();
  const email = process.env.MAILWIZZ_LOGIN_EMAIL?.trim();
  const password = process.env.MAILWIZZ_LOGIN_PASSWORD ?? "";
  if (!url || !email || !password) throw new NotConfiguredError("mailwizz", "MailWizz sign-in details (MAILWIZZ_LOGIN_EMAIL, MAILWIZZ_LOGIN_PASSWORD) are not set");
  return { base: url.replace(/^(https?:\/\/[^/]+).*$/, "$1"), email, password };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:[\]-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = decode(m[3] ?? m[4] ?? "");
  return out;
}

export interface FoundForm {
  action: string;
  fields: Record<string, string>;
}

/** The first form whose action contains `actionPart`, with the values its inputs already hold (CSRF included). */
export function findForm(html: string, actionPart: string): FoundForm | undefined {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const a = attrs(m[1]!);
    if (!(a.action ?? "").includes(actionPart)) continue;
    const fields: Record<string, string> = {};
    for (const i of m[2]!.matchAll(/<input\b[^>]*>/gi)) {
      const ia = attrs(i[0]);
      if (!ia.name || ia.type === "submit" || ((ia.type === "radio" || ia.type === "checkbox") && !/\bchecked\b/i.test(i[0]))) continue;
      fields[ia.name] = ia.value ?? "";
    }
    for (const t of m[2]!.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const ta = attrs(t[1]!);
      if (ta.name) fields[ta.name] = decode(t[2]!);
    }
    return { action: a.action!, fields };
  }
  return undefined;
}

export class MailwizzSession {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  private absolute(path: string): string {
    return path.startsWith("http") ? path : `${this.base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  /** A request that keeps the session cookie and follows redirects itself. */
  async request(path: string, form?: Record<string, string>, hops = 0): Promise<{ status: number; url: string; text: string }> {
    const url = this.absolute(path);
    const res = await fetch(url, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/json",
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded", Referer: url } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && hops < 6) return this.request(new URL(loc, url).toString(), undefined, hops + 1);
    return { status: res.status, url: res.url || url, text: await res.text() };
  }

  async signIn(email: string, password: string): Promise<void> {
    const page = await this.request("/customer/guest/index");
    const f = findForm(page.text, "guest") ?? findForm(page.text, "");
    if (!f) throw new Error("MailWizz: sign-in form not found");
    const r = await this.request(f.action || "/customer/guest/index", { ...f.fields, "CustomerLogin[email]": email, "CustomerLogin[password]": password });
    if (/guest/.test(r.url) || /CustomerLogin\[password\]/.test(r.text)) throw new Error("MailWizz: sign-in was refused (check MAILWIZZ_LOGIN_EMAIL / MAILWIZZ_LOGIN_PASSWORD)");
  }
}

export async function mailwizzSession(): Promise<MailwizzSession> {
  const { base, email, password } = settings();
  const s = new MailwizzSession(base);
  await s.signIn(email, password);
  return s;
}

/** A new landing page from the blank template; returns MailWizz's page id. */
export async function createLandingPage(s: MailwizzSession, title: string, description = ""): Promise<string> {
  const page = await s.request("/customer/landing-pages/create");
  const f = findForm(page.text, "landing-pages/create");
  if (!f) throw new Error("MailWizz: the new landing page form wasn't found");
  const r = await s.request(f.action, {
    ...f.fields,
    "LandingPageRevision[template_id]": "1",
    "LandingPageRevision[title]": title.slice(0, 200),
    "LandingPageRevision[description]": description.slice(0, 1000),
  });
  const id = /landing-pages\/([\w-]+)\/overview/.exec(r.url)?.[1];
  if (!id) throw new Error("MailWizz: the landing page wasn't created");
  return id;
}

/** Put the page's HTML into its (first) variant. */
export async function setLandingContent(s: MailwizzSession, pageId: string, title: string, htmlContent: string): Promise<void> {
  const list = await s.request(`/customer/index.php/landing-pages/variants/${pageId}/index`);
  let html = list.text;
  try {
    html = (JSON.parse(list.text) as { html?: string }).html ?? list.text;
  } catch {
    /* plain HTML */
  }
  const edit = /href="([^"]*landing-pages\/variants\/[\w-]+\/update)"/.exec(html)?.[1];
  if (!edit) throw new Error("MailWizz: the page's variant wasn't found");
  const form = await s.request(decode(edit));
  const f = findForm(form.text, "/update");
  if (!f) throw new Error("MailWizz: the variant form wasn't found");
  const r = await s.request(f.action, { ...f.fields, "LandingPageRevisionVariant[title]": title.slice(0, 200), "LandingPageRevisionVariant[content]": htmlContent });
  if (r.status >= 400) throw new Error(`MailWizz: saving the page content failed (${r.status})`);
}

/** Publish the page and return its public address. */
export async function publishLandingPage(s: MailwizzSession, pageId: string): Promise<string> {
  const r = await s.request(`/customer/index.php/landing-pages/${pageId}/publish`);
  // Some versions ask to confirm with a form.
  const confirm = findForm(r.text, "/publish");
  if (confirm) await s.request(confirm.action, confirm.fields);
  return landingPageUrl(s, pageId);
}

/** The page's public address, as shown on its overview. */
export async function landingPageUrl(s: MailwizzSession, pageId: string): Promise<string> {
  const ov = await s.request(`/customer/index.php/landing-pages/${pageId}/overview`);
  const m = /(https?:\/\/[^"'<\s]+\/lp\/[^"'<\s]+)/.exec(ov.text);
  if (!m) throw new Error("MailWizz: the page's public address wasn't found");
  return decode(m[1]!);
}

export async function deleteLandingPage(s: MailwizzSession, pageId: string): Promise<number> {
  const idx = await s.request("/customer/landing-pages/index");
  const token = /name="(\w*csrf\w*)"\s+value="([^"]+)"/i.exec(idx.text) ?? /value="([^"]+)"\s+name="(\w*csrf\w*)"/i.exec(idx.text);
  const form: Record<string, string> = {};
  if (token) token[1]!.toLowerCase().includes("csrf") ? (form[token[1]!] = token[2]!) : (form[token[2]!] = token[1]!);
  const r = await s.request(`/customer/index.php/landing-pages/${pageId}/delete`, form);
  return r.status;
}

// ------------------------------------------------------------ the page itself

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A clean one-page layout from the approved copy: the first line is the
 * headline, then paragraphs, then one button. Inline styles only, because the
 * MailWizz editor keeps those.
 */
export function landingPageHtml(opts: { copy: string; company: string; ctaLabel: string; ctaUrl: string; colour?: string }): string {
  const colour = /^#[0-9a-f]{6}$/i.test(opts.colour ?? "") ? opts.colour! : "#1F3A5F";
  const blocks = opts.copy.replace(/\r/g, "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const [first = opts.company, ...rest] = blocks;
  const headline = first.replace(/^#+\s*/, "");
  const body = rest
    .map((b) => {
      if (/^#+\s/.test(b)) return `<h2 style="font-size:24px;margin:32px 0 10px;color:${colour}">${esc(b.replace(/^#+\s*/, ""))}</h2>`;
      const lines = b.split("\n");
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        return `<ul style="padding-left:22px;margin:0 0 18px">${lines.map((l) => `<li style="margin:0 0 8px">${esc(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p style="margin:0 0 18px">${esc(b).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  const button = `<p style="margin:30px 0;text-align:center"><a href="${esc(opts.ctaUrl)}" style="display:inline-block;background:${colour};color:#ffffff;text-decoration:none;font-weight:bold;font-size:19px;padding:16px 34px;border-radius:10px">${esc(opts.ctaLabel)}</a></p>`;
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1d2330;background:#ffffff;line-height:1.6;font-size:18px">` +
    `<div style="background:${colour};color:#ffffff;padding:56px 20px;text-align:center">` +
    `<p style="margin:0 0 10px;font-size:15px;letter-spacing:2px;text-transform:uppercase;opacity:.85">${esc(opts.company)}</p>` +
    `<h1 style="margin:0 auto;max-width:760px;font-size:36px;line-height:1.2">${esc(headline)}</h1></div>` +
    `<div style="max-width:720px;margin:0 auto;padding:40px 20px">${body}${button}</div>` +
    `<div style="text-align:center;font-size:13px;color:#6b7280;padding:24px 20px;border-top:1px solid #e5e7eb">${esc(opts.company)}</div></div>`
  );
}
