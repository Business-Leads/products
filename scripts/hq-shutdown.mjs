#!/usr/bin/env node
// Shuts HQ down on purpose, so it stops costing money. See RESTART.md to bring it back.
//
//   node scripts/hq-shutdown.mjs           lists what would be removed (changes nothing)
//   node scripts/hq-shutdown.mjs --delete  removes it
//
// Removes only HQ's own things:
//   - the Stripe webhook endpoint pointing at HQ (the Stripe account is shared,
//     so other endpoints are left alone)
//   - the Cal.com webhook pointing at HQ (the call types and booking pages stay)
//   - the DigitalOcean app products-hq and its database cluster products-hq-db
// Also reports, without changing anything: Stripe payment links (the sites'
// sign-up buttons), subscriptions started through HQ, and the Cal.com call types.
// Keys come from the environment and are never printed; no contact data is printed.
const DELETE = process.argv.includes("--delete");
const APP = "products-hq";
const CLUSTER = "products-hq-db";
const HQ_HOSTS = ["hq.onlinebusinessbuilder.co.uk", "ondigitalocean.app"];
const isHq = (url) => HQ_HOSTS.some((h) => (url ?? "").includes(h));

let problems = 0;
const say = (s) => console.log(s);

// ---------------------------------------------------------------- Stripe
const SK = process.env.STRIPE_SECRET_KEY?.trim();
async function stripe(method, path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${SK}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`);
  return json;
}
async function* stripeAll(path) {
  let after;
  for (;;) {
    const page = await stripe("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`);
    yield* page.data;
    if (!page.has_more) return;
    after = page.data.at(-1).id;
  }
}
const money = (p) => (p ? `£${(p.unit_amount / 100).toFixed(2)}${p.recurring ? ` a ${p.recurring.interval}` : ""}` : "?");

if (!SK) {
  say("Stripe: no key, skipped.");
} else {
  say("\n== Stripe");
  const hooks = [];
  for await (const h of stripeAll("/webhook_endpoints")) if (isHq(h.url)) hooks.push(h);
  say(`HQ webhook endpoints: ${hooks.length}${hooks.map((h) => `\n  ${h.id} ${h.url} (${h.status})`).join("")}`);

  const subs = new Map();
  for await (const s of stripeAll("/subscriptions?status=all")) {
    const product = s.metadata?.hq_product;
    if (!product || s.status === "canceled" || s.status === "incomplete_expired") continue;
    const k = `${product} ${s.status}`;
    subs.set(k, (subs.get(k) ?? 0) + 1);
  }
  say(`Open subscriptions for our products (HQ checkouts and payment links): ${subs.size ? [...subs].map(([k, n]) => `\n  ${k}: ${n}`).join("") : "none"}`);
  if (subs.size) say("  (These keep billing in Stripe without HQ; Stripe emails receipts, and Felix sees them in Stripe.)");

  const links = [];
  for await (const l of stripeAll("/payment_links?active=true")) links.push(l);
  say(`Active payment links: ${links.length}`);
  for (const l of links) {
    const items = (await stripe("GET", `/payment_links/${l.id}/line_items?expand[]=data.price.product`)).data;
    const what = items.map((i) => `${i.price?.product?.name ?? i.description} ${money(i.price)}`).join(" + ");
    const after = l.after_completion?.type === "redirect" ? ` -> after paying goes to ${l.after_completion.redirect.url}` : "";
    say(`  ${l.url}  ${what}${after}`);
    if (isHq(l.after_completion?.redirect?.url)) {
      say("    ! this link sends buyers back to HQ after paying, which won't exist any more");
      problems++;
    }
  }

  if (DELETE) {
    for (const h of hooks) {
      await stripe("DELETE", `/webhook_endpoints/${h.id}`);
      say(`Deleted Stripe webhook ${h.id}.`);
    }
  }
}

