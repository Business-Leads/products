import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { claudeConfigured, draftJson } from "../lib/claude.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage } from "../lib/util.js";
import { getProduct } from "../products/index.js";
import { createLead } from "./leads.js";
import { suppress } from "./outreach.js";

export interface InboundMessage {
  messageId?: string;
  from: string;
  subject: string;
  text: string;
  autoSubmitted?: boolean;
}

type Intent = "auto_reply" | "stop" | "not_interested" | "interested" | "question" | "other";

const AUTO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on leave|delivery status notification|undeliverable|mail delivery failed)/i;
const STOP = /^\s*(stop|unsubscribe|remove me|take me off|please remove|no thanks|not interested)\b/i;

/** Keep only what the person wrote, not the quoted thread below it. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: .+/.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, 8000);
}

/** Decide what an inbound message is and act on it. Exported for tests. */
export async function handleInbound(msg: InboundMessage): Promise<Intent> {
  const from = msg.from.trim().toLowerCase();
  if (msg.messageId && (await one(`SELECT 1 FROM inbound_emails WHERE message_id = $1`, [msg.messageId]))) return "other";

  const customer = await one(
    `SELECT * FROM customers WHERE lower(email) = $1 OR lower(data->'intake'->>'report_email') = $1
       OR lower(data->'intake'->>'notify_email') = $1
     ORDER BY status = 'cancelled', created_at DESC LIMIT 1`,
    [from],
  );
  let lead = customer
    ? undefined
    : await one(`SELECT * FROM leads WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT 1`, [from]);
  const prospect =
    customer || lead
      ? undefined
      : await one(`SELECT * FROM prospects WHERE lower(email) = $1 ORDER BY updated_at DESC LIMIT 1`, [from]);
  const productSlug: string | null = customer?.product ?? lead?.product ?? prospect?.product ?? null;
  const product = productSlug ? getProduct(productSlug) : undefined;
  const body = stripQuoted(msg.text);

  let intent: Intent = "other";
  let summary = "";
  let reply: { subject: string; body: string } | undefined;

  if (msg.autoSubmitted || AUTO_SUBJECT.test(msg.subject)) {
    intent = "auto_reply";
  } else if (!customer && (STOP.test(body) || STOP.test(msg.subject))) {
    intent = "stop";
  } else if (claudeConfigured() && product) {
    try {
      const r = await draftJson<{ intent: Intent; summary: string; reply_subject: string; reply_body: string }>({
        system:
          `You triage email replies for ${product.name}. ${product.description}\n\nVoice for replies: ${product.voice}\n` +
          "Classify the message and, unless it is a request to stop or a clear no, draft a short helpful reply. " +
          "Never invent facts, prices or commitments; if something needs Felix's judgement, say he will reply personally.",
        prompt:
          `Sender is ${customer ? `an existing ${product.name} customer (plan ${customer.plan}, status ${customer.status})` : "someone who enquired but has not bought"}.\n` +
          `Booking link: ${product.bookingUrl}\n\nSubject: ${msg.subject}\n\n${body}`,
        schema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: ["auto_reply", "stop", "not_interested", "interested", "question", "other"] },
            summary: { type: "string", description: "One sentence: what they said and what they want." },
            reply_subject: { type: "string" },
            reply_body: { type: "string", description: "Plain-text reply, or empty if no reply is needed." },
          },
          required: ["intent", "summary", "reply_subject", "reply_body"],
          additionalProperties: false,
        },
        maxTokens: 8000,
      });
      intent = customer && (r.intent === "stop" || r.intent === "not_interested") ? "question" : r.intent;
      summary = r.summary;
      if (r.reply_body.trim()) reply = { subject: r.reply_subject || `Re: ${msg.subject}`, body: r.reply_body };
    } catch (err) {
      summary = `Could not classify automatically: ${errorMessage(err)}`;
    }
  }

  const row = await one<{ id: string }>(
    `INSERT INTO inbound_emails (message_id, from_address, subject, body_text, product, lead_id, customer_id, intent, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [msg.messageId ?? null, from, msg.subject, body, productSlug, lead?.id ?? null, customer?.id ?? null, intent, summary || null],
  );
  const inboundId = row!.id;
  const who = customer?.business || customer?.name || lead?.business || lead?.name || from;

  if (intent === "auto_reply") return intent;

  if (prospect) {
    await query(`UPDATE inbound_emails SET prospect_id = $2 WHERE id = $1`, [inboundId, prospect.id]);
    if (intent === "stop" || intent === "not_interested") {
      await suppress(from, intent === "stop" ? "Asked to stop (outreach reply)" : "Not interested (outreach reply)");
      await logEvent({ type: "outreach.stop", message: `${prospect.business ?? from} asked not to be contacted`, product: productSlug });
      return intent;
    }
    // A prospect who replies becomes a lead, handled from here like any other enquiry.
    const created = await createLead({
      product: prospect.product,
      name: prospect.name ?? undefined,
      email: from,
      business: prospect.business ?? undefined,
      website: prospect.website ?? undefined,
      town: prospect.town ?? undefined,
      message: body,
      source: "outreach reply",
    });
    await query(`UPDATE prospects SET status = 'replied', next_send_at = NULL, lead_id = $2, updated_at = now() WHERE id = $1`, [
      prospect.id,
      created.id,
    ]);
    await query(`UPDATE emails SET status = 'cancelled' WHERE prospect_id = $1 AND status IN ('draft','queued')`, [prospect.id]);
    lead = await one(`SELECT * FROM leads WHERE id = $1`, [created.id]);
    await query(`UPDATE inbound_emails SET lead_id = $2 WHERE id = $1`, [inboundId, created.id]);
  }

  if (lead && (intent === "stop" || intent === "not_interested")) {
    const status = intent === "stop" ? "unsubscribed" : "lost";
    if (intent === "stop") await suppress(from, "Asked to stop (lead reply)");
    await query(`UPDATE leads SET status = $2, next_touch_at = NULL, updated_at = now() WHERE lower(email) = $1`, [from, status]);
    await query(`UPDATE emails SET status = 'cancelled' WHERE lower(to_address) = $1 AND status IN ('draft','queued')`, [from]);
    await query(
      `UPDATE tasks SET status = 'dismissed', resolution = 'Lead asked to stop', resolved_at = now()
       WHERE lead_id IN (SELECT id FROM leads WHERE lower(email) = $1) AND status = 'open'`,
      [from],
    );
    await logEvent({ type: `lead.${status}`, message: `${who} replied: ${intent === "stop" ? "asked us to stop" : "not interested"}`, product: productSlug, leadId: lead.id });
    return intent;
  }

  // A person replied: stop automated follow-ups and put the conversation in front of a human.
  if (lead) {
    await query(`UPDATE leads SET status = 'replied', next_touch_at = NULL, updated_at = now() WHERE id = $1`, [lead.id]);
    await query(`UPDATE emails SET status = 'cancelled' WHERE lead_id = $1 AND status = 'queued' AND kind = 'lead_followup'`, [lead.id]);
  }
  await logEvent({
    type: "inbound.reply",
    message: `Reply from ${who}${summary ? `: ${summary}` : ""}`,
    product: productSlug,
    customerId: customer?.id,
    leadId: lead?.id,
  });

  if (reply && product) {
    // Replies always wait for approval: they answer a real person's specific message.
    await queueEmail({
      product: product.slug,
      customerId: customer?.id,
      leadId: lead?.id,
      kind: "reply",
      to: from,
      subject: reply.subject,
      body: reply.body,
      autonomy: "approve",
      taskPayload: { inboundId },
    });
  } else {
    await createTask({
      kind: "manual",
      title: `Reply from ${who}${product ? ` (${product.name})` : ""}`,
      body: `${summary ? `${summary}\n\n` : ""}From: ${from}\nSubject: ${msg.subject}\n\n${body}`,
      product: productSlug,
      customerId: customer?.id,
      leadId: lead?.id,
      dedupeKey: `inbound:${inboundId}`,
    });
  }
  return intent;
}

/** Read unseen mail from the monitored mailbox. Runs every few minutes. */
export async function processInbound(): Promise<string> {
  if (!config.imap.url) return "IMAP_URL not set";
  const url = new URL(config.imap.url);
  const client = new ImapFlow({
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "imaps:" ? 993 : 143),
    secure: url.protocol === "imaps:",
    auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    logger: false,
  });
  await client.connect();
  let handled = 0;
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const seen: number[] = [];
      for await (const m of client.fetch({ seen: false }, { uid: true, source: true })) {
        if (!m.source) continue;
        const parsed = await simpleParser(m.source);
        const from = parsed.from?.value[0]?.address;
        if (from) {
          const auto = parsed.headers.get("auto-submitted");
          await handleInbound({
            messageId: parsed.messageId,
            from,
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            autoSubmitted: Boolean(auto && String(auto).toLowerCase() !== "no"),
          });
          handled++;
        }
        seen.push(m.uid);
        if (seen.length >= 50) break;
      }
      if (seen.length) await client.messageFlagsAdd(seen, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return `${handled} message(s) handled`;
}
