#!/usr/bin/env node
// One-off tidy (6 Nov 2026): archives the Stripe product and price left behind by a
// payment-link attempt that Stripe refused. Touches only products this repo made
// that day (metadata hq_key, created on 2026-11-06) and that no payment link uses.
// Run with --archive to change anything; without it, only lists.
const ARCHIVE = process.argv.includes("--archive");
const SK = process.env.STRIPE_SECRET_KEY?.trim();
if (!SK) throw new Error("STRIPE_SECRET_KEY is not set");
async function stripe(method, path, form) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${SK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`);
  return json;
}
const from = Date.UTC(2026, 10, 6) / 1000;
const to = Date.UTC(2026, 10, 7) / 1000;
const products = (await stripe("GET", `/products?limit=100&created[gte]=${from}&created[lt]=${to}`)).data.filter((p) => p.metadata?.hq_key);
const links = (await stripe("GET", "/payment_links?limit=100")).data;
const usedPrices = new Set();
for (const l of links) for (const i of (await stripe("GET", `/payment_links/${l.id}/line_items`)).data) usedPrices.add(i.price?.id);
for (const p of products) {
  const prices = (await stripe("GET", `/prices?limit=100&product=${p.id}`)).data;
  if (prices.some((x) => usedPrices.has(x.id))) {
    console.log(`${p.name}: used by a payment link, left alone`);
    continue;
  }
  console.log(`${p.name} (${p.id}, ${p.active ? "active" : "archived"}): ${prices.length} price(s)`);
  if (!ARCHIVE) continue;
  for (const x of prices.filter((x) => x.active)) await stripe("POST", `/prices/${x.id}`, { active: "false" });
  if (p.active) await stripe("POST", `/products/${p.id}`, { active: "false" });
  console.log("  archived");
}
if (!products.length) console.log("Nothing to tidy.");
