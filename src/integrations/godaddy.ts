import { NotConfiguredError } from "../lib/util.js";

// GoDaddy's domains API: check whether a name is free, see whether a domain is
// in our account, and point one at a Netlify site. Buying is never done here;
// that stays a decision for a person.

const API = "https://api.godaddy.com/v1";
export const NETLIFY_IP = "75.2.60.5";

function auth(): Record<string, string> {
  const key = process.env.GODADDY_API_KEY?.trim();
  const secret = process.env.GODADDY_API_SECRET?.trim();
  if (!key || !secret) throw new NotConfiguredError("godaddy", "GoDaddy keys are not set");
  return { Authorization: `sso-key ${key}:${secret}`, "Content-Type": "application/json", Accept: "application/json" };
}

export interface Availability {
  domain: string;
  available: boolean;
  /** Price for the first year in pounds, when GoDaddy gives one. */
  price?: number;
}

export async function checkAvailable(domain: string): Promise<Availability> {
  const res = await fetch(`${API}/domains/available?domain=${encodeURIComponent(domain)}&checkType=FAST`, { headers: auth() });
  if (!res.ok) throw new Error(`GoDaddy availability ${domain}: ${res.status}`);
  const j = (await res.json()) as { available: boolean; price?: number; currency?: string };
  return { domain, available: j.available, price: j.price ? j.price / 1_000_000 : undefined };
}

export async function inOurAccount(domain: string): Promise<boolean> {
  const res = await fetch(`${API}/domains/${encodeURIComponent(domain)}`, { headers: auth() });
  return res.ok;
}

/** Point the bare domain and www at a Netlify site. Only the A @ and CNAME www records are written. */
export async function pointAtNetlify(domain: string, netlifyHost: string): Promise<void> {
  const put = async (type: string, name: string, data: string) => {
    const res = await fetch(`${API}/domains/${encodeURIComponent(domain)}/records/${type}/${name}`, {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify([{ data, ttl: 600 }]),
    });
    if (!res.ok) throw new Error(`GoDaddy ${type} ${name}.${domain}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  await put("A", "@", NETLIFY_IP);
  await put("CNAME", "www", netlifyHost);
}

/** A few sensible names to suggest for a business, e.g. ownerplumbing.co.uk. */
export function domainIdeas(business: string, area?: string): string[] {
  const base = business.toLowerCase().replace(/&/g, "and").replace(/\b(ltd|limited|llp|plc)\b/g, "").replace(/[^a-z0-9]+/g, "");
  const place = (area ?? "").toLowerCase().split(/[,\s]+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  const names = [base, place && !base.includes(place) ? `${base}${place}` : ""].filter((n) => n.length >= 3 && n.length <= 50);
  return [...new Set(names.flatMap((n) => [`${n}.co.uk`, `${n}.com`, `${n}.uk`]))].slice(0, 6);
}
