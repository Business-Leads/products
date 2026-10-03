import { randomUUID } from "node:crypto";
import { NotConfiguredError } from "../lib/util.js";

// Sbl.so (Second Brain Labs): Linkn's LinkedIn outreach. Its full API is the
// hosted MCP server at https://mcp.sbl.so/mcp (Streamable HTTP, JSON-RPC),
// authorised with an API key made at app.secondbrainlabs.com/mcp-server.
// HQ calls the tools directly; no AI is involved in these calls. Writes that
// send, launch or bill are only made after Felix approves them in HQ.

const URL_ = process.env.SBL_MCP_URL?.trim() || "https://mcp.sbl.so/mcp";

function creds(): { key: string; company: string } {
  const key = process.env.SBL_API_KEY?.trim();
  const company = process.env.SBL_COMPANY_ID?.trim();
  if (!key || !company) throw new NotConfiguredError("sblso", "SBL_API_KEY and SBL_COMPANY_ID are not set");
  return { key, company };
}

export function companyId(): string {
  return creds().company;
}

let session: string | undefined;
let nextId = 1;

/** Read a JSON-RPC reply that may come back as JSON or as a server-sent event stream. */
async function readRpc(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const datas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (const d of datas.reverse()) {
      try {
        const msg = JSON.parse(d);
        if (msg.result !== undefined || msg.error !== undefined) return msg;
      } catch {
        /* keep looking */
      }
    }
    throw new Error(`Sbl.so: no reply in stream (${text.slice(0, 200)})`);
  }
  return text ? JSON.parse(text) : {};
}

async function rpc(method: string, params: unknown, notify = false): Promise<any> {
  const { key } = creds();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (notify) return undefined;
  if (res.status === 404 && session) {
    // The session expired: start again once.
    session = undefined;
    await initialise();
    return rpc(method, params);
  }
  if (!res.ok) throw new Error(`Sbl.so ${method}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const msg = await readRpc(res);
  if (msg.error) throw new Error(`Sbl.so ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg.result;
}

async function initialise(): Promise<void> {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "online-business-builder-hq", version: "1.0" } });
  await rpc("notifications/initialized", {}, true);
}

/** Call one Sbl.so tool; JSON replies are parsed, text comes back as { text }. */
export async function sbl<T = any>(tool: string, args: Record<string, unknown>): Promise<T> {
  if (!session) await initialise();
  const result = await rpc("tools/call", { name: tool, arguments: { company_id: companyId(), ...args } });
  const text = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  if (result?.isError) throw new Error(`Sbl.so ${tool}: ${text.slice(0, 300)}`);
  if (result?.structuredContent) return result.structuredContent as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { text } as T;
  }
}

/** Dig a value out of a reply whose exact shape isn't documented. */
export function field(obj: any, ...names: string[]): any {
  for (const source of [obj, obj?.data, obj?.campaign, obj?.data?.campaign, obj?.result]) {
    if (!source || typeof source !== "object") continue;
    for (const n of names) if (source[n] !== undefined && source[n] !== null) return source[n];
  }
  return undefined;
}

export const listOf = (r: any): any[] =>
  Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : Array.isArray(r?.items) ? r.items : Array.isArray(r?.channels) ? r.channels : Array.isArray(r?.users) ? r.users : Array.isArray(r?.campaigns) ? r.campaigns : [];

export async function linkedinChannels(): Promise<{ id: number; name: string }[]> {
  return listOf(await sbl("sbl_list_linkedin_channels", {})).map((c) => ({ id: Number(c.id), name: String(c.name ?? c.displayName ?? "") }));
}

export async function getCampaign(campaignId: string | number): Promise<any> {
  return sbl("sbl_get_campaign", { campaign_id: String(campaignId), response_format: "json" });
}

export async function revisionOf(campaignId: string | number): Promise<number> {
  return Number(field(await getCampaign(campaignId), "revision", "version", "expectedRevision") ?? 1);
}

