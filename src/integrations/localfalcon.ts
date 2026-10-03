import { NotConfiguredError } from "../lib/util.js";

// Local Falcon runs Online Business Builder's Google Business Profile work:
// ranking scans (monthly campaigns), Google's own profile figures, posts,
// review replies and profile monitoring (Falcon Guard).
// API: every call is a form-encoded POST to https://api.localfalcon.com/v1|v2,
// with the key as the api_key field; arrays are indexed fields (a[0][b]).
// Responses are { code, success, message, data }. Limit: 5 requests a second.
// The /v2/gbp/* calls only work for locations imported from the connected
// Google account (the "Import From Google Account" button in Local Falcon).

const BASE = "https://api.localfalcon.com";

function apiKey(): string {
  const key = process.env.LOCALFALCON_API_KEY?.trim();
  if (!key) throw new NotConfiguredError("localfalcon", "LOCALFALCON_API_KEY is not set");
  return key;
}

type Fields = Record<string, unknown>;

/** Flatten nested objects/arrays into Local Falcon's indexed form fields. */
export function formFields(fields: Fields, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item ? formFields(item as Fields, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === "object") formFields(v as Fields, name, out);
    else out.append(name, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  }
  return out;
}

let lastCall = 0;

async function lf<T = any>(path: string, fields: Fields = {}): Promise<T> {
  // Stay under 5 requests a second.
  const wait = lastCall + 220 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const body = formFields({ api_key: apiKey(), ...fields });
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Local Falcon ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.success === false) throw new Error(`Local Falcon ${path}: ${json.message ?? res.status}`);
  return (json.data ?? json) as T;
}

/** Local Falcon dates are MM/DD/YYYY. */
export function lfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

export interface LfLocation {
  place_id: string;
  name: string;
  address?: string;
  lat?: number | string;
  lng?: number | string;
}

function locationsOf(data: any): LfLocation[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.locations) ? data.locations : [];
  return list
    .map((l: any) => ({ place_id: String(l.place_id ?? l.placeId ?? ""), name: String(l.name ?? ""), address: l.address, lat: l.lat, lng: l.lng }))
    .filter((l: LfLocation) => l.place_id);
}

/** Saved locations whose Google Business Profile is connected (we can post and reply for them). */
export async function linkedLocations(query?: string): Promise<LfLocation[]> {
  return locationsOf(await lf("/v1/locations/", { gbp_linked: true, query, limit: 100 }));
}

/** Can we write to this profile? (Google "voice of merchant".) */
export async function canManage(placeId: string): Promise<boolean> {
  const v = await lf("/v2/gbp/verification/", { place_id: placeId });
  return Boolean(v?.has_voice_of_merchant ?? v?.hasVoiceOfMerchant ?? true);
}

/** A monthly ranking scan for the client's main searches, with AI analysis. */
export async function createMonthlyCampaign(opts: { name: string; placeId: string; keywords: string[]; start: Date; email?: string }): Promise<string> {
  const data = await lf("/v2/campaigns/create", {
    name: opts.name,
    placeId: opts.placeId,
    keyword: opts.keywords.join(","),
    gridSize: 7,
    radius: 3,
    measurement: "mi",
    frequency: "monthly",
    startDate: lfDate(opts.start),
    startTime: "08:00",
    ai_analysis: true,
    notify: Boolean(opts.email),
    email_recipients: opts.email,
  });
  return String(data?.campaign_key ?? data?.key ?? data?.report_key ?? data?.id ?? "");
}

export interface RankingSummary {
  averagePosition?: number;
  shareOfVoice?: number;
  positionChange?: number;
  shareChange?: number;
  reportUrl?: string;
  keywords?: string[];
}

