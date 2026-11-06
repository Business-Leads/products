// Stripe payment links for each paid plan, so the product sites take sign-ups
// without HQ (HQ was shut down in Nov 2026; see RESTART.md).
//
//   npx tsx scripts/payment-links.ts            lists the links (creates nothing)
//   npx tsx scripts/payment-links.ts --create   creates any that are missing
//
// Each link: the plan's monthly price (plus the one-off setup fee where the plan has
// one), a "Business name" box, promotion codes allowed, and after paying the buyer
// goes straight to the product's Cal.com onboarding call. Objects are tagged
// hq_product / hq_plan like HQ's own checkouts, so a restarted HQ recognises them.
// Payment links can't carry their own name or colours, so the payment page shows the
// Stripe account's name (Business Leads); the owner accepted this in Nov 2026.
// Needs STRIPE_SECRET_KEY. Prints no keys and no customer data.
import { appendFileSync } from "node:fs";
import { products, type Product, type Plan } from "../src/products/index.js";

const CREATE = process.argv.includes("--create");
const SK = process.env.STRIPE_SECRET_KEY?.trim();
if (!SK) throw new Error("STRIPE_SECRET_KEY is not set");
const CAL_USER = process.env.CALCOM_USERNAME?.trim() || "felix-clarke";

// Products whose sites sell straight from a button.
const SELLING = ["linkn", "speedtolead", "onlinebusinessbuilder"];

type Form = Record<string, string | number | boolean>;
async function stripe(method: string, path: string, form?: Form): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${SK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`);
  return json;
}
async function all(path: string): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stripe("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`);
    out.push(...page.data);
    if (!page.has_more) return out;
    after = page.data.at(-1).id;
  }
}

const account = await stripe("GET", "/account");
console.log(`The payment pages show the Stripe account's name: ${account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? "(none)"}`);

// Active and archived, so an earlier product is brought back rather than duplicated.
const allProducts = (await all("/products")).filter((p) => p.metadata?.hq_key);
const allLinks = await all("/payment_links?active=true");

async function stripeProduct(key: string, name: string, meta: Form): Promise<any> {
  const found = allProducts.find((p) => p.metadata?.hq_key === key);
  if (found) {
    if (!found.active) await stripe("POST", `/products/${found.id}`, { active: true });
    return found;
  }
  const created = await stripe("POST", "/products", { name, "metadata[hq_key]": key, ...meta });
  allProducts.push(created);
  return created;
}
async function stripePrice(productId: string, amount: number, interval?: string): Promise<string> {
  const prices = await all(`/prices?product=${productId}`);
  const found = prices.find((p) => p.unit_amount === amount && p.currency === "gbp" && (p.recurring?.interval ?? undefined) === interval);
  if (found) {
    if (!found.active) await stripe("POST", `/prices/${found.id}`, { active: true });
    return found.id;
  }
  const form: Form = { product: productId, unit_amount: amount, currency: "gbp" };
  if (interval) form["recurring[interval]"] = interval;
  return (await stripe("POST", "/prices", form)).id;
}

const made: string[] = [];
for (const slug of SELLING) {
  const product = products.find((p) => p.slug === slug) as Product;
  for (const plan of product.plans as Plan[]) {
    if (!plan.amountPence) continue;
    const label = `${product.name}: ${plan.name}`;
    const existing = allLinks.find((l) => l.metadata?.hq_product === slug && l.metadata?.hq_plan === plan.id);
    if (existing) {
      console.log(`${label}: ${existing.url}`);
      made.push(`${slug} ${plan.id} ${existing.url}`);
      continue;
    }
    if (!CREATE) {
      console.log(`${label}: no payment link yet`);
      continue;
    }
    const meta = { "metadata[hq_product]": slug, "metadata[hq_plan]": plan.id };
    const main = await stripeProduct(`${slug}:${plan.id}`, label, meta);
    const form: Form = {
      "line_items[0][price]": await stripePrice(main.id, plan.amountPence, plan.interval),
      "line_items[0][quantity]": 1,
      allow_promotion_codes: true,
      ...meta,
      "subscription_data[metadata][hq_product]": slug,
      "subscription_data[metadata][hq_plan]": plan.id,
      "custom_fields[0][key]": "business",
      "custom_fields[0][label][type]": "custom",
      "custom_fields[0][label][custom]": "Business name",
      "custom_fields[0][type]": "text",
      "after_completion[type]": "redirect",
      "after_completion[redirect][url]": `https://cal.com/${CAL_USER}/${slug}-onboarding`,
    };
    if (plan.trialDays) form["subscription_data[trial_period_days]"] = plan.trialDays;
    if (plan.setupFeePence) {
      const setup = await stripeProduct(`${slug}:setup`, `${product.name}: setup`, { "metadata[hq_product]": slug });
      form["line_items[1][price]"] = await stripePrice(setup.id, plan.setupFeePence);
      form["line_items[1][quantity]"] = 1;
    }
    const link = await stripe("POST", "/payment_links", form);
    console.log(`${label}: ${link.url} (new)`);
    made.push(`${slug} ${plan.id} ${link.url}`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY && made.length) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Payment links\n\n${made.map((m) => `- ${m}`).join("\n")}\n`);
}
