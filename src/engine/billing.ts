import type Stripe from "stripe";
import { one, query } from "../db/index.js";
import { emailOperator, queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { config } from "../config.js";
import { getStripe, META_LEAD, META_PLAN, META_PRODUCT } from "../lib/stripe.js";
import { createTask } from "../lib/tasks.js";
import { fmtDate, token } from "../lib/util.js";
import { formatPrice, getPlan, getProduct, requireProduct } from "../products/index.js";
import { ensureClientUser } from "../portal/accounts.js";
import { customerLabel, recordInvoice } from "./clients.js";
import { markLeadWon } from "./leads.js";
import type { CustomerRow } from "./types.js";
import { advanceOnboarding, instantiateSteps } from "./workflow.js";

/**
 * Handle a verified Stripe webhook event. The Email First Ltd account is
 * shared with other businesses, so anything that can't be traced to a
 * customer created by this app is recorded as irrelevant and ignored.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const seen = await one(`SELECT id FROM stripe_events WHERE id = $1`, [event.id]);
  if (seen) return;

  let relevant = false;
  switch (event.type) {
    case "checkout.session.completed":
      relevant = await onCheckoutCompleted(event.data.object);
      break;
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      relevant = await onSubscriptionChanged(event.data.object, event.type === "customer.subscription.deleted");
      break;
    case "invoice.payment_failed":
      relevant = await onPaymentFailed(event.data.object);
      break;
    case "invoice.paid":
      relevant = await onInvoicePaid(event.data.object);
      break;
    case "invoice.finalized":
      relevant = await onInvoiceFinalized(event.data.object);
      break;
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      relevant = await onDispute(event.data.object);
      break;
  }
  await query(`INSERT INTO stripe_events (id, type, relevant) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
    event.id,
    event.type,
    relevant,
  ]);
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

async function customerBySubscription(subscriptionId: string | null): Promise<CustomerRow | undefined> {
  if (!subscriptionId) return undefined;
  return one<CustomerRow>(`SELECT * FROM customers WHERE stripe_subscription_id = $1`, [subscriptionId]);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // The field moved under `parent` in newer Stripe API versions.
  const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
  return idOf(legacy) ?? idOf(invoice.parent?.subscription_details?.subscription);
}

async function onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<boolean> {
  const slug = session.metadata?.[META_PRODUCT];
  const product = slug ? getProduct(slug) : undefined;
  if (!product) return false;
  const plan = getPlan(product, session.metadata?.[META_PLAN] ?? "");
  if (!plan) return false;

  const existing = await one(`SELECT id FROM customers WHERE stripe_checkout_id = $1`, [session.id]);
  if (existing) return true;
  // Paid sessions only (a delayed payment method completes later).
  if (session.payment_status && session.payment_status === "unpaid") return true;

  const addOnIds = (session.metadata?.hq_addons ?? "").split(",").filter(Boolean);
  const recurringAddOns = (product.addOns ?? [])
    .filter((a) => a.recurring && addOnIds.includes(a.id))
    .reduce((sum, a) => sum + a.amountPence, 0);
  const email = session.customer_details?.email ?? session.customer_email ?? "";
  const leadId = session.metadata?.[META_LEAD] || null;

  const customer = await one<CustomerRow>(
    `INSERT INTO customers (product, plan, name, email, phone, intake_token, stripe_customer_id,
       stripe_subscription_id, stripe_checkout_id, amount_pence, interval, lead_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (stripe_checkout_id) DO NOTHING RETURNING *`,
    [
      product.slug,
      plan.id,
      session.customer_details?.name ?? null,
      email,
      session.customer_details?.phone ?? null,
      token(),
      idOf(session.customer),
      idOf(session.subscription),
      session.id,
      plan.amountPence + recurringAddOns,
      plan.interval,
      leadId && /^\d+$/.test(leadId) ? leadId : null,
      { addOns: addOnIds },
    ],
  );
  // The webhook and the client's return from checkout can race; only one creates the customer.
  if (!customer) return true;
  await ensureClientUser(customer);
  await query(`UPDATE invoices SET customer_id = $1 WHERE subscription_id = $2 AND customer_id IS NULL`, [customer.id, customer.stripe_subscription_id]);
  await logEvent({
    type: "customer.created",
    message: `New ${product.name} customer: ${email} on ${plan.name}`,
    product: product.slug,
    customerId: customer!.id,
  });
  await emailOperator(
    `New ${product.name} customer: ${customer!.name ?? email}`,
    `${customer!.name ?? ""} <${email}> signed up to ${product.name} ${plan.name} ` +
      `(${formatPrice(customer!.amount_pence, plan.interval)}). Onboarding has started automatically` +
      (product.bookingAfterPurchase ? "; they've been asked to book their onboarding call with you." : ".") +
      `\n\nIn HQ: ${config.baseUrl}/customers/${customer!.id}`,
    "new_customer",
  );
  await markLeadWon(customer!.lead_id, customer!.id, email, product.slug);
  await instantiateSteps(customer!);
  await advanceOnboarding(customer!.id);
  return true;
}

async function onSubscriptionChanged(sub: Stripe.Subscription, deleted: boolean): Promise<boolean> {
  const customer = await customerBySubscription(sub.id);
  if (!customer) return false;
  const product = requireProduct(customer.product);

  if (deleted || sub.status === "canceled") {
    if (customer.status === "cancelled") return true;
    await query(`UPDATE customers SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [
      customer.id,
    ]);
    await query(`UPDATE deliveries SET status = 'failed', last_error = 'Customer cancelled', attempts = 99
                 WHERE customer_id = $1 AND status NOT IN ('delivered')`, [customer.id]);
    await logEvent({
      type: "customer.cancelled",
      level: "warn",
      message: `${customer.business ?? customer.email} cancelled ${product.name}`,
      product: product.slug,
      customerId: customer.id,
    });
    await emailOperator(
      `${product.name}: ${customerLabel(customer)} has now left`,
      `${customerLabel(customer)} <${customer.email}>'s ${product.name} subscription has ended and all work for them has stopped.` +
        `${customer.data.cancel_reason ? `\n\nReason they gave: ${customer.data.cancel_reason}` : ""}\n\nIn HQ: ${config.baseUrl}/customers/${customer.id}`,
      "cancellation",
    );
    await queueEmail({
      product: product.slug,
      customerId: customer.id,
      kind: "cancelled",
      to: customer.email,
      subject: `Your ${product.name} subscription has ended`,
      body:
        `Hello,\n\nThis confirms your ${product.name} subscription has ended and you won't be charged again. ` +
        `Thank you for giving it a try. If there's anything we could have done better, a one-line reply would ` +
        `genuinely help.\n\nFelix`,
    });
    return true;
  }

  if (sub.status === "past_due" || sub.status === "unpaid") {
    await query(
      `UPDATE customers SET status = CASE WHEN status IN ('active','onboarding') THEN 'past_due' ELSE status END,
       past_due_since = COALESCE(past_due_since, now()), updated_at = now() WHERE id = $1`,
      [customer.id],
    );
    return true;
  }

  // Cancelled (or un-cancelled) in the Stripe dashboard rather than from the client's account.
  if (sub.cancel_at_period_end && !customer.data.cancel_requested_at) {
    const endsAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;
    await query(
      `UPDATE customers SET data = data || jsonb_build_object('cancel_requested_at', to_jsonb(now()), 'cancel_at', $2::text), updated_at = now() WHERE id = $1`,
      [customer.id, endsAt?.toISOString() ?? null],
    );
    await logEvent({ type: "customer.cancel_requested", level: "warn", message: `${customerLabel(customer)} is set to cancel${endsAt ? ` on ${fmtDate(endsAt)}` : ""}`, product: product.slug, customerId: customer.id });
    await emailOperator(
      `${product.name}: cancellation from ${customerLabel(customer)}`,
      `${customerLabel(customer)} <${customer.email}> is set to cancel${endsAt ? ` on ${fmtDate(endsAt)}` : ""} (changed in Stripe).`,
      "cancellation",
    );
  } else if (!sub.cancel_at_period_end && customer.data.cancel_requested_at && !deleted) {
    await query(`UPDATE customers SET data = data - 'cancel_requested_at' - 'cancel_reason' - 'cancel_at', updated_at = now() WHERE id = $1`, [customer.id]);
  }

  if (sub.status === "active" || sub.status === "trialing") await restoreCustomer(customer);
  return true;
}

async function restoreCustomer(customer: CustomerRow): Promise<void> {
  if (customer.status !== "past_due" && customer.status !== "paused") return;
  await query(
    `UPDATE customers SET status = CASE WHEN activated_at IS NULL THEN 'onboarding' ELSE 'active' END,
     past_due_since = NULL, updated_at = now() WHERE id = $1`,
    [customer.id],
  );
  await logEvent({
    type: "customer.restored",
    message: `${customer.business ?? customer.email} is paid up again`,
    product: customer.product,
    customerId: customer.id,
  });
  await advanceOnboarding(customer.id);
}

/** Our invoices carry the subscription's metadata; anything else on the shared account is ignored. */
async function storeInvoice(invoice: Stripe.Invoice): Promise<CustomerRow | undefined | false> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  const customer = await customerBySubscription(subscriptionId);
  const ours = Boolean(customer) || Boolean(invoice.parent?.subscription_details?.metadata?.[META_PRODUCT]);
  if (!ours) return false;
  await recordInvoice(invoice, subscriptionId, customer?.id ?? null);
  return customer;
}

