// Stripe payment links for each paid plan, so the product sites can take sign-ups
// without HQ (HQ was shut down in Nov 2026; see RESTART.md).
//
//   npx tsx scripts/payment-links.ts            lists the links (creates nothing)
//   npx tsx scripts/payment-links.ts --create   creates any that are missing
//
// Each link: the plan's monthly price (plus a one-off setup fee where the plan has
// one), the product's own name and colours on the payment page (the Stripe account
// is shared, so it must never show Business Leads), a "Business name" box, promotion
// codes allowed, and after paying the buyer goes straight to the product's Cal.com
// onboarding call. Objects are tagged hq_product / hq_plan like HQ's own checkouts.
// Needs STRIPE_SECRET_KEY. Prints no keys and no customer data.
import { readFileSync } from "node:fs";
import { products, type Product, type Plan } from "../src/products/index.js";

const CREATE = process.argv.includes("--create");
const SK = process.env.STRIPE_SECRET_KEY?.trim();
if (!SK) throw new Error("STRIPE_SECRET_KEY is not set");
const CAL_USER = process.env.CALCOM_USERNAME?.trim() || "felix-clarke";

// Products whose sites sell straight from a button.
const SELLING = ["linkn", "speedtolead", "onlinebusinessbuilder"];

// Light page colour and button colour, as HQ's checkout used (src/lib/stripe.ts).
const COLOURS: Record<string, [string, string]> = {
  linkn: ["#EEF5FF", "#2A6FD9"],
  speedtolead: ["#FFF4E8", "#E2661A"],
  onlinebusinessbuilder: ["#FFF3EE", "#E5484D"],
  emailfirst: ["#FDF0F8", "#B9459A"],
};

type Form = Record<string, string | number | boolean>;
async function stripe(method: string, path: string, form?: Form): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${SK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`) as Error & { param?: string };
    err.param = json.error?.param;
    throw err;
  }
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

async function uploadIcon(slug: string): Promise<string | undefined> {
  const file = slug === "onlinebusinessbuilder" ? "src/web/static/logo.png" : `src/web/static/products/${slug}.png`;
  const body = new FormData();
  body.append("purpose", "business_icon");
  body.append("file", new Blob([readFileSync(file)], { type: "image/png" }), `${slug}.png`);
  const res = await fetch("https://files.stripe.com/v1/files", { method: "POST", headers: { Authorization: `Bearer ${SK}` }, body });
  const json: any = await res.json();
  if (!res.ok) {
    console.log(`  (icon upload for ${slug} failed: ${json.error?.message ?? res.status}; the page shows no icon)`);
    return undefined;
  }
  return json.id;
}

const account = await stripe("GET", "/account");
const shownName = [account.business_profile?.name, account.settings?.dashboard?.display_name].filter(Boolean).join(" / ");
console.log(`Stripe account name: ${shownName || "(none)"}`);

const allProducts = await all("/products?active=true");
const allLinks = await all("/payment_links?active=true");

async function stripeProduct(key: string, name: string, meta: Form): Promise<any> {
  const found = allProducts.find((p) => p.metadata?.hq_key === key);
  if (found) return found;
  const created = await stripe("POST", "/products", { name, "metadata[hq_key]": key, ...meta });
  allProducts.push(created);
  return created;
}
async function stripePrice(productId: string, amount: number, interval?: string): Promise<string> {
  const prices = await all(`/prices?active=true&product=${productId}`);
  const found = prices.find((p) => p.unit_amount === amount && p.currency === "gbp" && (p.recurring?.interval ?? undefined) === interval);
  if (found) return found.id;
  const form: Form = { product: productId, unit_amount: amount, currency: "gbp" };
  if (interval) form["recurring[interval]"] = interval;
  return (await stripe("POST", "/prices", form)).id;
}

let brandingWorks = true;
const made: string[] = [];

for (const slug of SELLING) {
  const product = products.find((p) => p.slug === slug) as Product;
  let icon: string | undefined;
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
    if (brandingWorks) {
      icon ??= await uploadIcon(slug);
      const [background, button] = COLOURS[slug] ?? ["#FFFDF9", product.portal.accent];
      Object.assign(form, {
        "branding_settings[display_name]": product.name,
        "branding_settings[background_color]": background,
        "branding_settings[button_color]": button,
        "branding_settings[border_style]": "rounded",
        ...(icon ? { "branding_settings[icon][type]": "file", "branding_settings[icon][file]": icon } : {}),
      });
    }
    let link: any;
    try {
      link = await stripe("POST", "/payment_links", form);
    } catch (e) {
      const param = (e as { param?: string }).param ?? "";
      if (!brandingWorks || !param.startsWith("branding_settings")) throw e;
      // Stripe won't take a per-link name and colours, so the page would show the account's own name.
      brandingWorks = false;
      console.log(`Payment links can't carry their own name and colours (${(e as Error).message}).`);
      if (/business leads/i.test(shownName)) {
        console.log("The payment page would say Business Leads, so no links were made. Nothing else was changed.");
        process.exit(1);
      }
      for (const k of Object.keys(form)) if (k.startsWith("branding_settings")) delete form[k];
      link = await stripe("POST", "/payment_links", form);
    }
    console.log(`${label}: ${link.url} (new)`);
    made.push(`${slug} ${plan.id} ${link.url}`);
  }
}

if (!brandingWorks) console.log(`Note: the payment pages show the account name (${shownName}), not the product name.`);
if (process.env.GITHUB_STEP_SUMMARY && made.length) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Payment links\n\n${made.map((m) => `- ${m}`).join("\n")}\n`);
}
