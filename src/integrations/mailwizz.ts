import { NotConfiguredError } from "../lib/util.js";

// MailWizz (Mailpulse) API, as used for EmailFirst: campaign statistics for the
// weekly results. Auth is the X-Api-Key header; responses are
// { status: "success", data: {...} }.

function settings(): { url: string; key: string } {
  const url = process.env.MAILWIZZ_API_URL?.trim().replace(/\/$/, "");
  const key = process.env.MAILWIZZ_API_KEY?.trim();
  if (!url || !key) throw new NotConfiguredError("mailwizz", "MailWizz API details are not set");
  return { url, key };
}

async function get<T>(path: string): Promise<T> {
  const { url, key } = settings();
  const res = await fetch(`${url}${path}`, { headers: { "X-Api-Key": key, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`MailWizz GET ${path}: ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { status?: string; data?: T; error?: string };
  if (json.status && json.status !== "success") throw new Error(`MailWizz GET ${path}: ${json.error ?? json.status}`);
  return (json.data ?? json) as T;
}

export interface CampaignStats {
  sent: number;
  opens: number;
  clicks: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Running totals for a campaign since it started. */
export async function campaignStats(campaignUid: string): Promise<CampaignStats> {
  const s = await get<Record<string, unknown>>(`/campaigns/${encodeURIComponent(campaignUid)}/stats`);
  return {
    sent: num(s.delivery_success_count ?? s.processed_count ?? s.subscribers_count),
    opens: num(s.unique_opens_count),
    clicks: num(s.unique_clicks_count),
  };
}

// ------------------------------------------------------------------ writes
// MailWizz takes form fields (campaign[name], subscribers[0][EMAIL] ...) and
// answers { status: "success", ... }. Sends, lists and templates for EmailFirst
// and Good Questions are created here; nothing is sent until a campaign's
// send_at time.

function formBody(fields: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item ? formBody(item as Record<string, unknown>, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === "object") formBody(v as Record<string, unknown>, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function send<T = any>(method: "POST" | "PUT" | "DELETE", path: string, fields: Record<string, unknown> = {}): Promise<T> {
  const { url, key } = settings();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "X-Api-Key": key, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "DELETE" ? undefined : formBody(fields),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MailWizz ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  const json = text ? (JSON.parse(text) as any) : {};
  if (json.status && json.status !== "success") throw new Error(`MailWizz ${method} ${path}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json as T;
}

export interface Sender {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  company: string;
}

/** A list for one day's contacts (single opt-in import; nobody is emailed to confirm). */
export async function createList(name: string, s: Sender): Promise<string> {
  const r = await send("POST", "/lists", {
    general: { name, description: name, opt_in: "single", opt_out: "single" },
    defaults: { from_name: s.fromName, from_email: s.fromEmail, reply_to: s.replyTo, subject: "" },
    company: { name: s.company, country: "United Kingdom" },
  });
  const uid = r.list_uid ?? r.data?.list_uid ?? r.data?.record?.general?.list_uid;
  if (!uid) throw new Error("MailWizz didn't return a list id");
  return String(uid);
}

export async function ensureFields(listUid: string, tags: { tag: string; label: string }[]): Promise<void> {
  const have = new Set(((await get<any>(`/lists/${listUid}/fields`))?.records ?? []).map((f: any) => String(f.tag)));
  for (const f of tags) {
    if (have.has(f.tag)) continue;
    await send("POST", `/lists/${listUid}/fields`, { type: "text", label: f.label, tag: f.tag, required: "no", visibility: "visible" }).catch(() => undefined);
  }
}

export interface Contact {
  EMAIL: string;
  FNAME?: string;
  LNAME?: string;
  COMPANY?: string;
  TITLE?: string;
}

export async function addSubscribers(listUid: string, contacts: Contact[]): Promise<void> {
  for (let i = 0; i < contacts.length; i += 100) {
    const chunk = contacts.slice(i, i + 100).map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v)));
    await send("POST", `/lists/${listUid}/subscribers/bulk`, { subscribers: chunk });
  }
}

/** A template from plain email text (kept looking like a personal email). */
export async function createTemplate(name: string, bodyText: string): Promise<string> {
  const htmlBody = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`)
    .join("")}<p style="font-size:12px;color:#777">If you'd rather not hear from us, <a href="[UNSUBSCRIBE_URL]">unsubscribe here</a>.</p></body></html>`;
  const r = await send("POST", "/templates", { template: { name, content: Buffer.from(htmlBody).toString("base64"), inline_css: "no", auto_plain_text: "yes" } });
  const uid = r.template_uid ?? r.data?.template_uid ?? r.data?.record?.template_uid;
  if (!uid) throw new Error("MailWizz didn't return a template id");
  return String(uid);
}