async function onInvoiceFinalized(invoice: Stripe.Invoice): Promise<boolean> {
  return (await storeInvoice(invoice)) !== false;
}

async function onPaymentFailed(invoice: Stripe.Invoice): Promise<boolean> {
  const stored = await storeInvoice(invoice);
  if (stored === false) return false;
  const customer = stored;
  if (!customer) return true;
  const product = requireProduct(customer.product);
  await query(
    `UPDATE customers SET status = CASE WHEN status IN ('active','onboarding') THEN 'past_due' ELSE status END,
     past_due_since = COALESCE(past_due_since, now()), updated_at = now() WHERE id = $1`,
    [customer.id],
  );
  await logEvent({
    type: "payment.failed",
    level: "warn",
    message: `Payment failed for ${customer.business ?? customer.email} (${product.name})`,
    product: product.slug,
    customerId: customer.id,
  });
  // Stripe retries the card itself; we send one plain note with the payment link per invoice.
  const already = await one(`SELECT id FROM emails WHERE kind = 'dunning' AND body_text LIKE $1`, [`%${invoice.id}%`]);
  if (!already && invoice.hosted_invoice_url) {
    await queueEmail({
      product: product.slug,
      customerId: customer.id,
      kind: "dunning",
      to: customer.email,
      subject: `${product.name}: your payment didn't go through`,
      body:
        `Hello,\n\nYour latest ${product.name} payment didn't go through. You can update your card and pay ` +
        `here:\n\n${invoice.hosted_invoice_url}\n\nThe service carries on for now, but will pause after ` +
        `${product.pauseAfterPastDueDays} days if the payment isn't made.\n\n(Invoice ref ${invoice.id})\n\nFelix`,
    });
  }
  return true;
}

