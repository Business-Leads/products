import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { getProduct } from "../products/index.js";
import { logEvent } from "./events.js";
import { autonomyFor, isProductPaused, type Autonomy } from "./settings.js";
import { clearAlert, createTask } from "./tasks.js";
import { errorMessage } from "./util.js";

let transport: Transporter | null = null;

export function smtpConfigured(): boolean {
  return Boolean(config.smtp.url);
}

function getTransport(): Transporter {
  // SMTP_URL=log prints emails as JSON instead of sending them (local testing).
  transport ??= config.smtp.url === "log" ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(config.smtp.url);
  return transport;
}

export interface EmailInput {
  product?: string | null;
  customerId?: number | string | null;
  leadId?: number | string | null;
  prospectId?: number | string | null;
  kind: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  sendAfter?: Date;
  /** "approve" holds the email as a draft with an approval task in the inbox. */
  autonomy?: Autonomy;
  /** Autonomy setting key to look up for the product, e.g. "lead_replies". */
  autonomyKey?: string;
  /** Extra data for the approval task, e.g. the onboarding step it belongs to. */
  taskPayload?: Record<string, unknown>;
}

export interface QueuedEmail {
  id: string;
  held: boolean;
  taskId?: string;
}

function footer(productSlug?: string | null): string {
  const product = productSlug ? getProduct(productSlug) : undefined;
  return product ? `\n\n--\n${product.entity}` : "";
}

/** Queue an email, or hold it as a draft with an approval task. */
export async function queueEmail(e: EmailInput): Promise<QueuedEmail> {
  const product = e.product ? getProduct(e.product) : undefined;
  let autonomy = e.autonomy ?? "auto";
  if (e.product && e.autonomyKey) autonomy = await autonomyFor(e.product, e.autonomyKey, autonomy);

  const from = product ? `${product.email.fromName} <${product.email.from}>` : `Products HQ <${config.admin.alertEmail}>`;
  const status = autonomy === "approve" ? "draft" : "queued";
  const row = await one<{ id: string }>(
    `INSERT INTO emails (product, customer_id, lead_id, kind, to_address, from_address, reply_to, subject, body_text, status, send_after, prospect_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      e.product ?? null,
      e.customerId ?? null,
      e.leadId ?? null,
      e.kind,
      e.to,
      from,
      e.replyTo ?? product?.email.replyTo ?? (e.product ? config.smtp.replyTo || null : null),
      e.subject,
      e.body + footer(e.product),
      status,
      e.sendAfter ?? new Date(),
      e.prospectId ?? null,
    ],
  );
  const id = row!.id;

  if (status === "draft") {
    const task = await createTask({
      kind: "approval",
      title: `Approve email: ${e.subject}`,
      body: `To: ${e.to}\n\n${e.body}`,
      product: e.product,
      customerId: e.customerId,
      leadId: e.leadId,
      action: "send_email",
      payload: { ...e.taskPayload, emailId: id },
      dedupeKey: `email:${id}`,
    });
    return { id, held: true, taskId: task.id };
  }
  return { id, held: false };
}

/** Send everything due in the outbox. Called by the scheduler every minute. */
export async function sendDueEmails(limit = 50): Promise<{ sent: number; failed: number; held: number }> {
  const due = await query(
    `SELECT * FROM emails WHERE status = 'queued' AND send_after <= now() AND attempts < 5
     ORDER BY send_after LIMIT $1`,
    [limit],
  );
  if (due.length && !smtpConfigured()) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: "Emails are waiting but sending is not connected",
      body: `${due.length} email(s) are queued. Set SMTP_URL in the app's settings on DigitalOcean.`,
      dedupeKey: "alert:smtp-not-configured",
    });
    return { sent: 0, failed: 0, held: due.length };
  }
  await clearAlert("alert:smtp-not-configured");

  let sent = 0;
  let failed = 0;
  let held = 0;
  for (const email of due) {
    // Customer and lead email stops while a product is paused; alerts to the operator still go.
    if (email.product && (await isProductPaused(email.product))) {
      held++;
      continue;
    }
    try {
      await getTransport().sendMail({
        from: email.from_address,
        to: email.to_address,
        replyTo: email.reply_to ?? undefined,
        subject: email.subject,
        text: email.body_text,
      });
      await query(`UPDATE emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1`, [
        email.id,
      ]);
      sent++;
    } catch (err) {
      failed++;
      const attempts = email.attempts + 1;
      await query(
        `UPDATE emails SET attempts = $2, error = $3, status = CASE WHEN $2 >= 5 THEN 'failed' ELSE status END,
         send_after = now() + ($2 * interval '10 minutes') WHERE id = $1`,
        [email.id, attempts, errorMessage(err)],
      );
      if (attempts >= 5) {
        await logEvent({
          type: "email.failed",
          level: "error",
          message: `Email to ${email.to_address} failed after 5 attempts: ${errorMessage(err)}`,
          product: email.product,
          customerId: email.customer_id,
          leadId: email.lead_id,
        });
        await createTask({
          kind: "alert",
          title: `Email could not be sent: ${email.subject}`,
          body: `To ${email.to_address}. Last error: ${errorMessage(err)}`,
          product: email.product,
          customerId: email.customer_id,
          dedupeKey: `alert:email-failed:${email.id}`,
        });
      }
    }
  }
  return { sent, failed, held };
}

/** Email the operator directly (digest, urgent alerts). Bypasses approval. */
export async function emailOperator(subject: string, body: string, kind = "alert"): Promise<void> {
  await queueEmail({ kind, to: config.admin.alertEmail, subject, body });
}