/** A campaign to one list, sent at a set UK time, with link tracking for the click report. */
export async function createCampaign(opts: { name: string; subject: string; listUid: string; templateUid: string; sendAt: Date; sender: Sender }): Promise<string> {
  const ukTime = opts.sendAt.toLocaleString("sv-SE", { timeZone: "Europe/London" }).slice(0, 19);
  const r = await send("POST", "/campaigns", {
    campaign: {
      name: opts.name,
      type: "regular",
      from_name: opts.sender.fromName,
      from_email: opts.sender.fromEmail,
      subject: opts.subject,
      reply_to: opts.sender.replyTo,
      send_at: ukTime,
      list_uid: opts.listUid,
      options: { url_tracking: "yes" },
      template: { template_uid: opts.templateUid, inline_css: "no", auto_plain_text: "yes" },
    },
  });
  const uid = r.campaign_uid ?? r.data?.campaign_uid ?? r.data?.record?.campaign_uid;
  if (!uid) throw new Error("MailWizz didn't return a campaign id");
  return String(uid);
}

/** Who clicked a link in a campaign: a temporary segment of clickers, read, then deleted. */
export async function campaignClickers(listUid: string, campaignUid: string, days = 2): Promise<Contact[]> {
  const campaign = await get<any>(`/campaigns/${campaignUid}`);
  const campaignId = campaign?.record?.campaign_id ?? campaign?.campaign_id;
  if (!campaignId) return [];
  const seg = await send("POST", `/lists/${listUid}/segments`, {
    name: `clickers ${campaignUid} ${Date.now()}`,
    operator_match: "any",
    campaign_conditions: [{ action: "click", campaign_id: campaignId, time_comparison_operator: "lte", time_value: days, time_unit: "day" }],
  });
  const segUid = seg.segment_uid ?? seg.data?.segment_uid ?? seg.data?.record?.segment_uid;
  if (!segUid) return [];
  try {
    const subs = await get<any>(`/lists/${listUid}/segments/${segUid}/subscribers?page=1&per_page=500`);
    return (subs?.records ?? []).map((r: any) => ({ EMAIL: r.EMAIL ?? r.email, FNAME: r.FNAME, LNAME: r.LNAME, COMPANY: r.COMPANY, TITLE: r.TITLE }));
  } finally {
    await send("DELETE", `/lists/${listUid}/segments/${segUid}`).catch(() => undefined);
  }
}

/** Unsubscribed addresses on a list, to add to the global suppression list. */
export async function unsubscribed(listUid: string): Promise<string[]> {
  const subs = await get<any>(`/lists/${listUid}/subscribers?page=1&per_page=1000&status=unsubscribed`).catch(() => ({ records: [] }));
  return (subs?.records ?? []).filter((r: any) => String(r.status ?? "unsubscribed") === "unsubscribed").map((r: any) => String(r.EMAIL ?? r.email ?? "").toLowerCase()).filter(Boolean);
}

// ------------------------------------------------------------- reading lists

export interface ListInfo {
  uid: string;
  name: string;
}

/** Every list in the Mailpulse account. */
export async function allLists(): Promise<ListInfo[]> {
  const out: ListInfo[] = [];
  for (let page = 1; page < 200; page++) {
    const r = await get<any>(`/lists?page=${page}&per_page=50`);
    const records: any[] = r?.records ?? [];
    for (const l of records) out.push({ uid: String(l.general?.list_uid ?? l.list_uid), name: String(l.general?.name ?? l.name ?? "") });
    if (records.length < 50 || page >= Number(r?.total_pages ?? page)) break;
  }
  return out.filter((l) => l.uid && l.uid !== "undefined");
}

export interface ListSubscriber extends Contact {
  status: string;
}

/** One page of a list's subscribers (up to 1,000), with their status. */
export async function listSubscribers(listUid: string, page: number): Promise<{ records: ListSubscriber[]; more: boolean }> {
  const r = await get<any>(`/lists/${listUid}/subscribers?page=${page}&per_page=1000`);
  const records: any[] = r?.records ?? [];
  return {
    records: records.map((s) => ({
      EMAIL: String(s.EMAIL ?? s.email ?? ""),
      FNAME: s.FNAME,
      LNAME: s.LNAME,
      COMPANY: s.COMPANY,
      TITLE: s.TITLE,
      status: String(s.status ?? "confirmed"),
    })),
    more: records.length === 1000 && page < Number(r?.total_pages ?? page + 1),
  };
}
