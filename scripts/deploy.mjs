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
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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

// Make sure the managed database cluster exists and is online before the app needs it.
for (const db of spec.databases ?? []) {
  if (!db.production || !db.cluster_name) continue;
  const databases = (await doApi("GET", "/databases")).databases ?? [];
  let cluster = databases.find((d) => d.name === db.cluster_name);
  if (!cluster) {
    console.log(`Creating database cluster ${db.cluster_name} (smallest size)…`);
    cluster = (await doApi("POST", "/databases", {
      name: db.cluster_name,
      engine: "pg",
      version: db.version ?? "16",
      region: "lon1",
      size: "db-s-1vcpu-1gb",
      num_nodes: 1,
    })).database;
  }
  for (let i = 0; i < 90 && cluster.status !== "online"; i++) {
    process.stdout.write(`  database ${cluster.status}\r`);
    await new Promise((r) => setTimeout(r, 10_000));
    cluster = (await doApi("GET", `/databases/${cluster.id}`)).database;
  }
  if (cluster.status !== "online") throw new Error(`Database ${db.cluster_name} did not come online`);
  console.log(`Database ${db.cluster_name} is online.`);
}
const service = spec.services[0];

// Values to set. Anything not given here keeps its current value on the existing app.
const values = {};
let generatedPassword;
if (process.env.ADMIN_PASSWORD) values.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (process.env.STRIPE_SECRET_KEY) values.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (process.env.HQ_ANTHROPIC_API_KEY) values.ANTHROPIC_API_KEY = process.env.HQ_ANTHROPIC_API_KEY;
// Sending through Resend (each product from its own verified domain).
if (process.env.RESEND_API_KEY) values.SMTP_URL = `smtps://resend:${encodeURIComponent(process.env.RESEND_API_KEY)}@smtp.resend.com:465`;
// Replies: info+hq@ lands in the owner's Gmail under the "HQ Replies" label, which is all the app reads.
if (process.env.GMAIL_APP_PASSWORD) {
  const user = process.env.REPLY_MAILBOX || "info@felixclarke.com";
  const [local, domain] = user.split("@");
  values.IMAP_URL = `imaps://${encodeURIComponent(user)}:${encodeURIComponent(process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""))}@imap.gmail.com:993`;
  values.IMAP_FOLDER = process.env.REPLY_LABEL || "HQ Replies";
  values.REPLY_TO = `${local}+hq@${domain}`;
}
// Tool keys passed straight through to the app.
for (const k of ["NETLIFY_AUTH_TOKEN", "GODADDY_API_KEY", "GODADDY_API_SECRET", "MAILWIZZ_API_URL", "MAILWIZZ_API_KEY",
  "AWAZ_API_KEY", "FEEDBOSS_API_KEY", "SCOREAPP_API_KEY", "SBL_API_KEY", "SBL_COMPANY_ID", "SBL_WEBHOOK_SECRET"]) {
  if (process.env[k]) values[k] = process.env[k];
}
if (!process.env.RESEND_API_KEY && process.env.MAIL_ADDRESS && process.env.MAIL_APP_PASSWORD) {
  const u = encodeURIComponent(process.env.MAIL_ADDRESS);
  const p = encodeURIComponent(process.env.MAIL_APP_PASSWORD.replace(/\s+/g, ""));
  values.SMTP_URL = `smtps://${u}:${p}@smtp.gmail.com:465`;
  values.IMAP_URL = `imaps://${u}:${p}@imap.gmail.com:993`;
  values.REPLY_TO = process.env.MAIL_ADDRESS;
}

const apps = (await doApi("GET", "/apps?per_page=100")).apps ?? [];
const existing = apps.find((a) => a.spec?.name === spec.name);
if (!existing && !values.ADMIN_PASSWORD) values.ADMIN_PASSWORD = generatedPassword = randomBytes(12).toString("base64url");
// Secret part of the Sbl.so webhook address, made once and kept (HQ shows the full address).
const hasSblToken = (existing?.spec?.services?.[0]?.envs ?? []).some((e) => e.key === "SBL_WEBHOOK_TOKEN" && e.value);
if (!hasSblToken) values.SBL_WEBHOOK_TOKEN = randomBytes(24).toString("base64url");
const hasAwazToken = (existing?.spec?.services?.[0]?.envs ?? []).some((e) => e.key === "AWAZ_WEBHOOK_TOKEN" && e.value);
if (!hasAwazToken) values.AWAZ_WEBHOOK_TOKEN = randomBytes(24).toString("base64url");

