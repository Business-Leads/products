import { config } from "../config.js";
import { emailFirst } from "./emailfirst.js";
import { firstPageLocal } from "./firstpagelocal.js";
import { goodQuestions } from "./goodquestions.js";
import { linkn } from "./linkn.js";
import { onlineBusinessBuilder } from "./onlinebusinessbuilder.js";
import { speedToLead } from "./speedtolead.js";
import type { Plan, Product } from "./types.js";

export type { Product, Plan } from "./types.js";

export const products: Product[] = [firstPageLocal, linkn, speedToLead, emailFirst, goodQuestions, onlineBusinessBuilder];

export type CallKind = "chat" | "onboarding";

/** The booking page for one kind of call about one product (Cal.com once set up, else the old Calendly link). */
export function bookingUrl(product: Product, kind: CallKind = "chat"): string {
  const user = config.calcom.username;
  return user ? `https://cal.com/${encodeURIComponent(user)}/${product.slug}-${kind}` : product.bookingUrl;
}

/** Booking link with the customer's name and email filled in. */
export function bookingLink(
  product: Product,
  name?: string | null,
  email?: string | null,
  kind: CallKind = "onboarding",
  customerId?: string,
): string {
  const url = new URL(bookingUrl(product, kind));
  if (name) url.searchParams.set("name", name);
  if (email) url.searchParams.set("email", email);
  if (customerId && url.hostname === "cal.com") url.searchParams.set("metadata[customer_id]", customerId);
  return url.toString();
}

const bySlug = new Map(products.map((p) => [p.slug, p]));

export function getProduct(slug: string): Product | undefined {
  return bySlug.get(slug);
}

export function requireProduct(slug: string): Product {
  const p = bySlug.get(slug);
  if (!p) throw new Error(`Unknown product: ${slug}`);
  return p;
}

export function getPlan(product: Product, planId: string): Plan | undefined {
  return product.plans.find((p) => p.id === planId);
}

export function formatPrice(pence: number, interval?: string): string {
  const pounds = pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
  return interval ? `${pounds}/${interval === "week" ? "wk" : "mo"}` : pounds;
}

/** Monthly recurring revenue for a subscription amount. */
export function monthlyValuePence(amountPence: number, interval: string): number {
  return interval === "week" ? Math.round((amountPence * 52) / 12) : amountPence;
}
