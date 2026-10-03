// Integrations driven through their APIs, with fetch faked: no external calls.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hq:hq@localhost:5432/products_hq_test";
process.env.LOCALFALCON_API_KEY = "lf_test";
process.env.GBP_MANAGER_EMAIL = "felix@example.com";
process.env.AWAZ_API_KEY = "awaz_test";
process.env.AWAZ_WEBHOOK_TOKEN = "awaz-hook";
process.env.BASE_URL = "https://hq.example.com";
process.env.SBL_API_KEY = "sbl_test";
process.env.SBL_COMPANY_ID = "42";
process.env.MAILWIZZ_API_URL = "https://mw.example.com/api";
process.env.MAILWIZZ_API_KEY = "mw_test";
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
    await query(`TRUNCATE customers, emails, tasks, awaz_events, prospect_db, suppressions RESTART IDENTITY CASCADE`);
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

  it("Speed to Lead: finds the assistant by name, links its calls, and ticks the test calls when they come back", async () => {
    const product = requireProduct("speedtolead");
    const customer = await one(
      `INSERT INTO customers (product, plan, email, name, business, data) VALUES ('speedtolead', 'solo', 'al@heat.co.uk', 'Al', 'Al Heating', '{}') RETURNING *`,
    );
    let hook: any;
    globalThis.fetch = (async (url: string, init: any) => {
      const path = new URL(url).pathname;
      if (path === "/v1/agents") return new Response(JSON.stringify({ items: [{ id: "ag_77", name: "STL Al Heating" }] }));
      if (path === "/v1/hooks/calls") hook = JSON.parse(init.body);
      return new Response("{}");
    }) as typeof fetch;
    const out = await getHandler("stl_provision_agent")({ product, customer, input: "STL Al Heating, +441134960000" });
    assert.equal(out.type, "done");
    assert.deepEqual(hook.agents, ["ag_77"]);
    assert.equal(hook.hookUrl, "https://hq.example.com/webhooks/awaz/awaz-hook");
    const linked = (await one(`SELECT data FROM customers WHERE id = $1`, [customer.id])).data;
    assert.deepEqual(linked.awaz_agent_ids, ["ag_77"]);

    // Test calls placed earlier; three call events for the assistant complete the step.
    await query(`UPDATE customers SET data = data || jsonb_build_object('test_calls_started_at', to_jsonb(now() - interval '1 minute')) WHERE id = $1`, [customer.id]);
    const step = await one(`INSERT INTO onboarding_steps (customer_id, position, key, title, kind, status) VALUES ($1, 7, 'test_calls', 'Test calls', 'auto', 'waiting') RETURNING id`, [customer.id]);
    const { handleAwazEvent } = await import("../src/engine/awaz.js");
    for (const summary of ["Booked a boiler service", "Out of area, politely declined", "Asked for a call back"]) {
      await handleAwazEvent({ event: "call_ended", agent_id: "ag_77", summary });
    }
    assert.equal((await one(`SELECT status FROM onboarding_steps WHERE id = $1`, [step.id])).status, "done");
    assert.ok(await one(`SELECT 1 FROM emails WHERE subject LIKE '%test calls done for Al Heating%'`));
  });

  it("Linkn: talks to Sbl.so's API, drafts a campaign on the client's sender and sends approved replies", async () => {
    const tools: { name: string; args: any }[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const msg = JSON.parse(init.body);
      if (msg.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), { headers: { "mcp-session-id": "s1", "content-type": "application/json" } });
      if (!msg.id) return new Response("", { status: 202 });
      tools.push({ name: msg.params.name, args: msg.params.arguments });
      const reply: Record<string, unknown> = {
        sbl_create_campaign_from_prompt: { id: 901 },
        sbl_get_campaign: { id: 901, revision: 3 },
      };
      const text = JSON.stringify(reply[msg.params.name] ?? { ok: true });
      // Answer as a server-sent event stream, as the hosted server can.
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { draftCampaign } = await import("../src/integrations/sbl.js");
    const id = await draftCampaign("A brief long enough to pass", "lnk-1-cold-2026-10", 55);
    assert.equal(id, "901");
    const bind = tools.find((t) => t.name === "sbl_bind_linkedin_channel")!;
    assert.deepEqual([bind.args.channel_id, bind.args.expected_revision, bind.args.company_id], [55, 3, 42]);

    const customer = await one(`SELECT * FROM customers LIMIT 1`);
    const note = await runPublisher("sbl_replies", customer, { replies: [{ campaignId: "901", userId: "u1", reply: "Draft" }] }, "Conversation #1 with Sam:\nHi\nReply #1:\nThanks Sam, shall we talk Tuesday?");
    assert.equal(note, "Sent 1 LinkedIn reply");
    const sent = tools.find((t) => t.name === "sbl_reply_and_resolve")!;
    assert.equal(sent.args.message, "Thanks Sam, shall we talk Tuesday?");
    assert.equal(sent.args.company_id, "42");
  });

  it("every handler a product names exists", async () => {
    const { handlerNames } = await import("../src/engine/handlers.js");
    const { products } = await import("../src/products/index.js");
    const names = new Set(handlerNames());
    for (const p of products) {
      for (const st of p.onboarding) if (st.handler) assert.ok(names.has(st.handler), `${p.slug}: ${st.handler}`);
      for (const r of p.routines) assert.ok(names.has(r.handler), `${p.slug}: ${r.handler}`);
    }
  });

  it("loads the master prospect file and picks contacts: matching, never suppressed, never twice", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { importProspectFile, pickProspects, countMatches } = await import("../src/engine/prospectdb.js");
    const file = "/tmp/hq-prospects-test.csv";
    await writeFile(file, 'Email,First Name,Surname,Company Name,Job Title,Industry,County\n' +
      'ann@acme.co.uk,Ann,Lee,"Acme, Ltd",Managing Director,Construction,Yorkshire\n' +
      'bob@build.co.uk,Bob,Hill,Build Co,Director,Construction,Kent\n' +
      'cat@shop.co.uk,Cat,May,Shop,Shop Assistant,Retail,Kent\n' +
      'not-an-email,X,Y,Z,Director,Construction,Kent\n' +
      'dan@nope.co.uk,Dan,Fox,Nope,Director,Construction,Kent\n');
    const r = await importProspectFile(file);
    assert.equal(r.imported, 4);
    await query(`INSERT INTO suppressions (value, reason) VALUES ('dan@nope.co.uk', 'test')`);
    const customer = await one(`INSERT INTO customers (product, plan, email) VALUES ('emailfirst', 'weekly', 'c@x.co.uk') RETURNING *`);
    const filter = { titles: ["director"], sectors: ["construction"], regions: [], exclude: [] };
    assert.equal(await countMatches(filter, customer.id), 2);
    const first = await pickProspects(filter, customer.id, 10, "b1");
    assert.deepEqual(first.map((p) => p.email).sort(), ["ann@acme.co.uk", "bob@build.co.uk"]);
    assert.equal(first.find((p) => p.email === "ann@acme.co.uk")!.company, "Acme, Ltd");
    assert.equal((await pickProspects(filter, customer.id, 10, "b2")).length, 0);
  });

  it("EmailFirst: a day's send creates the list, loads the contacts and schedules the opener", async () => {
    const product = requireProduct("emailfirst");
    const calls: { method: string; path: string; body: URLSearchParams }[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      const path = new URL(url).pathname.replace("/api", "");
      calls.push({ method: init?.method ?? "GET", path, body: new URLSearchParams(init?.body ?? "") });
      if (path === "/lists" && init?.method === "POST") return new Response(JSON.stringify({ status: "success", list_uid: "L1" }));
      if (path === "/campaigns" && init?.method === "POST") return new Response(JSON.stringify({ status: "success", campaign_uid: "C1" }));
      if (path.endsWith("/fields") && !init?.method) return new Response(JSON.stringify({ status: "success", data: { records: [{ tag: "EMAIL" }] } }));
      return new Response(JSON.stringify({ status: "success", data: {} }));
    }) as typeof fetch;
    await query(`UPDATE prospect_db SET last_used_at = NULL`);
    await query(`DELETE FROM prospect_uses`);
    const customer = await one(
      `INSERT INTO customers (product, plan, email, business, data) VALUES ('emailfirst', 'weekly', 'd@x.co.uk', 'Dee Ltd', $1) RETURNING *`,
      [JSON.stringify({
        intake: { sender_name: "Dee", reply_to: "dee@dee.co.uk", company: "Dee Ltd" },
        ef_filters: { titles: ["director"], sectors: [], regions: [], exclude: [] },
        ef_templates: ["T1", "T2", "T3"],
        ef_copy: { emails: [{ subject: "Quick question, {FNAME}", body: "Hi {FNAME}" }, { subject: "b", body: "b" }, { subject: "c", body: "c" }], landing: "" },
      })],
    );
    const out = await getHandler("ef_daily_send")({ product, customer });
    assert.equal(out.type, "done");
    assert.ok(calls.some((c) => c.path === "/lists/L1/subscribers/bulk" && c.body.get("subscribers[0][EMAIL]")));
    const campaign = calls.find((c) => c.path === "/campaigns" && c.method === "POST")!;
    assert.equal(campaign.body.get("campaign[subject]"), "Quick question, [FNAME]");
    assert.equal(campaign.body.get("campaign[template][template_uid]"), "T1");
    assert.equal(campaign.body.get("campaign[reply_to]"), "dee@dee.co.uk");
    const saved = (await one(`SELECT data FROM customers WHERE id = $1`, [customer.id])).data;
    assert.equal(saved.ef_lists[0].list, "L1");
    assert.deepEqual(saved.ef_lists[0].campaigns, ["C1"]);
  });

  it("brings in Business Leads' Mailpulse contacts, keeping master details and honouring unsubscribes", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      const path = u.pathname.replace("/api", "");
      if (path === "/lists") return new Response(JSON.stringify({ status: "success", data: { records: [{ general: { list_uid: "LA", name: "LR | directors | 2026-09-08" } }, { general: { list_uid: "LE", name: "EF | Dee | 2026-10-01" } }], total_pages: 1 } }));
      if (path === "/lists/LA/subscribers") return new Response(JSON.stringify({ status: "success", data: { total_pages: 1, records: [
        { EMAIL: "ann@acme.co.uk", FNAME: "Annie", COMPANY: "Other", status: "confirmed" },
        { EMAIL: "new@fresh.co.uk", FNAME: "Nia", TITLE: "Director", status: "confirmed" },
        { EMAIL: "gone@away.co.uk", status: "unsubscribed" },
      ] } }));
      return new Response(JSON.stringify({ status: "success", data: { records: [] } }));
    }) as typeof fetch;
    const { syncFromMailpulse } = await import("../src/engine/prospectdb.js");
    const result = await syncFromMailpulse();
    assert.match(result, /1 list\(s\) synced: 2 contacts merged, 1 unsubscribed/);
    const ann = await one(`SELECT * FROM prospect_db WHERE email = 'ann@acme.co.uk'`);
    assert.equal(ann.first_name, "Ann"); // the master file's details win
    assert.deepEqual(ann.extra.lists, ["LR | directors | 2026-09-08"]);
    assert.ok(await one(`SELECT 1 FROM prospect_db WHERE email = 'new@fresh.co.uk'`));
    assert.ok(await one(`SELECT 1 FROM suppressions WHERE value = 'gone@away.co.uk'`));
    assert.match(await syncFromMailpulse(), /^0 list/); // unchanged lists are skipped
  });
});