// Cal.com (booking calls): find the username, create any missing call types
// (src/products/calls.json), and derive the webhook token from the API key so
// every run knows it without storing it anywhere else.
const CAL_KEY = process.env.CALCOM_API_KEY?.trim();
async function cal(method, path, body) {
  const res = await fetch(`https://api.cal.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${CAL_KEY}`, "cal-api-version": "2026-06-12", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
const asList = (j) => (Array.isArray(j?.data) ? j.data : Array.isArray(j?.data?.eventTypes) ? j.data.eventTypes : Array.isArray(j) ? j : []);
if (CAL_KEY) {
  values.CALCOM_WEBHOOK_TOKEN = createHmac("sha256", CAL_KEY).update("hq-calcom-webhook").digest("base64url").slice(0, 32);
  const me = await cal("GET", "/v2/me");
  const username = me.json?.data?.username;
  if (!username) {
    console.log(`Cal.com: couldn't read the account (${me.status}); booking links stay as they are.`);
  } else {
    values.CALCOM_USERNAME = username;
    const have = new Set(asList((await cal("GET", `/v2/event-types?username=${encodeURIComponent(username)}`)).json).map((e) => e.slug));
    const { calls } = JSON.parse(readFileSync(new URL("../src/products/calls.json", import.meta.url), "utf8"));
    for (const c of calls) {
      const slug = `${c.product}-${c.kind}`;
      if (have.has(slug)) continue;
      const description = c.kind === "onboarding"
        ? "Your onboarding call: we go through what you need so everything is set up right from the start."
        : "A friendly chat about your business and whether this is right for you.";
      const r = await cal("POST", "/v2/event-types", { title: c.title, slug, lengthInMinutes: c.minutes, description });
      console.log(`Cal.com: call type ${slug} ${r.ok ? "created" : `not created (${r.status} ${JSON.stringify(r.json).slice(0, 200)})`}`);
    }
    console.log(`Cal.com: booking links are cal.com/${username}/<product>-chat and -onboarding.`);
  }
}

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

// Deployments created from here on belong to this run (with a margin for clock differences).
const startedAt = Date.now() - 30_000;
let app;
if (existing) {
  console.log(`Updating ${spec.name}…`);
  app = (await doApi("PUT", `/apps/${existing.id}`, { spec: applyValues(structuredClone(spec), existing.spec) })).app;
} else {
  console.log(`Creating ${spec.name} (web ${service.instance_size_slug} + dev database)…`);
  app = (await doApi("POST", "/apps", { spec: applyValues(structuredClone(spec)) })).app;
}

/** Print the end of DigitalOcean's logs for a failed deployment, so the cause is visible. */
async function printFailureLogs(appId) {
  const deployments = (await doApi("GET", `/apps/${appId}/deployments?per_page=1`)).deployments ?? [];
  const dep = deployments[0];
  if (!dep) return;
  console.log(`\nLatest deployment ${dep.id}: ${dep.phase}`);
  for (const step of dep.progress?.steps ?? []) {
    if (step.status === "ERROR") console.log(`  failed step: ${step.name} ${step.reason?.message ?? ""}`);
  }
  for (const type of ["BUILD", "DEPLOY", "RUN"]) {
    try {
      const logs = await doApi("GET", `/apps/${appId}/deployments/${dep.id}/components/web/logs?type=${type}`);
      for (const url of logs.historic_urls ?? (logs.live_url ? [logs.live_url] : [])) {
        const text = await (await fetch(url)).text();
        console.log(`--- ${type} log (last 60 lines) ---`);
        console.log(text.trim().split("\n").slice(-60).join("\n"));
      }
    } catch (err) {
      console.log(`(no ${type} log: ${err.message})`);
    }
  }
}

// Wait for the deployment this run started (or a newer one from a push) to go live.
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  app = (await doApi("GET", `/apps/${app.id}`)).app;
  const latest = (await doApi("GET", `/apps/${app.id}/deployments?per_page=1`)).deployments?.[0];
  const isNew = latest && new Date(latest.created_at).getTime() >= startedAt;
  process.stdout.write(`  ${latest?.phase ?? "pending"}\r`);
  if (isNew && latest.phase === "ACTIVE" && app.live_url) break;
  if (isNew && ["ERROR", "CANCELED"].includes(latest.phase)) {
    await printFailureLogs(app.id);
    throw new Error(`Deployment ${latest.phase}; see the logs above.`);
  }
  // Nothing changed, so no new deployment was started: the running version is current.
  if (!isNew && !app.in_progress_deployment && !app.pending_deployment && i >= 3 && app.active_deployment?.phase === "ACTIVE") break;
  if (i === 149) throw new Error("Timed out waiting for the new version to go live");
}
if (!app.live_url) throw new Error("Timed out waiting for the app to go live");
console.log(`\nLive at ${app.live_url}`);

// Point the dashboard's and client areas' subdomains at the app (GoDaddy), if keys are given.
// Only CNAMEs for these exact subdomains are written; nothing else in the zone is touched.
const ingress = app.default_ingress?.replace(/^https?:\/\//, "").replace(/\/$/, "");
if (ingress && process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET) {
  const auth = { Authorization: `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`, "Content-Type": "application/json" };
  // Zones whose DNS isn't in GoDaddy; their records are set where the DNS lives.
  const notInGoDaddy = new Set(["emailfirst.co.uk"]);
  for (const { domain } of spec.domains ?? []) {
    const parts = domain.split(".");
    const name = parts[0];
    const zone = parts.slice(1).join(".");
    if (notInGoDaddy.has(zone)) {
      console.log(`DNS: ${domain} is managed in Cloudflare; skipped.`);
      continue;
    }
    // Don't overwrite an existing A record with the same name.
    const existingA = await fetch(`https://api.godaddy.com/v1/domains/${zone}/records/A/${name}`, { headers: auth });
    if (existingA.ok && (await existingA.json()).length) {
      console.log(`DNS: ${domain} already has an A record; left alone.`);
      continue;
    }
    const res = await fetch(`https://api.godaddy.com/v1/domains/${zone}/records/CNAME/${name}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify([{ data: ingress, ttl: 600 }]),
    });
    console.log(`DNS: ${domain} -> ${ingress} (${res.status}${res.ok ? "" : ` ${(await res.text()).slice(0, 200)}`})`);
  }
}

// Stripe webhook, created once; its signing secret is only shown at creation.
if (process.env.STRIPE_SECRET_KEY) {
  const url = `${app.live_url}/webhooks/stripe`;
  const { data } = await stripe("GET", "/webhook_endpoints?limit=100");
  const events = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted",
    "invoice.finalized", "invoice.payment_failed", "invoice.paid", "charge.dispute.created", "charge.dispute.updated",
    "charge.dispute.closed"];
  const eventForm = {};
  events.forEach((e, i) => (eventForm[`enabled_events[${i}]`] = e));
  const existing = data.find((w) => w.url === url);
  if (!existing) {
    const hook = await stripe("POST", "/webhook_endpoints", { url, description: "Products HQ", ...eventForm });
    console.log("Created Stripe webhook; setting its secret on the app…");
    values.STRIPE_WEBHOOK_SECRET = hook.secret;
    const current = (await doApi("GET", `/apps/${app.id}`)).app.spec;
    await doApi("PUT", `/apps/${app.id}`, { spec: applyValues(structuredClone(spec), current) });
  } else {
    // Keep the event list current as the app learns to handle more events.
    if (events.some((e) => !existing.enabled_events.includes(e))) {
      await stripe("POST", `/webhook_endpoints/${existing.id}`, eventForm);
      console.log("Updated the Stripe webhook's events.");
    } else {
      console.log("Stripe webhook already exists.");
    }
  }
}

// Cal.com tells HQ about bookings.
if (CAL_KEY && values.CALCOM_USERNAME) {
  const subscriberUrl = `${app.live_url}/webhooks/calcom/${values.CALCOM_WEBHOOK_TOKEN}`;
  const hooks = asList((await cal("GET", "/v2/webhooks")).json);
  if (hooks.some((h) => h.subscriberUrl === subscriberUrl)) {
    console.log("Cal.com webhook already exists.");
  } else {
    const r = await cal("POST", "/v2/webhooks", {
      active: true,
      subscriberUrl,
      triggers: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"],
      secret: createHmac("sha256", CAL_KEY).update("hq-calcom-secret").digest("base64url"),
    });
    console.log(`Cal.com webhook ${r.ok ? "created" : `not created (${r.status} ${JSON.stringify(r.json).slice(0, 200)})`}.`);
  }
}

if (generatedPassword) console.log(`Dashboard password (store it somewhere safe): ${generatedPassword}`);
console.log("Done.");
