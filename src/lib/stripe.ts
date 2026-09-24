import Stripe from "stripe";
import { config } from "../config.js";
import type { Plan, Product } from "../products/index.js";
import { NotConfiguredError } from "./util.js";

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(config.stripe.secretKey);
}

export function getStripe(): Stripe {
  if (!config.stripe.secretKey) throw new NotConfiguredError("stripe", "STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(config.stripe.secretKey);
  return client;
}

/**
 * The Email First Ltd Stripe account also bills Mailpulse and Business Leads,
 * so every object this app creates is tagged and every webhook is filtered by
 * this metadata key. Anything without it is left alone.
 */
export const META_PRODUCT = "hq_product";
export const META_PLAN = "hq_plan";
export const META_LEAD = "hq_lead_id";

export interface CheckoutOptions {
  email?: string;
  leadId?: string | number;
  addOns?: string[];
}

export function buildCheckoutParams(
  product: Product,
  plan: Plan,
  opts: CheckoutOptions = {},
): Stripe.Checkout.SessionCreateParams {
  const recurring = { interval: plan.interval } as const;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: "gbp",
        unit_amount: plan.amountPence,
        recurring,
        product_data: { name: `${product.name}: ${plan.name}` },
      },
    },
  ];
  if (plan.setupFeePence) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "gbp",
        unit_amount: plan.setupFeePence,
        product_data: { name: `${product.name}: setup` },
      },
    });
  }
  for (const id of opts.addOns ?? []) {
    const addOn = product.addOns?.find((a) => a.id === id);
    if (!addOn) continue;
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "gbp",
        unit_amount: addOn.amountPence,
        ...(addOn.recurring ? { recurring } : {}),
        product_data: { name: `${product.name}: ${addOn.name}` },
      },
    });
  }

  const metadata: Record<string, string> = { [META_PRODUCT]: product.slug, [META_PLAN]: plan.id };
  if (opts.leadId) metadata[META_LEAD] = String(opts.leadId);
  if (opts.addOns?.length) metadata.hq_addons = opts.addOns.join(",");

  return {
    mode: "subscription",
    line_items: lineItems,
    customer_email: opts.email || undefined,
    allow_promotion_codes: true,
    metadata,
    subscription_data: {
      metadata,
      ...(plan.trialDays ? { trial_period_days: plan.trialDays } : {}),
    },
    success_url: `${config.baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: product.siteUrls[0] ?? config.baseUrl,
  };
}

export async function createCheckout(product: Product, plan: Plan, opts: CheckoutOptions = {}): Promise<string> {
  const session = await getStripe().checkout.sessions.create(buildCheckoutParams(product, plan, opts));
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret) throw new NotConfiguredError("stripe", "STRIPE_WEBHOOK_SECRET is not set");
  return getStripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