// ---------------------------------------------------------------- Cal.com
const CAL = process.env.CALCOM_API_KEY?.trim();
async function cal(method, path) {
  const res = await fetch(`https://api.cal.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${CAL}`, "cal-api-version": "2026-06-12" },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cal.com ${method} ${path}: ${res.status}`);
  return json;
}
const asList = (j) => (Array.isArray(j?.data) ? j.data : Array.isArray(j?.data?.eventTypes) ? j.data.eventTypes : []);

if (!CAL) {
  say("\nCal.com: no key, skipped.");
} else {
  say("\n== Cal.com");
  const me = (await cal("GET", "/v2/me")).data;
  const types = asList(await cal("GET", `/v2/event-types?username=${encodeURIComponent(me.username)}`));
  say(`Call types (these stay):${types.map((t) => `\n  cal.com/${me.username}/${t.slug}${t.hidden ? " (hidden)" : ""}`).join("")}`);
  const hooks = asList(await cal("GET", "/v2/webhooks")).filter((h) => /\/webhooks\/calcom\//.test(h.subscriberUrl ?? ""));
  say(`Webhooks to HQ: ${hooks.length}${hooks.map((h) => `\n  ${h.id} ${h.subscriberUrl.replace(/calcom\/.*/, "calcom/…")}`).join("")}`);
  if (DELETE) {
    for (const h of hooks) {
      await cal("DELETE", `/v2/webhooks/${h.id}`);
      say(`Deleted Cal.com webhook ${h.id}.`);
    }
  }
}

// ---------------------------------------------------------------- DigitalOcean
const DO = process.env.DIGITALOCEAN_ACCESS_TOKEN?.trim();
async function doApi(method, path) {
  const res = await fetch(`https://api.digitalocean.com/v2${path}`, { method, headers: { Authorization: `Bearer ${DO}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DigitalOcean ${method} ${path}: ${res.status} ${json.message ?? ""}`);
  return json;
}

if (!DO) {
  say("\nDigitalOcean: no token, skipped.");
  problems++;
} else {
  say("\n== DigitalOcean");
  const app = ((await doApi("GET", "/apps?per_page=200")).apps ?? []).find((a) => a.spec?.name === APP);
  const cluster = ((await doApi("GET", "/databases")).databases ?? []).find((d) => d.name === CLUSTER);
  say(app ? `App ${APP}: ${app.live_url ?? "(no live URL)"}, domains ${(app.spec.domains ?? []).map((d) => d.domain).join(", ")}` : `App ${APP}: not found`);
  say(cluster ? `Database cluster ${CLUSTER}: Postgres ${cluster.version}, ${cluster.size}, ${cluster.status}` : `Database cluster ${CLUSTER}: not found`);
  const others = ((await doApi("GET", "/apps?per_page=200")).apps ?? []).filter((a) => a.spec?.name !== APP).map((a) => a.spec?.name);
  if (others.length) say(`Other apps on the account (left alone): ${others.join(", ")}`);
  // Where HQ's data actually lives (names and dates only).
  for (const c of (await doApi("GET", "/databases")).databases ?? []) {
    say(`  cluster ${c.name}: created ${c.created_at}, ${c.engine} ${c.version}, ${c.status}, dbs [${(c.db_names ?? []).join(", ")}], users [${(c.users ?? []).map((u) => u.name).join(", ")}]`);
  }
  if (cluster) {
    const pools = (await doApi("GET", `/databases/${cluster.id}/pools`).catch(() => ({}))).pools ?? [];
    const fw = (await doApi("GET", `/databases/${cluster.id}/firewall`).catch(() => ({}))).rules ?? [];
    say(`  ${CLUSTER} pools [${pools.map((p) => `${p.name}->${p.db}`).join(", ")}], trusted sources [${fw.map((r) => `${r.type}:${r.value}`).join(", ")}]`);
  }
  if (app) {
    const full = (await doApi("GET", `/apps/${app.id}`)).app;
    say(`  app created ${full.created_at}; active deployment ${full.active_deployment?.id ?? "none"} from ${full.active_deployment?.created_at ?? "?"} (${full.active_deployment?.phase ?? "?"})`);
    say(`  active deployment's databases: ${JSON.stringify(full.active_deployment?.spec?.databases ?? [])}`);
    say(`  active deployment's database env: ${(full.active_deployment?.spec?.services?.[0]?.envs ?? []).filter((e) => /DATABASE/.test(e.key)).map((e) => `${e.key}=${e.type === "SECRET" ? "(secret)" : String(e.value ?? "").replace(/:\/\/[^@\s]*@/g, "://(hidden)@")}`).join(", ")}`);
    const deps = (await doApi("GET", `/apps/${app.id}/deployments?per_page=5`)).deployments ?? [];
    for (const d of deps) say(`  deployment ${d.created_at} ${d.phase} (${d.cause ?? ""})`);
  }
  for (const u of ["https://hq.onlinebusinessbuilder.co.uk/healthz"]) {
    const r = await fetch(u).catch((e) => ({ status: e.message, text: async () => "" }));
    say(`  ${u}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  if (DELETE) {
    if (app) {
      await doApi("DELETE", `/apps/${app.id}`);
      say(`Deleted app ${APP}.`);
    }
    if (cluster) {
      await doApi("DELETE", `/databases/${cluster.id}`);
      say(`Deleted database cluster ${CLUSTER}.`);
    }
  }
}

say(DELETE ? "\nHQ is shut down." : "\nNothing was changed. Run with --delete to remove the above.");
if (problems) say(`${problems} thing(s) above need attention.`);
