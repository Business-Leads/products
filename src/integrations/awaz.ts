import { NotConfiguredError } from "../lib/util.js";

// Awaz.ai (Speed to Lead's phone assistant). Public API: https://api.awaz.ai/v1,
// header "Authorization: Bearer <AWAZ_API_KEY>", 100 requests a minute.
// It can list agents, phone numbers and calls, fetch a call, place outbound
// calls and subscribe call webhooks. It can't create agents or attach numbers:
// that's done in the Awaz app.

const BASE = "https://api.awaz.ai/v1";

function key(): string {
  const k = process.env.AWAZ_API_KEY?.trim();
  if (!k) throw new NotConfiguredError("awaz", "AWAZ_API_KEY is not set");
  return k;
}

async function awaz<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Awaz ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const items = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : Array.isArray(r?.data) ? r.data : []);

export interface AwazAgent {
  id: string;
  name: string;
}

export async function listAgents(): Promise<AwazAgent[]> {
  return items(await awaz("GET", "/agents")).map((a) => ({ id: String(a.id ?? a._id ?? ""), name: String(a.name ?? a.title ?? "") })).filter((a) => a.id);
}

export async function listPhones(): Promise<{ id: string; number: string }[]> {
  return items(await awaz("GET", "/phones")).map((p) => ({ id: String(p.id ?? p._id ?? ""), number: String(p.number ?? p.phone ?? "") }));
}

/** The full record of one call: outcome, transcript, after-call variables. */
export async function getCall(id: string): Promise<Record<string, any>> {
  return awaz("GET", `/calls/${encodeURIComponent(id)}`);
}

/** Place an outbound call now (or at an ISO time) from one of our numbers. */
export async function placeCall(opts: { agent: string; name: string; phone: string; from: string; datetime?: string }): Promise<string | undefined> {
  const r = await awaz("POST", "/calls", opts);
  return r?.id ?? r?.call?.id ?? r?.data?.id;
}

/** Ask Awaz to send call events for these agents straight to HQ (no Make needed). */
export async function subscribeCalls(hookUrl: string, agents: string[]): Promise<void> {
  await awaz("POST", "/hooks/calls", { hookUrl, agents, status: ["completed", "outcome", "failed"] });
}