async function onInvoicePaid(invoice: Stripe.Invoice): Promise<boolean> {
  const customer = await storeInvoice(invoice);
  if (customer === false) return false;
  if (!customer) return true;
  await restoreCustomer(customer);
  return true;
}

async function onDispute(dispute: Stripe.Dispute): Promise<boolean> {
  const chargeId = idOf(dispute.charge);
  let customer: CustomerRow | undefined;
  if (chargeId) {
    const charge = await getStripe().charges.retrieve(chargeId);
    const stripeCustomer = idOf(charge.customer);
    if (stripeCustomer) {
      customer = await one<CustomerRow>(`SELECT * FROM customers WHERE stripe_customer_id = $1`, [stripeCustomer]);
    }
  }
  if (!customer) return false;

  const due = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null;
  await query(
    `INSERT INTO disputes (id, customer_id, product, amount_pence, reason, status, evidence_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, evidence_due = EXCLUDED.evidence_due, updated_at = now()`,
    [dispute.id, customer.id, customer.product, dispute.amount, dispute.reason, dispute.status, due],
  );
  const open = !["won", "lost", "warning_closed"].includes(dispute.status);
  if (open) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: `Payment dispute: ${formatPrice(dispute.amount)} from ${customer.business ?? customer.email}`,
      body:
        `Reason: ${dispute.reason}. Evidence due ${due ? fmtDate(due) : "(unknown)"}.\n\n` +
        `Respond in the Stripe dashboard: https://dashboard.stripe.com/disputes/${dispute.id}`,
      product: customer.product,
      customerId: customer.id,
      dedupeKey: `dispute:${dispute.id}`,
      dueAt: due ?? undefined,
    });
  } else {
    await query(`UPDATE tasks SET status = 'done', resolution = $2, resolved_at = now() WHERE dedupe_key = $1 AND status = 'open'`, [
      `dispute:${dispute.id}`,
      `Dispute ${dispute.status}`,
    ]);
  }
  await logEvent({
    type: "dispute." + dispute.status,
    level: "warn",
    message: `Dispute ${dispute.id} (${formatPrice(dispute.amount)}) is ${dispute.status}`,
    product: customer.product,
    customerId: customer.id,
  });
  return true;
}

