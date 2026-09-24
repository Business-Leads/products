import { emailFirst } from "./emailfirst.js";
import { firstPageLocal } from "./firstpagelocal.js";
import { goodQuestions } from "./goodquestions.js";
import { linkn } from "./linkn.js";
import { speedToLead } from "./speedtolead.js";
import type { Plan, Product } from "./types.js";

export type { Product, Plan } from "./types.js";

export const products: Product[] = [firstPageLocal, linkn, speedToLead, emailFirst, goodQuestions];

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
