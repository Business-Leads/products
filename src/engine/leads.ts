import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { claudeConfigured, draftJson, emailSchema, type EmailDraft } from "../lib/claude.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { isProductPaused } from "../lib/settings.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage } from "../lib/util.js";
import { formatPrice, requireProduct, type Product } from "../products/index.js";

export interface LeadInput {
  product: string;
  name?: string;
  email?: string;
  phone?: string;
  business?: string;
  website?: string;
  town?: string;
  message?: string;
  source?: string;
  data?: Record<string, unknown>;
}

export interface LeadRow {
  id: string;
  product: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  business: string | null;
  website: string | null;
  town: string | null;
  message: string | null;
  data: Record<string, any>;
  source: string;
  status: string;
  touches: number;
  next_touch_at: Date | null;
  created_at: Date;
}

/** Record an enquiry from a product site. The first reply is drafted on the next scheduler tick. */
export async function createLead(input: LeadInput): Promise<{ id: string; duplicate: boolean }> {
  const product = requireProduct(input.product);
  const email = input.email?.trim().toLowerCase() || null;

  if (email) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM leads WHERE product = $1 AND lower(email) = $2 AND created_at > now() - interval '1 day'`,
      [product.slug, email],
    );
    if (existing) return { id: existing.id, duplicate: true };
  }

  const row = await one<{ id: string }>(
    `INSERT INTO leads (product, name, email, phone, business, website, town, message, data, source, next_touch_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING id`,
    [
      product.slug,
      input.name?.trim() || null,
      email,
      input.phone?.trim() || null,
      input.business?.trim() || null,
      input.website?.trim() || null,
      input.town?.trim() || null,
      input.message?.trim() || null,
      input.data ?? {},
      input.source ?? "website",
    ],
  );
  await logEvent({
    type: "lead.created",
    message: `New ${product.name} enquiry from ${input.business || input.name || email || "unknown"}`,
    product: product.slug,
    leadId: row!.id,
  });
  return { id: row!.id, duplicate: false };
}

function planLines(product: Product, leadId: string): string {
  if (product.quoted) return `Pricing is quoted per engagement. Booking link: ${product.bookingUrl}`;
  return product.plans
    .map(
      (p) =>
        `- ${p.name}: ${formatPrice(p.amountPence)} a ${p.interval}` +
        (p.setupFeePence ? ` plus ${formatPrice(p.setupFeePence)} setup` : "") +
        `. ${p.summary}\n  Start here: ${config.baseUrl}/buy/${product.slug}/${p.id}?lead=${leadId}`,
    )
    .join("\n");
}

function leadDetails(lead: LeadRow): string {
  const extra = Object.entries(lead.data ?? {})
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return [
    lead.name && `Name: ${lead.name}`,
    lead.business && `Business: ${lead.business}`,
    lead.town && `Town: ${lead.town}`,
    lead.website && `Website: ${lead.website}`,
    lead.message && `Their message: ${lead.message}`,
    ...extra,
  ]
    .filter(Boolean)
    .join("\n");
}

async function draftLeadEmail(product: Product, lead: LeadRow, touch: number): Promise<EmailDraft> {
  const first = touch === 0;
  if (!claudeConfigured()) {
    // Plain fallback so enquiries are never left unanswered while the Claude key is missing.
    return first
      ? {
          subject: `Your enquiry about ${product.name}`,
          body:
            `Hello ${lead.name?.split(/\s+/)[0] || "there"},\n\nThank you for getting in touch about ${product.name}.\n\n` +
            `${planLines(product, lead.id)}\n\nIf you'd like to talk it through first, ` +
            `you can book a short call here: ${product.bookingUrl}\n\nFelix`,
        }
      : {
          subject: `Following up: ${product.name}`,
          body:
            `Hello ${lead.name?.split(/\s+/)[0] || "there"},\n\nJust following up on your enquiry about ${product.name}. ` +
            `If it's still of interest, you can start here:\n\n${planLines(product, lead.id)}\n\n` +
            `Or book a short call: ${product.bookingUrl}\n\nFelix`,
        };
  }
  return draftJson<EmailDraft>({
    system:
      `You reply to enquiries for ${product.name}. ${product.description}\n\nVoice: ${product.voice}\n` +
      "Use only the facts, prices and links provided. Keep it under 200 words. Include the relevant sign-up " +
      "link or the booking link exactly as given. End with a line saying they can reply 'stop' to hear no more.",
    prompt:
      `Enquiry:\n${leadDetails(lead)}\n\nPlans and links:\n${planLines(product, lead.id)}\n` +
      `Booking link: ${product.bookingUrl}\n\n` +
      (first
        ? `Write the first reply to this enquiry. ${product.leadBrief ?? ""}`
        : `Write follow-up number ${touch}. They have not signed up yet. Be brief and helpful, add one new ` +
          "reason it might be worth their time, and do not pressure them."),
    schema: emailSchema,
    maxTokens: 8000,
  });
}

