import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { emailOperator } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { createTask } from "../lib/tasks.js";
import { customerLabel, saveMetrics } from "./clients.js";
import type { CustomerRow } from "./types.js";

// Sbl.so pushes LinkedIn outreach events for Linkn clients to
// /webhooks/sbl/<SBL_WEBHOOK_TOKEN>. Each event is stored as received, matched
// to a client by campaign id (set on the client's page in HQ), counted into
// their dashboard figures, and replies become inbox tasks.

export const SBL_EVENTS = [
  "connection_request_sent",
  "connection_request_accepted",
  "message_sent",
  "prospect_replied",
  "message_failed",
  "lead_action_needed",
] as const;

export function sblTokenMatches(given: string): boolean {
  const expected = config.sbl.webhookToken;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Payload = Record<string, any>;

/** The payload shape isn't documented to us yet, so look in the likely places. */
function pick(p: Payload, keys: string[]): any {
  for (const source of [p, p.data, p.payload, p.event_data].filter((x) => x && typeof x === "object")) {
    for (const k of keys) {
      const v = k.split(".").reduce<any>((o, part) => (o && typeof o === "object" ? o[part] : undefined), source);
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return undefined;
}

export function eventName(p: Payload): string {
  return String(pick(p, ["event", "event_type", "type", "name"]) ?? "unknown");
}

export function campaignId(p: Payload): string | null {
  const v = pick(p, ["campaign_id", "campaignId", "campaign.id", "campaign_uuid"]);
  return v === undefined ? null : String(v);
}

function prospectSummary(p: Payload): string {
  const name = pick(p, ["prospect.name", "lead.name", "user.name", "prospect_name", "name", "full_name"]);
  const company = pick(p, ["prospect.company", "lead.company", "user.company", "company"]);
  const profile = pick(p, ["prospect.linkedin_url", "lead.linkedin_url", "user.linkedin_profile_url", "linkedin_url", "profile_url"]);
  const message = pick(p, ["message.text", "message.content", "message", "reply", "text", "content"]);
  return [
    name ? `Who: ${name}${company ? `, ${company}` : ""}` : "",
    profile ? `Profile: ${profile}` : "",
    typeof message === "string" ? `Message:\n${message}` : "",
  ].filter(Boolean).join("\n");
}

async function customerForCampaign(id: string | null): Promise<CustomerRow | undefined> {
  if (!id) return undefined;
  return one<CustomerRow>(
    `SELECT * FROM customers WHERE product = 'linkn' AND status <> 'cancelled' AND data->'sbl_campaign_ids' ? $1
     ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
}

/** This month's outreach counts for the client's dashboard. */
async function refreshFigures(customer: CustomerRow): Promise<void> {
  const period = new Date().toISOString().slice(0, 7);
  const counts = await query<{ event: string; n: number }>(
    `SELECT event, count(*)::int AS n FROM sbl_events
     WHERE customer_id = $1 AND to_char(received_at, 'YYYY-MM') = $2 GROUP BY event`,
    [customer.id, period],
  );
  const n = (e: string) => counts.find((c) => c.event === e)?.n ?? 0;
  const existing = (customer.data.metrics_history ?? []).find((m: { period: string }) => m.period === period)?.values ?? {};
  await saveMetrics(customer.id, period, {
    ...existing,
    connection_requests: n("connection_request_sent"),
    replies: n("prospect_replied"),
  });
}

export async function handleSblEvent(p: Payload): Promise<{ event: string; campaign: string | null; matched: boolean }> {
  const event = eventName(p);
  const campaign = campaignId(p);
  const customer = await customerForCampaign(campaign);
  await query(`INSERT INTO sbl_events (event, campaign_id, customer_id, payload) VALUES ($1,$2,$3,$4)`, [
    event,
    campaign,
    customer?.id ?? null,
    JSON.stringify(p),
  ]);
  const who = customer ? customerLabel(customer) : `campaign ${campaign ?? "(unknown)"}`;
  const summary = prospectSummary(p);
  const raw = JSON.stringify(p, null, 2).slice(0, 4000);

  if (event === "prospect_replied" || event === "lead_action_needed") {
    await createTask({
      kind: "manual",
      priority: 1,
      title: event === "prospect_replied" ? `LinkedIn reply for ${who}` : `LinkedIn lead needs action for ${who}`,
      body: `${summary || "Details below."}\n\nOpen Sbl.so to reply; replies always go out with your approval.\n\n---\n${raw}`,
      product: "linkn",
      customerId: customer?.id,
    });
    if (event === "prospect_replied") {
      await emailOperator(`Linkn: a prospect replied for ${who}`, `${summary || "A prospect replied."}\n\nIt's in your HQ inbox.`, "client_activity");
    }
  } else if (event === "message_failed") {
    await createTask({
      kind: "alert",
      title: `LinkedIn message failed for ${who}`,
      body: `${summary}\n\n---\n${raw}`,
      product: "linkn",
      customerId: customer?.id,
    });
  }
  if (!customer && campaign) {
    await createTask({
      kind: "alert",
      priority: 3,
      title: `Sbl.so campaign ${campaign} isn't linked to a Linkn client`,
      body: "Add this campaign id on the client's page in HQ (Sbl.so campaigns) so its results appear on their dashboard.",
      product: "linkn",
      dedupeKey: `sbl:unlinked:${campaign}`,
    });
  }
  if (customer) await refreshFigures(customer);
  await logEvent({ type: `sbl.${event}`, message: `Sbl.so ${event.replace(/_/g, " ")}: ${who}`, product: "linkn", customerId: customer?.id });
  return { event, campaign, matched: Boolean(customer) };
}
