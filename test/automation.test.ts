// Integrations driven through their APIs, with fetch faked: no external calls.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hq:hq@localhost:5432/products_hq_test";
process.env.LOCALFALCON_API_KEY = "lf_test";
process.env.GBP_MANAGER_EMAIL = "felix@example.com";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SMTP_URL;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { pool, query, one } = await import("../src/db/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { getHandler } = await import("../src/engine/handlers.js");
const { runPublisher, parseReplyBlocks } = await import("../src/engine/publishers.js");
const { formFields } = await import("../src/integrations/localfalcon.js");
const { requireProduct } = await import("../src/products/index.js");

type Call = { path: string; fields: URLSearchParams };
const calls: Call[] = [];
const realFetch = globalThis.fetch;

function fakeLocalFalcon(responses: Record<string, unknown>) {
  globalThis.fetch = (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push({ path, fields: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ code: 200, success: true, data: responses[path] ?? {} }), { status: 200 });
  }) as typeof fetch;
}

describe("Local Falcon (Online Business Builder)", () => {
  before(async () => {
    await migrate();
    await query(`TRUNCATE customers, emails, tasks RESTART IDENTITY CASCADE`);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await pool.end();
  });

  it("encodes nested fields the way Local Falcon expects", () => {
    const f = formFields({ replies: [{ place_id: "p", review_id: "r1", reply: "Thanks" }], ok: true });
    assert.equal(f.get("replies[0][review_id]"), "r1");
    assert.equal(f.get("ok"), "true");
  });

  it("finds the client's connected profile, then sets up scans and monitoring", async () => {
    const product = requireProduct("onlinebusinessbuilder");
    const customer = await one(
      `INSERT INTO customers (product, plan, email, name, business, data)
       VALUES ('onlinebusinessbuilder', 'monthly', 'jo@plumb.co.uk', 'Jo', 'Jo Plumbing', $1) RETURNING *`,
      [JSON.stringify({ intake: { gbp_name: "Jo Plumbing Ltd", business_type: "plumber", area: "Leeds" } })],
    );
    const connect = getHandler("obb_gbp_connect");

    // Not imported into Local Falcon yet: the client is emailed and Felix gets a short guided task.
    fakeLocalFalcon({ "/v1/locations/": [] });
    const first = await connect({ product, customer });
    assert.equal(first.type, "manual");
    assert.ok(await one(`SELECT 1 FROM emails WHERE to_address = 'jo@plumb.co.uk' AND subject LIKE '%Google Business Profile%'`));

    fakeLocalFalcon({ "/v1/locations/": [{ place_id: "ChIJ123", name: "Jo Plumbing Ltd" }], "/v2/campaigns/create": { campaign_key: "camp9" } });
    const fresh = await one(`SELECT * FROM customers WHERE id = $1`, [customer.id]);
    const second = await connect({ product, customer: fresh });
    assert.equal(second.type, "done");
    const saved = (await one(`SELECT data FROM customers WHERE id = $1`, [customer.id])).data;
    assert.equal(saved.gbp_place_id, "ChIJ123");
    assert.equal(saved.lf_campaign_key, "camp9");
    const campaign = calls.find((c) => c.path === "/v2/campaigns/create")!;
    assert.equal(campaign.fields.get("keyword"), "plumber Leeds,plumber near me,best plumber Leeds");
    assert.equal(campaign.fields.get("frequency"), "monthly");
    assert.ok(calls.some((c) => c.path === "/v2/guard/add"));
  });

  it("publishes approved review replies, including Felix's edits", async () => {
    const customer = await one(`SELECT * FROM customers WHERE business = 'Jo Plumbing'`);
    calls.length = 0;
    fakeLocalFalcon({});
    const edited = "Review #1 (5 stars, Sam): Great job\nReply #1:\nThank you Sam, lovely to hear.\n\nReview #2 (4 stars, Lee): Good\nReply #2:\nThanks Lee.";
    assert.equal(parseReplyBlocks(edited).get(1), "Thank you Sam, lovely to hear.");
    const note = await runPublisher("gbp_review_replies", customer, { replies: [{ reviewId: "r1", reply: "Draft one" }, { reviewId: "r2", reply: "Draft two" }] }, edited);
    assert.equal(note, "Replied to 2 reviews");
    const sent = calls.find((c) => c.path === "/v2/gbp/reply-review/")!;
    assert.equal(sent.fields.get("replies[0][reply]"), "Thank you Sam, lovely to hear.");
    assert.equal(sent.fields.get("replies[1][review_id]"), "r2");
  });
});
