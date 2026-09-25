// Exercises the Claude-drafting paths against a local stand-in for the
// Messages API (streamed SSE), checking both the request we send and the
// way drafts flow through approval.
import http from "node:http";
import type { AddressInfo } from "node:net";

const requests: any[] = [];
let nextReply: Record<string, unknown> = {};

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    const text = JSON.stringify(nextReply);
    const events: [string, unknown][] = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hq:hq@localhost:5432/products_hq_test";
process.env.BASE_URL = "https://hq.example.com";

import assert from "node:assert/strict";
import { after, before, beforeEach, it } from "node:test";

const { pool, query, one } = await import("../src/db/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { createLead, processLeads } = await import("../src/engine/leads.js");
const { handleInbound } = await import("../src/engine/inbound.js");
const { runOutreach, importProspects } = await import("../src/engine/outreach.js");
const { setSetting } = await import("../src/lib/settings.js");

before(async () => {
  await migrate();
});
after(async () => {
  await pool.end();
  fake.close();
});
beforeEach(async () => {
  requests.length = 0;
  await query(`TRUNCATE suppressions, prospects, inbound_emails, leads, customers, onboarding_steps, tasks, emails,
    deliveries, disputes, stripe_events, events, job_runs, health_checks, settings, sessions RESTART IDENTITY CASCADE`);
});

it("drafts enquiry replies with Claude using structured output and server-side fallbacks", async () => {
  nextReply = { subject: "Your AI visibility", body: "Hello Jo,\n\nThanks for asking.\n\nFelix" };
  await createLead({ product: "firstpagelocal", name: "Jo", email: "jo@x.co", message: "plumber stockport" });
  const r = await processLeads();
  assert.equal(r.drafted, 1);

  const sent = requests[0];
  assert.equal(sent.url, "/v1/messages?beta=true");
  assert.match(String(sent.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.model, "claude-opus-5");
  assert.equal(sent.body.fallbacks, "default");
  assert.deepEqual(sent.body.thinking, { type: "adaptive" });
  assert.equal(sent.body.output_config.format.type, "json_schema");
  assert.equal(sent.body.stream, true);
  assert.match(sent.body.messages[0].content, /https:\/\/hq\.example\.com\/buy\/firstpagelocal\/monthly\?lead=1/);

  const email = await one(`SELECT * FROM emails`);
  assert.equal(email.subject, "Your AI visibility");
  assert.equal(email.status, "draft");
});

it("drafts an answer to a lead's reply and holds it for approval", async () => {
  nextReply = { subject: "Your AI visibility", body: "first" };
  await createLead({ product: "firstpagelocal", email: "jo@x.co" });
  await processLeads();
  nextReply = { intent: "question", summary: "Asks about price", reply_subject: "Re: price", reply_body: "It's £29 a month." };
  const intent = await handleInbound({ from: "jo@x.co", subject: "Re: Your AI visibility", text: "How much is it?" });
  assert.equal(intent, "question");
  const reply = await one(`SELECT * FROM emails WHERE kind = 'reply'`);
  assert.equal(reply.status, "draft");
  const task = await one(`SELECT * FROM tasks WHERE payload->>'emailId' = $1`, [String(reply.id)]);
  assert.ok(task.payload.inboundId);
});

it("writes cold emails individually with the opt-out line, within the daily cap", async () => {
  nextReply = { subject: "Missed calls at Firm", body: "Hello,\n\nA short note.\n\nFelix" };
  await importProspects("speedtolead", "email,company\na@one.co,One Ltd\nb@two.co,Two Ltd\nc@three.co,Three Ltd\n", "test");
  await setSetting("outreach:speedtolead", { enabled: true, dailyCap: 2 });
  const r = await runOutreach(new Date("2026-09-29T09:00:00Z"));
  assert.equal(r, "queued Speed to Lead: 2");
  const emails = await query(`SELECT * FROM emails WHERE kind = 'outreach_1'`);
  assert.equal(emails.length, 2);
  assert.match(emails[0].body_text, /reply "stop" and we won't email you again/);
  assert.equal(await runOutreach(new Date("2026-09-29T10:00:00Z")), "nothing due");
  const p = await one(`SELECT * FROM prospects WHERE email = 'a@one.co'`);
  assert.equal(p.status, "in_sequence");
  assert.equal(p.step, 1);
});