/** Reply to new enquiries and send follow-ups to those who haven't signed up. */
export async function processLeads(): Promise<{ drafted: number; failed: number }> {
  const due = await query<LeadRow>(
    `SELECT * FROM leads WHERE status IN ('new','contacted') AND next_touch_at <= now()
     ORDER BY next_touch_at LIMIT 25`,
  );
  let drafted = 0;
  let failed = 0;
  for (const lead of due) {
    const product = requireProduct(lead.product);
    if (await isProductPaused(product.slug)) continue;

    if (!lead.email) {
      await query(`UPDATE leads SET status = 'contacted', next_touch_at = NULL, updated_at = now() WHERE id = $1`, [lead.id]);
      await createTask({
        kind: "manual",
        title: `Call ${lead.name || lead.business || "new enquiry"} (${product.name}, no email given)`,
        body: `Phone: ${lead.phone ?? "none"}\n\n${leadDetails(lead)}`,
        product: product.slug,
        leadId: lead.id,
        dedupeKey: `lead-call:${lead.id}`,
      });
      continue;
    }

    try {
      const draft = await draftLeadEmail(product, lead, lead.touches);
      await queueEmail({
        product: product.slug,
        leadId: lead.id,
        kind: lead.touches === 0 ? "lead_reply" : "lead_followup",
        to: lead.email,
        subject: draft.subject,
        body: draft.body,
        autonomy: "approve",
        autonomyKey: "lead_replies",
      });
      const followUps = product.leadFollowUpDays;
      const nextDay = followUps[lead.touches];
      await query(
        `UPDATE leads SET touches = touches + 1, updated_at = now(),
           status = CASE WHEN $2::int IS NULL THEN 'followed_up' ELSE 'contacted' END,
           next_touch_at = CASE WHEN $2::int IS NULL THEN NULL ELSE created_at + ($2::int * interval '1 day') END
         WHERE id = $1`,
        [lead.id, nextDay ?? null],
      );
      drafted++;
    } catch (err) {
      failed++;
      await query(`UPDATE leads SET next_touch_at = now() + interval '30 minutes' WHERE id = $1`, [lead.id]);
      await logEvent({
        type: "lead.reply_failed",
        level: "error",
        message: `Could not draft a reply to ${lead.email}: ${errorMessage(err)}`,
        product: product.slug,
        leadId: lead.id,
      });
    }
  }
  return { drafted, failed };
}

/** Stop following up once someone buys or asks us to stop. */
export async function markLeadWon(leadId: string | null, customerId: string, email: string, product: string) {
  await query(
    `UPDATE leads SET status = 'won', customer_id = $3, next_touch_at = NULL, updated_at = now()
     WHERE (id = $1 OR (product = $4 AND lower(email) = lower($2))) AND status <> 'won'`,
    [leadId, email, customerId, product],
  );
}