/** A draft campaign from a brief, bound to the client's own LinkedIn sender. Nothing is sent. */
export async function draftCampaign(brief: string, key: string, channelId: number): Promise<string> {
  const created = await sbl("sbl_create_campaign_from_prompt", { channel: "linkedin", description: brief, idempotency_key: key, response_format: "json" });
  const id = String(field(created, "id", "campaignId", "campaign_id") ?? "");
  if (!id) throw new Error("Sbl.so didn't return a campaign id");
  await sbl("sbl_bind_linkedin_channel", { company_id: Number(companyId()), campaign_id: Number(id), channel_id: channelId, expected_revision: await revisionOf(id) });
  return id;
}

/** Find leads matching the client's ideal customer and export them into the campaign (billable). */
export async function sourceLeads(campaignId: string, prompt: string, limit: number, key: string): Promise<void> {
  const s = await sbl("sbl_create_prompt_lead_session", { campaign_id: campaignId, prompt: prompt.slice(0, 2000), lead_limit: limit, idempotency_key: `${key}-session`, max_wait_seconds: 120 });
  const sessionId = String(field(s, "session_id", "sessionId", "id") ?? "");
  if (!sessionId) throw new Error("Sbl.so didn't return a lead session");
  await sbl("sbl_get_prompt_lead_session", { campaign_id: campaignId, session_id: sessionId, wait_for: "ready_to_export", max_wait_seconds: 120 });
  await sbl("sbl_approve_prompt_lead_sample", { campaign_id: campaignId, session_id: sessionId, approve_sample: true, idempotency_key: `${key}-export`, wait_for_terminal: true, max_wait_seconds: 120 });
}

export async function launch(campaignId: string, key: string): Promise<void> {
  await sbl("sbl_run_campaign", { campaign_id: campaignId, approval: true, expected_status: "CREATED", expected_revision: await revisionOf(campaignId), idempotency_key: key });
}

export interface WaitingLead {
  campaignId: string;
  userId: string;
  name: string;
  thread: string;
}

/** Leads who replied and need a person (Sbl.so's "human intervention" queue), with their threads. */
export async function waitingLeads(campaignIds: string[]): Promise<WaitingLead[]> {
  const out: WaitingLead[] = [];
  for (const campaignId of campaignIds) {
    const list = listOf(await sbl("sbl_list_human_intervention", { campaign_id: campaignId, response_format: "json" }));
    for (const u of list.slice(0, 15)) {
      const userId = String(u.id ?? u.userId ?? u.user_id ?? "");
      if (!userId) continue;
      const conv = await sbl("sbl_get_conversation", { campaign_id: campaignId, user_id: userId, response_format: "markdown" });
      out.push({ campaignId, userId, name: String(u.name ?? u.fullName ?? "a prospect"), thread: String(conv.text ?? JSON.stringify(conv)).slice(0, 6000) });
    }
  }
  return out;
}

export async function replyAndResolve(campaignId: string, userId: string, message: string, key: string): Promise<void> {
  await sbl("sbl_reply_and_resolve", { campaign_id: campaignId, user_id: userId, message, idempotency_key: key });
}

/** People who liked or commented on a post: a free preview for scoring before anything is imported. */
export async function previewEngagers(campaignId: string, postUrl: string, mode: "comments" | "likes", key: string): Promise<{ previewId: string; people: string }> {
  const r = await sbl("sbl_preview_post_engagement", { campaign_id: campaignId, post_url: postUrl, mode, selector: "any", limit: 25, idempotency_key: key });
  return { previewId: String(field(r, "preview_id", "previewId", "id") ?? ""), people: JSON.stringify(field(r, "items", "users", "people", "preview") ?? r).slice(0, 8000) };
}

export async function importEngagers(campaignId: string, previewId: string, key: string): Promise<void> {
  await sbl("sbl_import_post_engagement_leads", { campaign_id: campaignId, preview_id: previewId, operation_id: randomUUID(), idempotency_key: key });
}

export async function campaignInsights(campaignId: string): Promise<string> {
  const r = await sbl("sbl_get_campaign_analytics", { campaign_id: campaignId, response_format: "markdown" });
  return String(r.text ?? JSON.stringify(r)).slice(0, 6000);
}

export async function campaignUsers(campaignId: string, status?: string): Promise<any[]> {
  return listOf(await sbl("sbl_list_campaign_users", { campaign_id: campaignId, status, response_format: "json" }));
}
