import { timingSafeEqual } from "node:crypto";
import { one, query } from "../db/index.js";
import { emailOperator } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { createTask } from "../lib/tasks.js";
import { customerLabel, saveMetrics } from "./clients.js";
import type { CustomerRow } from "./types.js";
import { completeStep } from "./workflow.js";

// Awaz pushes call events for Speed to Lead clients to
// /webhooks/awaz/<AWAZ_WEBHOOK_TOKEN>. Each is stored as received, matched to a
// client by the assistant (agent) id saved on their page in HQ, and counted
// into their dashboard figures. Urgent or failed calls become inbox tasks.

export function awazTokenMatches(given: string): boolean {
  const expected = process.env.AWAZ_WEBHOOK_TOKEN?.trim();
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Payload = Record<string, any>;

/** The payload shape isn't documented to us yet, so look in the likely places. */
function pick(p: Payload, keys: string[]): any {
  for (const source of [p, p.data, p.call, p.payload].filter((x) => x && typeof x === "object")) {
    for (const k of keys) {
      const v = k.split(".").reduce<any>((o, part) => (o && typeof o === "object" ? o[part] : undefined), source);
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return undefined;
}

function text(p: Payload): string {
  return JSON.stringify(p).toLowerCase();
}

async function customerForAgent(agent: string | null): Promise<CustomerRow | undefined> {
  if (!agent) return undefined;
  return one<CustomerRow>(
    `SELECT * FROM customers WHERE product = 'speedtolead' AND status <> 'cancelled' AND data->'awaz_agent_ids' ? $1
     ORDER BY created_at DESC LIMIT 1`,
    [agent],
  );
}

async function refreshFigures(customer: CustomerRow): Promise<void> {
  const period = new Date().toISOString().slice(0, 7);
  const rows = await query<{ payload: Payload }>(
    `SELECT payload FROM awaz_events WHERE customer_id = $1 AND to_char(received_at, 'YYYY-MM') = $2`,
    [customer.id, period],
  );
  const t = rows.map((r) => text(r.payload));
  const existing = (customer.data.metrics_history ?? []).find((m: { period: string }) => m.period === period)?.values ?? {};
  await saveMetrics(customer.id, period, {
    ...existing,
    calls_answered: rows.length,
    jobs_booked: t.filter((s) => /book(ed|ing)|appointment/.test(s)).length,
    urgent_transfers: t.filter((s) => /transfer/.test(s)).length,
    call_backs: t.filter((s) => /call ?back/.test(s)).length,
  });
}

/** The automatic test calls: once three have come back, tick the step and send Felix the summaries. */
async function checkTestCalls(customer: CustomerRow): Promise<void> {
  const step = await one<{ id: string }>(`SELECT id FROM onboarding_steps WHERE customer_id = $1 AND key = 'test_calls' AND status = 'waiting'`, [customer.id]);
  if (!step) return;
  const rows = await query<{ payload: Payload }>(
    `SELECT payload FROM awaz_events WHERE customer_id = $1 AND received_at >= $2::timestamptz ORDER BY received_at`,
    [customer.id, customer.data.test_calls_started_at],
  );
  if (rows.length < 3) return;
  const summaries = rows
    .slice(0, 3)
    .map((r, i) => `Test call ${i + 1}: ${pick(r.payload, ["summary", "call_summary", "analysis.summary", "transcript_summary"]) ?? "(no summary; open it in Awaz)"}`)
    .join("\n\n");
  await emailOperator(`Speed to Lead: test calls done for ${customerLabel(customer)}`, `The assistant answered all three test calls.\n\n${summaries}`, "client_activity");
  await completeStep(step.id, "Three test calls answered by the assistant");
}

export async function handleAwazEvent(p: Payload): Promise<{ event: string; agent: string | null; matched: boolean }> {
  const event = String(pick(p, ["event", "event_type", "type", "status"]) ?? "call");
  const agentRaw = pick(p, ["agent_id", "agentId", "assistant_id", "assistantId", "agent.id", "assistant.id", "bot_id"]);
  const agent = agentRaw === undefined ? null : String(agentRaw);
  const customer = await customerForAgent(agent);
  await query(`INSERT INTO awaz_events (event, agent_id, customer_id, payload) VALUES ($1,$2,$3,$4)`, [
    event,
    agent,
    customer?.id ?? null,
    JSON.stringify(p),
  ]);
  const who = customer ? customerLabel(customer) : `assistant ${agent ?? "(unknown)"}`;
  const caller = pick(p, ["from", "caller", "phone_number", "customer_number", "from_number"]);
  const summary = pick(p, ["summary", "call_summary", "analysis.summary", "transcript_summary"]);
  const lowered = text(p);

  if (/fail|error/.test(event.toLowerCase())) {
    await createTask({
      kind: "alert",
      title: `A call didn't go through for ${who}`,
      body: `${caller ? `Caller: ${caller}\n` : ""}${summary ?? ""}\n\n---\n${JSON.stringify(p, null, 2).slice(0, 3000)}`,
      product: "speedtolead",
      customerId: customer?.id,
    });
  } else if (/gas|emergency|complain/.test(lowered)) {
    await createTask({
      kind: "manual",
      priority: 1,
      title: `Check a call for ${who}: it mentions an emergency or complaint`,
      body: `${caller ? `Caller: ${caller}\n` : ""}${summary ?? "Open the call in Awaz to listen."}`,
      product: "speedtolead",
      customerId: customer?.id,
    });
  }
  if (customer?.data.test_calls_started_at) await checkTestCalls(customer);
  if (!customer && agent && agent !== process.env.AWAZ_TEST_AGENT_ID?.trim()) {
    await createTask({
      kind: "alert",
      priority: 3,
      title: `Awaz assistant ${agent} isn't linked to a Speed to Lead client`,
      body: "Add this assistant id on the client's page in HQ (Awaz assistant) so their calls appear on their dashboard.",
      product: "speedtolead",
      dedupeKey: `awaz:unlinked:${agent}`,
    });
  }
  if (customer) await refreshFigures(customer);
  await logEvent({ type: `awaz.${event}`, message: `Call for ${who}${summary ? `: ${String(summary).slice(0, 120)}` : ""}`, product: "speedtolead", customerId: customer?.id });
  return { event, agent, matched: Boolean(customer) };
}
