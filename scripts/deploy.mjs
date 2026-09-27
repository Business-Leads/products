#!/usr/bin/env node
// One-command deploy to DigitalOcean App Platform, from a Claude Code session
// or any machine. Reads keys from the environment; never prints them.
//
//   DIGITALOCEAN_ACCESS_TOKEN   required
//   STRIPE_SECRET_KEY           optional: also creates the Stripe webhook
//   HQ_ANTHROPIC_API_KEY        optional: passed to the app as ANTHROPIC_API_KEY
//   MAIL_ADDRESS, MAIL_APP_PASSWORD  optional: Google Workspace mailbox for sending and replies
//   ADMIN_PASSWORD              optional: generated on first deploy if missing
//
// Safe to re-run: it updates the existing app and keeps secrets it isn't given.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const DO = "https://api.digitalocean.com/v2";
const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
if (!token) throw new Error("DIGITALOCEAN_ACCESS_TOKEN is not set");

async function doApi(method, path, body) {
  const res = await fetch(DO + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DigitalOcean ${method} ${path}: ${res.status} ${json.message ?? ""}`);
  return json;
}

async function stripe(method, path, form) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

const spec = parse(await readFile(new URL("../.do/app.yaml", import.meta.url), "utf8"));
const service = spec.services[0];

// Values to set. Anything not given here keeps its current value on the existing app.
const values = {};
let generatedPassword;
if (process.env.ADMIN_PASSWORD) values.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (process.env.STRIPE_SECRET_KEY) values.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (process.env.HQ_ANTHROPIC_API_KEY) values.ANTHROPIC_API_KEY = process.env.HQ_ANTHROPIC_API_KEY;
if (process.env.MAIL_ADDRESS && process.env.MAIL_APP_PASSWORD) {
  const u = encodeURIComponent(process.env.MAIL_ADDRESS);
  const p = encodeURIComponent(process.env.MAIL_APP_PASSWORD.replace(/\s+/g, ""));
  values.SMTP_URL = `smtps://${u}:${p}@smtp.gmail.com:465`;
  values.IMAP_URL = `imaps://${u}:${p}@imap.gmail.com:993`;
  values.REPLY_TO = process.env.MAIL_ADDRESS;
}

const { apps = [] } = await doApi("GET", "/apps?per_page=100");
const existing = apps.find((a) => a.spec?.name === spec.name);
if (!existing && !values.ADMIN_PASSWORD) values.ADMIN_PASSWORD = generatedPassword = randomBytes(12).toString("base64url");

function applyValues(target, current) {
  const currentEnvs = new Map((current?.services?.[0]?.envs ?? []).map((e) => [e.key, e]));
  target.services[0].envs = target.services[0].envs.map((e) => {
    if (values[e.key] !== undefined) return { ...e, value: values[e.key] };
    const kept = currentEnvs.get(e.key);
    if (kept?.value !== undefined && e.value === undefined) return { ...e, value: kept.value };
    return e;
  });
  // Secrets with no value yet are dropped rather than sent empty.
  target.services[0].envs = target.services[0].envs.filter((e) => e.type !== "SECRET" || e.value);
  return target;
}

let app;
if (existing) {
  console.log(`Updating ${spec.name}…`);
  app = (await doApi("PUT", `/apps/${existing.id}`, { spec: applyValues(structuredClone(spec), existing.spec) })).app;
} else {
  console.log(`Creating ${spec.name} (web ${service.instance_size_slug} + dev database)…`);
  app = (await doApi("POST", "/apps", { spec: applyValues(structuredClone(spec)) })).app;
}

// Wait for the deployment to go live.
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  app = (await doApi("GET", `/apps/${app.id}`)).app;
  const phase = app.in_progress_deployment?.phase ?? app.active_deployment?.phase;
  process.stdout.write(`  ${phase ?? "pending"}\r`);
  if (!app.in_progress_deployment && app.active_deployment?.phase === "ACTIVE" && app.live_url) break;
  if (["ERROR", "CANCELED"].includes(app.in_progress_deployment?.phase)) {
    throw new Error(`Deployment ${app.in_progress_deployment.phase}. See the app's build logs in DigitalOcean.`);
  }
}
if (!app.live_url) throw new Error("Timed out waiting for the app to go live");
console.log(`\nLive at ${app.live_url}`);

// Stripe webhook, created once; its signing secret is only shown at creation.
if (process.env.STRIPE_SECRET_KEY) {
  const url = `${app.live_url}/webhooks/stripe`;
  const { data } = await stripe("GET", "/webhook_endpoints?limit=100");
  if (!data.some((w) => w.url === url)) {
    const events = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted",
      "invoice.payment_failed", "invoice.paid", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"];
    const form = { url, description: "Products HQ" };
    events.forEach((e, i) => (form[`enabled_events[${i}]`] = e));
    const hook = await stripe("POST", "/webhook_endpoints", form);
    console.log("Created Stripe webhook; setting its secret on the app…");
    values.STRIPE_WEBHOOK_SECRET = hook.secret;
    const current = (await doApi("GET", `/apps/${app.id}`)).app.spec;
    await doApi("PUT", `/apps/${app.id}`, { spec: applyValues(structuredClone(spec), current) });
  } else {
    console.log("Stripe webhook already exists.");
  }
}

if (generatedPassword) console.log(`Dashboard password (store it somewhere safe): ${generatedPassword}`);
console.log("Done.");
