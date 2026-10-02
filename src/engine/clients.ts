import type Stripe from "stripe";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { claudeAvailable, draftJson } from "../lib/claude.js";
import { emailOperator, queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { getStripe, META_PLAN, META_PRODUCT } from "../lib/stripe.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage, fmtDate } from "../lib/util.js";
import { portalUrl } from "../portal/accounts.js";
import { formatPrice, getPlan, requireProduct, type Plan, type Product } from "../products/index.js";
import type { CustomerRow, StepRow } from "./types.js";
import { advanceOnboarding, completeStep, loadCustomer } from "./workflow.js";

// Everything a client can do from their account area, and the bookkeeping
// behind it. Each action is logged, and the operator is emailed about it.

export function customerLabel(c: Pick<CustomerRow, "business" | "name" | "email">): string {
  return c.business || c.name || c.email;
}

function adminLink(customerId: string): string {
  return `/customers/${customerId}`;
}

async function alert(customer: CustomerRow, product: Product, subject: string, body: string, kind: string): Promise<void> {
  await emailOperator(
    `${product.name}: ${subject}`,
    `${body}\n\nClient: ${customerLabel(customer)} <${customer.email}>\nIn HQ: ${config.baseUrl}${adminLink(customer.id)}`,
    kind,
  );
}

// ------------------------------------------------------------------ intake

/** Save the onboarding form. Returns the labels of missing required fields, if any. */
export async function saveIntake(customer: CustomerRow, body: Record<string, unknown>): Promise<string[]> {
  const product = requireProduct(customer.product);
  const answers: Record<string, string> = {};
  for (const f of product.intake) answers[f.key] = String(body[f.key] ?? "").trim().slice(0, 5000);
  const missing = product.intake.filter((f) => f.required && !answers[f.key]).map((f) => f.label);
  if (missing.length) return missing;

  const first = !customer.data.intake_completed_at;
  await query(
    `UPDATE customers SET name = COALESCE(NULLIF($2,''), name), business = COALESCE(NULLIF($3,''), business),
       data = data || jsonb_build_object('intake', $4::jsonb, 'intake_completed_at', to_jsonb(now())), updated_at = now()
     WHERE id = $1`,
    [customer.id, String(body.name ?? "").trim(), answers.business || answers.company || answers.organisation || "", JSON.stringify(answers)],
  );
  const label = answers.business || answers.company || customer.email;
  await logEvent({
    type: first ? "intake.completed" : "intake.updated",
    message: `${label} ${first ? "completed" : "updated"} the onboarding form`,
    product: product.slug,
    customerId: customer.id,
  });
  if (first) {
    await alert(customer, product, `onboarding form completed by ${label}`, `${label} has filled in their onboarding form. Setup carries on automatically.`, "client_activity");
  }
  await advanceOnboarding(customer.id);
  return [];
}

// --------------------------------------------------------- onboarding call

export async function markCallBooked(customer: CustomerRow, when?: string): Promise<void> {
  if (customer.data.call_booked_at) return;
  const product = requireProduct(customer.product);
  await query(
    `UPDATE customers SET data = data || jsonb_build_object('call_booked_at', to_jsonb(now()), 'call_time', $2::text), updated_at = now() WHERE id = $1`,
    [customer.id, when ?? null],
  );
  await logEvent({ type: "call.booked", message: `${customerLabel(customer)} booked their onboarding call`, product: product.slug, customerId: customer.id });
  await alert(
    customer,
    product,
    `onboarding call booked by ${customerLabel(customer)}`,
    `${customerLabel(customer)} has booked their onboarding call${when ? ` (${when})` : ""}. It's in your calendar.`,
    "client_activity",
  );
}

// ------------------------------------------------------------------ support

export async function createSupportRequest(customer: CustomerRow, subject: string, message: string): Promise<string> {
  const product = requireProduct(customer.product);
  const row = await one<{ id: string }>(
    `INSERT INTO support_requests (customer_id, product, subject, message) VALUES ($1,$2,$3,$4) RETURNING id`,
    [customer.id, product.slug, subject.slice(0, 200), message.slice(0, 10000)],
  );
  const task = await createTask({
    kind: "manual",
    priority: 1,
    title: `Support request from ${customerLabel(customer)}: ${subject}`,
    body: `${message}\n\nReply from the Support page in HQ; the reply is emailed to them and shown in their account.`,
    product: product.slug,
    customerId: customer.id,
    payload: { supportId: row!.id },
    dedupeKey: `support:${row!.id}`,
  });
  await query(`UPDATE support_requests SET task_id = $2 WHERE id = $1`, [row!.id, task.id]);
  await logEvent({ type: "support.request", message: `${customerLabel(customer)}: ${subject}`, product: product.slug, customerId: customer.id });
  await alert(customer, product, `support request from ${customerLabel(customer)}`, `Subject: ${subject}\n\n${message}`, "support");
  await queueEmail({
    product: product.slug,
    customerId: customer.id,
    kind: "support_ack",
    to: customer.email,
    subject: `We've got your message: ${subject}`,
    body: `Hello,\n\nThanks for getting in touch. We've got your message and will reply within one working day. ` +
      `You can see our reply in your account too:\n\n${portalUrl(product)}/support\n\nFelix`,
  });
  return row!.id;
}

export async function replyToSupport(id: string, reply: string, close = true): Promise<void> {
  const request = await one(`SELECT * FROM support_requests WHERE id = $1`, [id]);
  if (!request) return;
  const customer = await loadCustomer(request.customer_id);
  if (!customer) return;
  const product = requireProduct(customer.product);
  await query(`UPDATE support_requests SET reply = $2, replied_at = now(), status = $3 WHERE id = $1`, [id, reply, close ? "answered" : "open"]);
  if (request.task_id) {
    await query(`UPDATE tasks SET status = 'done', resolution = 'Replied', resolved_at = now() WHERE id = $1 AND status = 'open'`, [request.task_id]);
  }
  await queueEmail({
    product: product.slug,
    customerId: customer.id,
    kind: "support_reply",
    to: customer.email,
    subject: `Re: ${request.subject}`,
    body: `${reply}\n\nYou can see this in your account at ${portalUrl(product)}/support`,
  });
  await logEvent({ type: "support.replied", message: `Replied to ${customerLabel(customer)}: ${request.subject}`, product: product.slug, customerId: customer.id });
}

// ----------------------------------------------------------------- updates

export async function postUpdate(
  customer: CustomerRow,
  u: { title: string; body?: string; link?: string; approvalStep?: string },
): Promise<void> {
  const product = requireProduct(customer.product);
  await query(`INSERT INTO client_updates (customer_id, title, body, link, approval_step) VALUES ($1,$2,$3,$4,$5)`, [
    customer.id,
    u.title,
    u.body ?? "",
    u.link || null,
    u.approvalStep || null,
  ]);
  await logEvent({ type: "update.posted", message: `Update for ${customerLabel(customer)}: ${u.title}`, product: product.slug, customerId: customer.id });
  await queueEmail({
    product: product.slug,
    customerId: customer.id,
    kind: "client_update",
    to: customer.email,
    subject: `${product.name}: ${u.title}`,
    body:
      `Hello,\n\n${u.body ? `${u.body}\n\n` : ""}${u.link ? `${u.link}\n\n` : ""}` +
      (u.approvalStep ? "Please approve it, or tell us what to change, in your account:\n\n" : "You can see everything in your account:\n\n") +
      `${portalUrl(product)}\n\nFelix`,
  });
}

/** The client approves (or asks for changes to) something we sent them. */
export async function respondToUpdate(customer: CustomerRow, updateId: string, approved: boolean, note: string): Promise<boolean> {
  const update = await one(
    `UPDATE client_updates SET response = $3, response_note = $4, responded_at = now()
     WHERE id = $1 AND customer_id = $2 AND approval_step IS NOT NULL AND response IS NULL RETURNING *`,
    [updateId, customer.id, approved ? "approved" : "changes", note.slice(0, 5000) || null],
  );
  if (!update) return false;
  const product = requireProduct(customer.product);
  if (approved) {
    const step = await one<StepRow>(`SELECT * FROM onboarding_steps WHERE customer_id = $1 AND key = $2`, [customer.id, update.approval_step]);
    if (step && step.status !== "done" && step.status !== "skipped") {
      await query(
        `UPDATE tasks SET status = 'done', resolution = 'Approved by the client', resolved_at = now()
         WHERE status = 'open' AND (id = $1 OR (payload->>'stepId') = $2)`,
        [step.task_id, String(step.id)],
      );
      await completeStep(step.id, "approved by the client");
    }
    await alert(customer, product, `${customerLabel(customer)} approved "${update.title}"`, note || "No comments.", "client_activity");
  } else if (update.approval_step === "design_approved" && product.onboarding.some((s) => s.handler === "obb_build_site")) {
    // Website changes go straight back to the builder with the client's notes.
    await query(
      `UPDATE customers SET data = jsonb_set(data, '{site_changes}', COALESCE(data->'site_changes', '[]'::jsonb) || to_jsonb($2::text)), updated_at = now() WHERE id = $1`,
      [customer.id, note || "Please improve it"],
    );
    await query(
      `UPDATE onboarding_steps SET status = 'pending', completed_at = NULL, task_id = NULL, attempts = 0
       WHERE customer_id = $1 AND key IN ('website_design', 'design_approved')`,
      [customer.id],
    );
    await alert(customer, product, `${customerLabel(customer)} asked for website changes`, `${note}\n\nThe site is being rebuilt with these changes and they'll be sent the new version automatically.`, "client_activity");
    await advanceOnboarding(customer.id);
  } else {
    await createTask({
      kind: "manual",
      priority: 1,
      title: `Changes requested by ${customerLabel(customer)}: ${update.title}`,
      body: `${note || "(no details given)"}\n\nMake the changes, then post a new update for them to approve.`,
      product: product.slug,
      customerId: customer.id,
      dedupeKey: `changes:${update.id}`,
    });
    await alert(customer, product, `${customerLabel(customer)} asked for changes to "${update.title}"`, note || "(no details given)", "client_activity");
  }
  await logEvent({
    type: approved ? "update.approved" : "update.changes",
    message: `${customerLabel(customer)} ${approved ? "approved" : "asked for changes to"} "${update.title}"`,
    product: product.slug,
    customerId: customer.id,
  });
  return true;
}

// ----------------------------------------------------------------- metrics

export interface MetricsSnapshot {
  period: string;
  values: Record<string, number>;
  at: string;
}

/** Store headline figures for the client's dashboard (latest plus a year of history). */
export async function saveMetrics(customerId: string, period: string, values: Record<string, number | null>): Promise<void> {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
  if (!Object.keys(clean).length) return;
  const customer = await loadCustomer(customerId);
  if (!customer) return;
  const history: MetricsSnapshot[] = (customer.data.metrics_history ?? []).filter((m: MetricsSnapshot) => m.period !== period);
  history.push({ period, values: clean, at: new Date().toISOString() });
  history.sort((a, b) => a.period.localeCompare(b.period));
  await query(`UPDATE customers SET data = data || jsonb_build_object('metrics_history', $2::jsonb), updated_at = now() WHERE id = $1`, [
    customerId,
    JSON.stringify(history.slice(-12)),
  ]);
}

/** Pull the dashboard figures out of report data a person pasted in. Best effort. */
export async function extractMetrics(customer: CustomerRow, period: string, text: string): Promise<void> {
  const product = requireProduct(customer.product);
  if (!product.portal.metrics.length || !text.trim() || !(await claudeAvailable())) return;
  const properties = Object.fromEntries(
    product.portal.metrics.map((m) => [m.key, { anyOf: [{ type: "number" }, { type: "null" }], description: m.label }]),
  );
  try {
    const values = await draftJson<Record<string, number | null>>({
      system: "You extract figures from report data. Use null for anything not stated. Never estimate.",
      prompt: `Report data for ${product.name}:\n\n${text}\n\nExtract the figures for this period.`,
      schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
      maxTokens: 4000,
    });
    await saveMetrics(customer.id, period, values);
  } catch (err) {
    await logEvent({ type: "metrics.failed", level: "warn", message: `Couldn't read figures: ${errorMessage(err)}`, product: product.slug, customerId: customer.id });
  }
}

// ----------------------------------------------------------- subscriptions

/** Higher-priced plans on the same billing interval. */
export function upgradeOptions(customer: CustomerRow): Plan[] {
  const product = requireProduct(customer.product);
  const current = getPlan(product, customer.plan);
  if (!current || product.quoted) return [];
  return product.plans.filter((p) => p.interval === current.interval && p.amountPence > current.amountPence);
}

export async function upgradePlan(customer: CustomerRow, planId: string): Promise<void> {
  const product = requireProduct(customer.product);
  const current = getPlan(product, customer.plan);
  const plan = upgradeOptions(customer).find((p) => p.id === planId);
  if (!plan || !current) throw new Error("That plan isn't available as an upgrade.");
  if (!customer.stripe_subscription_id) throw new Error("This account isn't billed online; please contact us to change plan.");

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
  const item = sub.items.data.find((i) => i.price.unit_amount === current.amountPence) ?? sub.items.data[0];
  if (!item) throw new Error("Subscription has no items");
  const stripeProduct = await stripe.products.create({
    name: `${product.name}: ${plan.name}`,
    metadata: { [META_PRODUCT]: product.slug, [META_PLAN]: plan.id },
  });
  await stripe.subscriptions.update(sub.id, {
    items: [
      {
        id: item.id,
        price_data: { currency: "gbp", product: stripeProduct.id, unit_amount: plan.amountPence, recurring: { interval: plan.interval } },
      },
    ],
    proration_behavior: "create_prorations",
    metadata: { ...sub.metadata, [META_PLAN]: plan.id },
  });

  await query(`UPDATE customers SET plan = $2, amount_pence = amount_pence - $3 + $4, updated_at = now() WHERE id = $1`, [
    customer.id,
    plan.id,
    current.amountPence,
    plan.amountPence,
  ]);
  // Onboarding steps that only apply to the new plan start now.
  for (const step of product.onboarding) {
    if (step.plans?.includes(plan.id) && !step.plans.includes(current.id)) {
      await query(`UPDATE onboarding_steps SET status = 'pending', completed_at = NULL WHERE customer_id = $1 AND key = $2 AND status = 'skipped'`, [
        customer.id,
        step.key,
      ]);
    }
  }
  await logEvent({
    type: "customer.upgraded",
    message: `${customerLabel(customer)} upgraded from ${current.name} to ${plan.name}`,
    product: product.slug,
    customerId: customer.id,
  });
  await alert(
    customer,
    product,
    `${customerLabel(customer)} upgraded to ${plan.name}`,
    `${customerLabel(customer)} moved from ${current.name} to ${plan.name} (${formatPrice(plan.amountPence, plan.interval)}). ` +
      `The difference is charged pro rata on their next invoice. Any extra setup for the new plan has been added to their onboarding.`,
    "client_activity",
  );
  await queueEmail({
    product: product.slug,
    customerId: customer.id,
    kind: "upgraded",
    to: customer.email,
    subject: `You're now on ${product.name} ${plan.name}`,
    body:
      `Hello,\n\nThis confirms your move to ${plan.name} (${formatPrice(plan.amountPence, plan.interval)}). ` +
      `The difference for the rest of this billing period is added to your next invoice. We'll be in touch about ` +
      `anything new we need from you.\n\nFelix`,
  });
  await advanceOnboarding(customer.id);
}

function cancelDate(sub: Stripe.Subscription): Date | null {
  const end = sub.cancel_at ?? (sub.items.data[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end;
  return end ? new Date(end * 1000) : null;
}

/** Cancel at the end of the paid period. */
export async function requestCancellation(customer: CustomerRow, reason: string): Promise<Date | null> {
  const product = requireProduct(customer.product);
  let endsAt: Date | null = null;
  if (customer.stripe_subscription_id) {
    const sub = await getStripe().subscriptions.update(customer.stripe_subscription_id, { cancel_at_period_end: true });
    endsAt = cancelDate(sub);
  } else {
    await createTask({
      kind: "manual",
      priority: 1,
      title: `Cancel ${customerLabel(customer)} (${product.name})`,
      body: "They asked to cancel from their account. They aren't billed online, so stop any invoicing by hand and mark them cancelled.",
      product: product.slug,
      customerId: customer.id,
      dedupeKey: `cancel:${customer.id}`,
    });
  }
  await query(
    `UPDATE customers SET data = data || jsonb_build_object('cancel_requested_at', to_jsonb(now()), 'cancel_reason', $2::text, 'cancel_at', $3::text),
     updated_at = now() WHERE id = $1`,
    [customer.id, reason.slice(0, 2000), endsAt?.toISOString() ?? null],
  );
  await logEvent({
    type: "customer.cancel_requested",
    level: "warn",
    message: `${customerLabel(customer)} cancelled${endsAt ? ` (ends ${fmtDate(endsAt)})` : ""}${reason ? `: ${reason}` : ""}`,
    product: product.slug,
    customerId: customer.id,
  });
  await alert(
    customer,
    product,
    `cancellation from ${customerLabel(customer)}`,
    `${customerLabel(customer)} cancelled ${product.name} from their account.` +
      `${endsAt ? ` Service runs until ${fmtDate(endsAt)}, then stops automatically.` : ""}\n\nReason given: ${reason || "(none)"}`,
    "cancellation",
  );
  await queueEmail({
    product: product.slug,
    customerId: customer.id,
    kind: "cancel_confirmed",
    to: customer.email,
    subject: `Your ${product.name} cancellation`,
    body:
      `Hello,\n\nThis confirms you've cancelled ${product.name}.` +
      `${endsAt ? ` Everything carries on until ${fmtDate(endsAt)} and you won't be charged again.` : ""} ` +
      `If you change your mind before then, you can keep your subscription from your account:\n\n${portalUrl(product)}/billing\n\nFelix`,
  });
  return endsAt;
}

export async function resumeSubscription(customer: CustomerRow): Promise<void> {
  const product = requireProduct(customer.product);
  if (customer.stripe_subscription_id) {
    await getStripe().subscriptions.update(customer.stripe_subscription_id, { cancel_at_period_end: false });
  }
  await query(`UPDATE customers SET data = data - 'cancel_requested_at' - 'cancel_reason' - 'cancel_at', updated_at = now() WHERE id = $1`, [customer.id]);
  await query(`UPDATE tasks SET status = 'dismissed', resolution = 'Client kept their subscription', resolved_at = now() WHERE dedupe_key = $1 AND status = 'open'`, [
    `cancel:${customer.id}`,
  ]);
  await logEvent({ type: "customer.resumed", message: `${customerLabel(customer)} kept their subscription`, product: product.slug, customerId: customer.id });
  await alert(customer, product, `${customerLabel(customer)} withdrew their cancellation`, "They're staying on.", "client_activity");
}

// ----------------------------------------------------------------- invoices

export async function recordInvoice(invoice: Stripe.Invoice, subscriptionId: string | null, customerId: string | null): Promise<void> {
  await query(
    `INSERT INTO invoices (id, subscription_id, customer_id, number, status, amount_pence, hosted_url, pdf_url, issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9))
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, number = COALESCE(EXCLUDED.number, invoices.number),
       hosted_url = COALESCE(EXCLUDED.hosted_url, invoices.hosted_url), pdf_url = COALESCE(EXCLUDED.pdf_url, invoices.pdf_url),
       customer_id = COALESCE(EXCLUDED.customer_id, invoices.customer_id), amount_pence = EXCLUDED.amount_pence, updated_at = now()`,
    [
      invoice.id,
      subscriptionId,
      customerId,
      invoice.number ?? null,
      invoice.status ?? "open",
      invoice.total ?? invoice.amount_due ?? 0,
      invoice.hosted_invoice_url ?? null,
      invoice.invoice_pdf ?? null,
      invoice.created ?? Math.floor(Date.now() / 1000),
    ],
  );
}

export async function invoicesFor(customer: CustomerRow) {
  return query(
    `SELECT * FROM invoices WHERE customer_id = $1 OR (subscription_id IS NOT NULL AND subscription_id = $2)
     ORDER BY issued_at DESC LIMIT 36`,
    [customer.id, customer.stripe_subscription_id],
  );
}