/** Pause service for customers whose payment has been overdue too long. Run hourly. */
export async function pauseOverdueCustomers(): Promise<number> {
  const overdue = await query<CustomerRow>(`SELECT * FROM customers WHERE status = 'past_due' AND past_due_since IS NOT NULL`);
  let paused = 0;
  for (const customer of overdue) {
    const product = requireProduct(customer.product);
    const days = (Date.now() - new Date(customer.past_due_since!).getTime()) / 86_400_000;
    if (days < product.pauseAfterPastDueDays) continue;
    await query(`UPDATE customers SET status = 'paused', updated_at = now() WHERE id = $1`, [customer.id]);
    await logEvent({
      type: "customer.paused",
      level: "warn",
      message: `Paused ${customer.business ?? customer.email} (${product.name}) after ${Math.floor(days)} days unpaid`,
      product: product.slug,
      customerId: customer.id,
    });
    await queueEmail({
      product: product.slug,
      customerId: customer.id,
      kind: "paused",
      to: customer.email,
      subject: `${product.name} is paused`,
      body:
        `Hello,\n\nWe've paused ${product.name} because the latest payment is still outstanding. Everything is ` +
        `kept as it was, and the service restarts automatically as soon as the payment goes through.\n\nFelix`,
    });
    paused++;
  }
  return paused;
}

/**
 * Called when a client lands back from checkout: confirms the payment with
 * Stripe directly, so their account is ready even if the webhook is late.
 */
export async function syncCheckoutSession(sessionId: string): Promise<CustomerRow | undefined> {
  const known = await one<CustomerRow>(`SELECT * FROM customers WHERE stripe_checkout_id = $1`, [sessionId]);
  if (known) return known;
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return undefined;
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  if (session.status !== "complete") return undefined;
  await onCheckoutCompleted(session);
  return one<CustomerRow>(`SELECT * FROM customers WHERE stripe_checkout_id = $1`, [sessionId]);
}