const n = (v: unknown) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/** The latest results of a campaign: average rank (ARP), share of local voice (SoLV) and their movement. */
export async function campaignSummary(campaignKey: string): Promise<RankingSummary> {
  const c = await lf(`/v1/campaigns/${encodeURIComponent(campaignKey)}`, { fieldmask: "arp,atrp,solv,arp_move,solv_move,public_url,keywords" });
  const r = c?.report ?? c?.last_report ?? c;
  return {
    averagePosition: n(r?.arp),
    shareOfVoice: n(r?.solv),
    positionChange: n(r?.arp_move),
    shareChange: n(r?.solv_move),
    reportUrl: r?.public_url ?? r?.share_url ?? c?.public_url,
    keywords: Array.isArray(r?.keywords) ? r.keywords : undefined,
  };
}

/** Google's own profile figures for a date range, summed. */
export async function profileMetrics(placeId: string, start: Date, end: Date): Promise<Record<string, number>> {
  const metrics = ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"];
  const data = await lf("/v2/gbp/metrics/", { place_id: placeId, metrics: metrics.join(","), start_date: lfDate(start), end_date: lfDate(end) });
  const totals: Record<string, number> = {};
  const series: any[] = Array.isArray(data) ? data : Array.isArray(data?.metrics) ? data.metrics : Object.entries(data ?? {}).map(([metric, v]) => ({ metric, values: v }));
  for (const s of series) {
    const key = String(s.metric ?? s.name ?? "").toUpperCase();
    const values = Array.isArray(s.values) ? s.values : Array.isArray(s.data) ? s.data : [];
    totals[key] = values.reduce((sum: number, v: any) => sum + (Number(v?.value ?? v) || 0), 0);
  }
  const g = (k: string) => totals[k] ?? 0;
  return {
    profile_views: g("BUSINESS_IMPRESSIONS_DESKTOP_MAPS") + g("BUSINESS_IMPRESSIONS_MOBILE_MAPS") + g("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH") + g("BUSINESS_IMPRESSIONS_MOBILE_SEARCH"),
    calls: g("CALL_CLICKS"),
    website_clicks: g("WEBSITE_CLICKS"),
    direction_requests: g("BUSINESS_DIRECTION_REQUESTS"),
  };
}

/** Publish a standard post on the client's Google Business Profile. */
export async function createPost(placeId: string, summary: string, link?: string): Promise<string | undefined> {
  const data = await lf("/v2/gbp/create-post/", {
    place_id: placeId,
    summary: summary.slice(0, 1500),
    topic_type: "STANDARD",
    ...(link ? { call_to_action: { action_type: "LEARN_MORE", url: link } } : {}),
  });
  return data?.name ?? data?.post_id ?? data?.id;
}

export interface Review {
  id: string;
  rating: number;
  author: string;
  text: string;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export async function unansweredReviews(placeId: string): Promise<Review[]> {
  const data = await lf("/v2/gbp/reviews/", { place_id: placeId, unanswered: true, limit: 50 });
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.reviews) ? data.reviews : [];
  return list
    .map((r) => ({
      id: String(r.review_id ?? r.reviewId ?? r.id ?? r.name ?? ""),
      rating: Number(r.rating) || STARS[String(r.star_rating ?? r.starRating ?? "").toUpperCase()] || 0,
      author: String(r.reviewer?.displayName ?? r.reviewer_name ?? r.author ?? "a customer"),
      text: String(r.comment ?? r.text ?? ""),
    }))
    .filter((r) => r.id);
}

export async function replyToReviews(placeId: string, replies: { reviewId: string; reply: string }[]): Promise<void> {
  if (!replies.length) return;
  await lf("/v2/gbp/reply-review/", { replies: replies.map((r) => ({ place_id: placeId, review_id: r.reviewId, reply: r.reply })) });
}

/** Watch the profile for changes (Falcon Guard). */
export async function addGuard(placeId: string): Promise<void> {
  await lf("/v2/guard/add", { place_id: placeId });
}

export async function guardChanges(placeId: string): Promise<string[]> {
  const g = await lf(`/v1/guard/${encodeURIComponent(placeId)}`);
  const list: any[] = Array.isArray(g?.changes) ? g.changes : Array.isArray(g?.alerts) ? g.alerts : [];
  return list.map((c) => String(c.description ?? c.message ?? `${c.field ?? "A field"} changed`));
}
