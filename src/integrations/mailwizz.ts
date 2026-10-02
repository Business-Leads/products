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
