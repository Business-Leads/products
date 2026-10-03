import { config } from "../config.js";
import { getIntegration } from "../integrations/index.js";
import { draftJson, emailSchema, type EmailDraft } from "../lib/claude.js";
import { bookingLink, getPlan } from "../products/index.js";
import { NotConfiguredError } from "../lib/util.js";
import { query } from "../db/index.js";
import { checkAvailable, domainIdeas, inOurAccount, NETLIFY_IP, pointAtNetlify } from "../integrations/godaddy.js";
import { campaignStats } from "../integrations/mailwizz.js";
import { addGuard, campaignSummary, createMonthlyCampaign, guardChanges, linkedLocations, profileMetrics, unansweredReviews } from "../integrations/localfalcon.js";
import { queueEmail } from "../lib/email.js";
import { generatePost, recentPosts } from "../integrations/feedboss.js";
import { createSite, deployFiles, setCustomDomain } from "../integrations/netlify.js";
import { postUpdate, saveMetrics } from "./clients.js";
import { portalUrl, setupLink } from "../portal/accounts.js";
import type { Handler, HandlerContext, Outcome } from "./types.js";

// Step and routine handlers, referenced by name from the product registry.
// Each returns an Outcome; engine/outcomes.ts does the bookkeeping.

/**
 * Integrations marked "manual" have no API wiring yet. Calling this makes the
 * engine fall back to a manual task using the step's instructions, which is
 * the honest behaviour until the API is connected.
 */
function requireAutomation(integrationId: string): void {
  const integration = getIntegration(integrationId);
  if (!integration?.configured() || integration.automation !== "full") {
    throw new NotConfiguredError(integrationId, `${integration?.name ?? integrationId} is not automated yet`);
  }
}

function firstName(ctx: HandlerContext): string {
  return (ctx.customer.name ?? "").split(/\s+/)[0] || "there";
}

function intakeSummary(ctx: HandlerContext): string {
  const answers = ctx.customer.data.intake ?? {};
  return ctx.product.intake
    .filter((f) => answers[f.key])
    .map((f) => `${f.label}: ${answers[f.key]}`)
    .join("\n");
}

function customerLabel(ctx: HandlerContext): string {
  return ctx.customer.business || ctx.customer.name || ctx.customer.email;
}

async function draftCustomerEmail(ctx: HandlerContext, task: string, material = ""): Promise<EmailDraft> {
  const plan = getPlan(ctx.product, ctx.customer.plan);
  return draftJson<EmailDraft>({
    system:
      `You write emails for ${ctx.product.name}. ${ctx.product.description}\n\n` +
      `Voice: ${ctx.product.voice}\n` +
      `Never invent facts, numbers, results or promises that are not in the material provided.`,
    prompt:
      `Customer: ${ctx.customer.name ?? ""} (${customerLabel(ctx)}), plan: ${plan?.name ?? ctx.customer.plan}.\n\n` +
      `Their intake answers:\n${intakeSummary(ctx) || "(none yet)"}\n\n` +
      (material ? `Material:\n${material}\n\n` : "") +
      `Task: ${task}`,
    schema: emailSchema,
  });
}

async function previousDelivery(ctx: HandlerContext): Promise<Record<string, any> | undefined> {
  if (!ctx.delivery) return undefined;
  const rows = await query(
    `SELECT content FROM deliveries WHERE customer_id = $1 AND routine = $2 AND status = 'delivered' AND id <> $3
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.customer.id, ctx.delivery.routine, ctx.delivery.id],
  );
  return rows[0]?.content;
}

/** Ask a person for data (scan results, stats) until an API is wired, then draft from it. */
function needData(ctx: HandlerContext, what: string, instructions: string): Outcome {
  return {
    type: "manual",
    title: `${what} for ${customerLabel(ctx)}`,
    instructions,
    inputLabel: `Paste ${what.toLowerCase()} here`,
    rerun: true,
  };
}

/**
 * Put something in the client's account for them to approve (once), then wait.
 * Approving completes the step; asking for changes raises a to-do for Felix.
 */
async function askClientToApprove(ctx: HandlerContext, u: { title: string; body: string; link?: string }): Promise<Outcome> {
  const key = `asked_${ctx.step?.key}`;
  if (!ctx.customer.data[key]) {
    await postUpdate(ctx.customer, { ...u, approvalStep: ctx.step?.key });
    await query(`UPDATE customers SET data = data || jsonb_build_object($2::text, true) WHERE id = $1`, [ctx.customer.id, key]);
  }
  return { type: "waiting", note: "Waiting for the client to approve in their account" };
}

const handlers: Record<string, Handler> = {
  // ---------------------------------------------------------------- shared

  async send_welcome(ctx) {
    // The account link lets them create a password; everything else happens in their account.
    const link = await setupLink(ctx.customer);
    const account = portalUrl(ctx.product);
    if (ctx.product.bookingAfterPurchase) {
      return {
        type: "email",
        approval: false,
        subject: `Welcome to ${ctx.product.name}: book your onboarding call`,
        body:
          `Hello ${firstName(ctx)},\n\nThank you for signing up to ${ctx.product.name}. The next step is a short ` +
          `onboarding call with me, so we get everything right from the start. Pick a time that suits you:\n\n` +
          `${bookingLink(ctx.product, ctx.customer.name, ctx.customer.email, "onboarding", ctx.customer.id)}\n\n` +
          `Your account is where you'll follow progress, see reports and download invoices. If you haven't ` +
          `set your password yet, do it here:\n\n${link}\n\nBefore the call, it helps if you fill in the short ` +
          `form about your business in your account (about five minutes).\n\n` +
          `You can sign in any time at ${account}\n\nIf anything is unclear, just reply to this email.\n\nFelix`,
      };
    }
    return {
      type: "email",
      approval: false,
      subject: `Welcome to ${ctx.product.name}: one form to get started`,
      body:
        `Hello ${firstName(ctx)},\n\n` +
        `Thank you for signing up to ${ctx.product.name}. Your account is where you'll follow progress, see ` +
        `reports and download invoices. If you haven't set your password yet, do it here:\n\n${link}\n\n` +
        `The next step is a short form in your account so we can set everything up for you. It takes about ` +
        `five minutes. As soon as it's in, we'll get to work and keep you posted.\n\n` +
        `You can sign in any time at ${account}\n\nIf anything is unclear, just reply to this email.\n\nFelix`,
    };
  },

  async await_intake(ctx) {
    if (ctx.customer.data.intake_completed_at) return { type: "done" };
    return { type: "waiting", note: "Waiting for the customer to complete the intake form" };
  },

  async go_live(ctx) {
    await query(
      `UPDATE customers SET status = CASE WHEN status = 'onboarding' THEN 'active' ELSE status END,
       activated_at = COALESCE(activated_at, now()), updated_at = now() WHERE id = $1`,
      [ctx.customer.id],
    );
    return {
      type: "email",
      approval: false,
      subject: `${ctx.product.name} is live`,
      body:
        `Hello ${firstName(ctx)},\n\nEverything is set up and ${ctx.product.name} is now live for ` +
        `${customerLabel(ctx)}. You don't need to do anything else. Your results and reports will appear in ` +
        `your account as they come in:\n\n${portalUrl(ctx.product)}\n\nYou can reply to this email at any time.\n\nFelix`,
    };
  },

  // -------------------------------------------------------- FirstPageLocal

  async fpl_provision_scans() {
    requireAutomation("localfalcon");
    return { type: "done" };
  },

  async fpl_first_report(ctx) {
    if (!ctx.input) {
      return needData(
        ctx,
        "Baseline scan results",
        "Run the baseline Maps grid scan and AI visibility checks in Local Falcon for each search, then " +
          "paste the results (rank per search, who AI recommended, sources given, top competitors).",
      );
    }
    const draft = await draftCustomerEmail(
      ctx,
      "Write the customer's first monthly FirstPageLocal report as an email. Sections: whether AI " +
        "recommends them for each search; who was recommended instead; their Google Maps position across " +
        "their area; and a prioritised list of 3–6 plain-English actions. Say this is the baseline and that " +
        "next month's report will show what changed. Use only the scan results given.",
      ctx.input,
    );
    return { type: "email", approval: true, ...draft };
  },

  async fpl_monthly_report(ctx) {
    if (!ctx.input) {
      return needData(
        ctx,
        "This month's scan results",
        "Run this month's Maps grid scan and AI visibility checks in Local Falcon and paste the results.",
      );
    }
    const last = await previousDelivery(ctx);
    const draft = await draftCustomerEmail(
      ctx,
      "Write this month's FirstPageLocal report as an email: whether AI recommends them for each search, " +
        "who was recommended instead, their Maps position, what changed since last month, and a " +
        "prioritised list of 3–6 actions. Use only the data given.",
      `This month's results:\n${ctx.input}\n\nLast month's report:\n${last?.body ?? "(none)"}`,
    );
    return { type: "email", approval: true, ...draft };
  },

  // ----------------------------------------------------------------- Linkn

  async linkn_profile_rewrite(ctx) {
    const draft = await draftCustomerEmail(
      ctx,
      "Draft a rewritten LinkedIn headline (under 220 characters), About section (under 2,000 characters, " +
        "first person) and three Featured section ideas for this client, based only on their intake. " +
        "Present them in an email asking the client to make the changes themselves and reply with any edits.",
    );
    return { type: "email", approval: true, ...draft };
  },

  async linkn_kickoff(ctx) {
    return {
      type: "manual",
      title: `Kickoff call with ${customerLabel(ctx)}`,
      instructions: "Hold the kickoff call, then type your notes below.",
      inputLabel: "Notes from the call (who to reach, who to avoid, anything about their voice)",
      saveAs: "call_notes",
    };
  },

  async linkn_reply_triage(ctx) {
    requireAutomation("sblso");
    return { type: "done", note: `No automated triage for ${customerLabel(ctx)}` };
  },

  async linkn_weekly_harvest() {
    // Moving post engagers into the warm campaign happens in Sbl.so.
    requireAutomation("sblso");
    return { type: "done" };
  },

  /**
   * This week's three posts, drafted in the client's own voice in their
   * FeedBoss workspace. Nothing is published: Felix checks and schedules them.
   */
  async linkn_weekly_posts(ctx) {
    requireAutomation("feedboss");
    const workspace: string | undefined = ctx.customer.data.feedboss_workspace;
    if (!workspace) {
      return {
        type: "manual",
        title: `Link ${customerLabel(ctx)}'s FeedBoss workspace`,
        instructions: "Paste the id of this client's FeedBoss workspace (in FeedBoss: Workspace Settings). From then on their posts are drafted there every week.",
        inputLabel: "FeedBoss workspace id",
        saveAs: "feedboss_workspace",
        rerun: true,
      };
    }
    const briefs = await draftJson<{ posts: string[] }>({
      system: `You plan LinkedIn posts for Linkn clients. ${ctx.product.voice}`,
      prompt:
        `Client details:\n${intakeSummary(ctx)}\n\nThis month's content plan:\n${ctx.customer.data.content_plan ?? "(none yet)"}\n\n` +
        `Week starting ${ctx.delivery?.period ?? "this week"}. Write three short briefs (two or three sentences each) for this week's ` +
        "posts: the point to make, the angle, and who it is for. At least one should answer an objection their buyers raise. " +
        "Use only facts from the details and plan.",
      schema: {
        type: "object",
        properties: { posts: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
        required: ["posts"],
        additionalProperties: false,
      },
      maxTokens: 4000,
    });
    const ids: string[] = [];
    for (const brief of briefs.posts.slice(0, 3)) ids.push(await generatePost(workspace, brief));
    const drafts = (await recentPosts(workspace)).filter((p) => ids.includes(p.id));
    if (ctx.delivery) {
      await query(`UPDATE deliveries SET content = content || $2::jsonb WHERE id = $1`, [ctx.delivery.id, JSON.stringify({ feedboss_posts: ids })]);
    }
    return {
      type: "manual",
      title: `Check and schedule this week's posts for ${customerLabel(ctx)}`,
      instructions:
        `Three drafts are waiting in ${customerLabel(ctx)}'s FeedBoss workspace. Read them, edit anything that doesn't sound ` +
        "like them, and schedule them in FeedBoss. Mark this done when they're scheduled.\n\n" +
        (drafts.length ? drafts.map((d, i) => `Post ${i + 1}:\n${d.postContent}`).join("\n\n---\n\n") : briefs.posts.map((b, i) => `Post ${i + 1} brief: ${b}`).join("\n\n")),
    };
  },

  async linkn_content_plan(ctx) {
    const plan = await draftJson<{ title: string; body: string }>({
      system: `You plan LinkedIn content for Linkn clients. ${ctx.product.voice}`,
      prompt:
        `Client intake:\n${intakeSummary(ctx)}\n\nNotes from previous months:\n${ctx.customer.data.content_notes ?? "(none)"}\n\n` +
        "Plan next month's posts: three a week, grouped by week, each with a working title, the pillar it " +
        "belongs to, and a one-line angle. At least a third should answer objections the client's buyers raise.",
      schema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
        additionalProperties: false,
      },
    });
    return { type: "review", title: `Content plan: ${customerLabel(ctx)}: ${plan.title}`, body: plan.body, saveAs: "content_plan" };
  },

  async linkn_call_sheet() {
    requireAutomation("sblso");
    return { type: "done" };
  },

  async linkn_monthly_report(ctx) {
    // Figures from FeedBoss (posts published, reactions) and Sbl.so (outreach), where connected.
    if (!ctx.input && ctx.customer.data.feedboss_workspace && getIntegration("feedboss")?.configured()) {
      const since = Date.now() - 31 * 86_400_000;
      const published = (await recentPosts(ctx.customer.data.feedboss_workspace)).filter(
        (p) => p.status === "published" && new Date(p.createdAt).getTime() > since,
      );
      const reactions = published.reduce((n, p) => n + (p.metrics?.likes ?? 0), 0);
      const comments = published.reduce((n, p) => n + (p.metrics?.comments ?? 0), 0);
      const sbl = await query<{ event: string; n: number }>(
        `SELECT event, count(*)::int AS n FROM sbl_events WHERE customer_id = $1 AND received_at > now() - interval '31 days' GROUP BY event`,
        [ctx.customer.id],
      );
      const count = (e: string) => sbl.find((r) => r.event === e)?.n ?? 0;
      if (ctx.delivery) {
        await saveMetrics(ctx.customer.id, ctx.delivery.period, {
          posts_published: published.length,
          connection_requests: count("connection_request_sent"),
          replies: count("prospect_replied"),
        });
      }
      ctx = {
        ...ctx,
        input:
          `Posts published: ${published.length} (reactions ${reactions}, comments ${comments}).\n` +
          `Connection requests sent: ${count("connection_request_sent")}, accepted: ${count("connection_request_accepted")}, ` +
          `replies: ${count("prospect_replied")}.\n` +
          `Post titles:\n${published.map((p) => `- ${p.postContent.split("\n")[0]?.slice(0, 120)}`).join("\n")}`,
      };
    }
    if (!ctx.input) {
      return needData(
        ctx,
        "Last month's Linkn figures",
        "Paste last month's figures: posts published, impressions and engagement from FeedBoss; " +
          "connection requests, acceptances, replies and meetings from Sbl.so; and calls made (Growth).",
      );
    }
    const draft = await draftCustomerEmail(
      ctx,
      "Write the client's monthly Linkn report as an email: what was published, who was approached, " +
        "what happened, and the plan for next month. Honest numbers only; use only the figures given.",
      ctx.input,
    );
    return { type: "email", approval: true, ...draft };
  },

  // --------------------------------------------------------- Speed to Lead

  async stl_send_dpa(ctx) {
    return askClientToApprove(ctx, {
      title: "Please accept our data processing terms",
      body:
        "Because our assistant answers calls from your customers, the law asks us to agree how we look after their " +
        `details. The terms are short and plain. Call recordings are kept for ${ctx.customer.data.intake?.retention ?? "the period you chose"}.` +
        "\n\nPress Approve to accept them, or Ask for changes if you have questions.",
      link: "https://speedtolead.co.uk/dpa/",
    });
  },

  /** Linkn content themes: drafted from the client's answers, approved by the client in their account. */
  async linkn_pillars(ctx) {
    if (!ctx.customer.data.content_pillars) {
      const plan = await draftJson<{ pillars: { name: string; why: string; example: string }[] }>({
        system: `You plan LinkedIn content for Linkn clients. ${ctx.product.voice}`,
        prompt:
          `Client details:\n${intakeSummary(ctx)}\n\n${ctx.customer.data.call_notes ? `Kickoff call notes:\n${ctx.customer.data.call_notes}\n\n` : ""}` +
          "Propose three or four content themes (pillars) for their LinkedIn posts. For each: a short name, one sentence on why " +
          "it matters to their buyers, and one example post idea. Use only facts from the details.",
        schema: {
          type: "object",
          properties: {
            pillars: {
              type: "array",
              minItems: 3,
              maxItems: 4,
              items: {
                type: "object",
                properties: { name: { type: "string" }, why: { type: "string" }, example: { type: "string" } },
                required: ["name", "why", "example"],
                additionalProperties: false,
              },
            },
          },
          required: ["pillars"],
          additionalProperties: false,
        },
        maxTokens: 4000,
      });
      const text = plan.pillars.map((p, i) => `${i + 1}. ${p.name}\n   ${p.why}\n   For example: ${p.example}`).join("\n\n");
      await query(`UPDATE customers SET data = data || jsonb_build_object('content_pillars', $2::text, 'content_plan', $2::text) WHERE id = $1`, [ctx.customer.id, text]);
      ctx = { ...ctx, customer: { ...ctx.customer, data: { ...ctx.customer.data, content_pillars: text } } };
    }
    return askClientToApprove(ctx, {
      title: "Your LinkedIn content themes",
      body: `These are the themes your posts will cover:\n\n${ctx.customer.data.content_pillars}\n\nPress Approve and your first posts will be written in your voice. Or ask for changes.`,
    });
  },

  async stl_draft_script(ctx) {
    const script = await draftJson<{ body: string }>({
      system:
        "You write call scripts for an automated phone assistant that answers missed calls for UK trade " +
        "businesses. The assistant must say it is an automated assistant and that the call is recorded. " +
        "It takes name, postcode and job, checks the postcode against the service area, offers available " +
        "slots, and books one. Urgent calls are transferred to the owner's mobile. A smell of gas is always " +
        "directed to the National Gas Emergency number, 0800 111 999. Callers who ask for a person are " +
        "offered a call back. Only quote prices the owner listed.",
      prompt:
        `Business details from the owner:\n${intakeSummary(ctx)}\n\n` +
        "Write the full assistant script: greeting, information to collect, service-area rules, booking " +
        "rules, pricing answers, urgent-call rules, call-back handling, and closing.",
      schema: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
    });
    return { type: "review", title: `Call script: ${customerLabel(ctx)}`, body: script.body, saveAs: "script" };
  },

  async stl_provision_agent(ctx) {
    if (ctx.input) {
      const [agent, number] = ctx.input.split(/[,;\s]+/).filter(Boolean);
      await query(
        `UPDATE customers SET data = data || jsonb_build_object('awaz_agent_ids', $2::jsonb, 'forwarding_number', $3::text) WHERE id = $1`,
        [ctx.customer.id, JSON.stringify(agent ? [agent] : []), number ?? null],
      );
      return { type: "done", note: `Assistant ${agent ?? ""} on ${number ?? "(number not given)"}` };
    }
    return {
      type: "manual",
      title: `Set up the phone assistant for ${customerLabel(ctx)} in Awaz`,
      instructions: "Create the assistant in Awaz from the approved script, then type its id and phone number below.",
      inputLabel: "Assistant id, phone number (for example 6625bd4a8716, +441234567890)",
      rerun: true,
    };
  },


  async stl_forwarding_instructions(ctx) {
    const number = ctx.customer.data.forwarding_number;
    if (!number) {
      return {
        type: "manual",
        title: `Record the Awaz forwarding number for ${customerLabel(ctx)}`,
        instructions: "Enter the UK number the customer's missed calls should forward to.",
        inputLabel: "Forwarding number",
        saveAs: "forwarding_number",
        rerun: true,
      };
    }
    const provider = ctx.customer.data.intake?.phone_provider ?? "your phone provider";
    const draft = await draftCustomerEmail(
      ctx,
      `Explain how to forward calls to ${number} only when the line is busy or not answered, with ` +
        `${provider}. If you are not certain of that provider's exact steps, say to ask them for ` +
        `"conditional call forwarding on busy and no answer" to ${number}. Say we'll then make test calls ` +
        "together before going live.",
    );
    return { type: "email", approval: false, ...draft };
  },

  async stl_call_review() {
    requireAutomation("awaz");
    return { type: "done" };
  },

  async stl_usage_summary(ctx) {
    if (!ctx.input) {
      return needData(
        ctx,
        "Last month's call figures",
        "From Awaz, paste last month's calls answered, jobs booked, urgent transfers and call backs requested.",
      );
    }
    const plan = getPlan(ctx.product, ctx.customer.plan);
    const draft = await draftCustomerEmail(
      ctx,
      `Write a short monthly summary email of calls handled for them. Their plan (${plan?.name}) includes ` +
        `${plan?.id === "team" ? 300 : 150} calls a month; mention usage against that only if the figures show it.`,
      ctx.input,
    );
    return { type: "email", approval: false, ...draft };
  },

  // ------------------------------------------------------------ EmailFirst

  async ef_draft_copy(ctx) {
    const draft = await draftCustomerEmail(
      ctx,
      "Write the client three cold emails for UK B2B decision makers (each under 150 words, one clear call " +
        "to action, no hype) and the copy for a one-page landing page (headline, three short sections, call " +
        "to action). Put them in an email to the client asking them to approve or reply with changes.",
    );
    return { type: "email", approval: true, ...draft };
  },

  async ef_customer_copy_approval(ctx) {
    const copy = (
      await query(`SELECT body_text FROM emails WHERE customer_id = $1 AND kind = 'onboarding:copy' AND status = 'sent' ORDER BY created_at DESC LIMIT 1`, [ctx.customer.id])
    )[0]?.body_text;
    return askClientToApprove(ctx, {
      title: "Your emails and landing page are ready to approve",
      body: `${copy ?? "We've emailed you your three emails and landing page copy."}\n\nIf you're happy, press Approve and we'll set up sending. If not, press Ask for changes and tell us what to change.`,
    });
  },

  async ef_provision_sending(ctx) {
    requireAutomation("mailwizz");
    if (ctx.input) return { type: "done", note: "Campaigns recorded" };
    return {
      type: "manual",
      title: `Set up sending for ${customerLabel(ctx)} in Mailpulse`,
      instructions:
        "Create their list, template and campaigns in Mailpulse using the approved copy, then paste the campaign " +
        "IDs below (separated by commas). From then on their weekly results are collected and sent automatically.",
      inputLabel: "Campaign IDs (for example ab12cd34ef56, xy98wv76ut54)",
      saveAs: "mailwizz_campaigns",
      rerun: true,
    };
  },

  /** Weekly results from Mailpulse: this week's figures are the change in each campaign's running totals. */
  async ef_weekly_summary(ctx) {
    const uids = String(ctx.customer.data.mailwizz_campaigns ?? "").split(/[\s,]+/).filter(Boolean);
    if (!ctx.input && uids.length) {
      requireAutomation("mailwizz");
      const totals = { sent: 0, opens: 0, clicks: 0 };
      for (const uid of uids) {
        const s = await campaignStats(uid);
        totals.sent += s.sent;
        totals.opens += s.opens;
        totals.clicks += s.clicks;
      }
      const last = (await previousDelivery(ctx))?.totals ?? { sent: 0, opens: 0, clicks: 0 };
      const week = {
        sent: Math.max(0, totals.sent - last.sent),
        clicks: Math.max(0, totals.clicks - last.clicks),
        opens: Math.max(0, totals.opens - last.opens),
      };
      if (ctx.delivery) {
        await query(`UPDATE deliveries SET content = content || $2::jsonb WHERE id = $1`, [ctx.delivery.id, JSON.stringify({ totals, week })]);
        await saveMetrics(ctx.customer.id, ctx.delivery.period, { emails_sent: week.sent, human_clicks: week.clicks });
      }
      const draft = await draftCustomerEmail(
        ctx,
        "Write a short weekly results summary email. Use only the figures given. Clicks are people who clicked through to the landing page.",
        `This week: ${week.sent} emails delivered, ${week.opens} people opened, ${week.clicks} people clicked.`,
      );
      return { type: "email", approval: false, ...draft };
    }
    if (!ctx.input) {
      return needData(
        ctx,
        "This week's sending figures",
        "Paste this week's sends, verified human clicks and replies for the client from Mailpulse.",
      );
    }
    const draft = await draftCustomerEmail(ctx, "Write a short weekly results summary email. Use only the figures given.", ctx.input);
    return { type: "email", approval: false, ...draft };
  },

  // ------------------------------------------------ Online Business Builder

  /**
   * Claude writes the client's website from their onboarding answers and call
   * notes, it's published to Netlify, and the client gets a preview to approve
   * in their account. Requested changes come back here as notes and it rebuilds.
   */
  async obb_build_site(ctx) {
    requireAutomation("netlify");
    if (!ctx.customer.data.intake_completed_at) return { type: "waiting", note: "Waiting for the onboarding form" };
    const intake = ctx.customer.data.intake ?? {};
    const changes: string[] = ctx.customer.data.site_changes ?? [];
    const site = await draftJson<{ html: string; summary: string }>({
      system:
        "You build fast, accessible, single-page websites for UK local businesses. Output one complete HTML " +
        "document with all CSS inline in a <style> tag and no external scripts. Requirements: mobile-first and " +
        "responsive; semantic HTML; WCAG AA contrast; a clear call-to-action to phone (tel: link) near the top and " +
        "again at the end; sections for services, the area served, opening hours if given, and contact; a " +
        "LocalBusiness JSON-LD block using only the facts given; a <title> and meta description written for local " +
        "search (business type + town); system font stack or one Google Font. Use the brand colours or notes if " +
        "given, otherwise a calm palette suited to the trade. British English. Never invent reviews, prices, awards, " +
        "years in business, qualifications or anything not in the details. No placeholder text and no lorem ipsum: " +
        "if a detail is missing, leave that section out.",
      prompt:
        `Business details:\n${intakeSummary(ctx)}\n\n` +
        (ctx.customer.data.call_notes ? `Notes from the onboarding call:\n${ctx.customer.data.call_notes}\n\n` : "") +
        (changes.length ? `The client asked for these changes to the last version (apply all of them):\n${changes.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
        "Write the website. In `summary`, say in one or two plain sentences what the page contains.",
      schema: {
        type: "object",
        properties: { html: { type: "string" }, summary: { type: "string" } },
        required: ["html", "summary"],
        additionalProperties: false,
      },
      maxTokens: 32000,
    });
    if (!/^\s*<!doctype html>/i.test(site.html) || site.html.length < 1500) throw new Error("The generated page doesn't look like a complete website");

    let siteId: string | undefined = ctx.customer.data.netlify_site_id;
    let host: string | undefined = ctx.customer.data.netlify_host;
    if (!siteId) {
      const slug = (ctx.customer.business || intake.business || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const created = await createSite(`obb-${slug}-${Math.random().toString(36).slice(2, 6)}`);
      siteId = created.id;
      host = `${created.name}.netlify.app`;
    }
    await deployFiles(siteId, {
      "/index.html": site.html,
      "/robots.txt": "User-agent: *\nAllow: /\n",
    });
    const version = (ctx.customer.data.site_version ?? 0) + 1;
    await query(
      `UPDATE customers SET data = data || jsonb_build_object('netlify_site_id', $2::text, 'netlify_host', $3::text,
         'site_version', $4::int, 'site_summary', $5::text, 'site_changes', '[]'::jsonb), updated_at = now() WHERE id = $1`,
      [ctx.customer.id, siteId, host, version, site.summary],
    );
    await postUpdate(ctx.customer, {
      title: version === 1 ? "Your website is ready to look at" : `Your updated website (version ${version})`,
      body:
        `${site.summary}\n\nHave a look on your phone and computer. If you're happy, press Approve and we'll ` +
        "connect your web address and put it live. If you'd like anything changed, press Ask for changes and tell us what, in your own words.",
      link: `https://${host}`,
      approvalStep: "design_approved",
    });
    return { type: "done", note: `Version ${version} published to ${host}` };
  },

  async obb_call_notes(ctx) {
    return {
      type: "manual",
      title: `Onboarding call with ${customerLabel(ctx)}`,
      instructions:
        "Hold the onboarding call: confirm their services, area and the look they want, and how we'll get access to " +
        "their Google Business Profile. Then type your notes below. They're used to write the website, which is " +
        "built and sent to the client as soon as you save.",
      inputLabel: "Notes from the call (what they want on the site, colours, anything to avoid)",
      saveAs: "call_notes",
    };
  },

  async await_client_approval() {
    // Completed when the client presses Approve in their account (engine/clients.ts).
    return { type: "waiting", note: "Waiting for the client to approve the website" };
  },

  /**
   * Connect a web address. If it's in our GoDaddy account it's pointed at the
   * site automatically; a client's own domain gets simple instructions. With no
   * domain yet, available names are checked and Felix decides whether to buy.
   */
  async obb_domain(ctx) {
    requireAutomation("netlify");
    const siteId: string | undefined = ctx.customer.data.netlify_site_id;
    const host: string | undefined = ctx.customer.data.netlify_host;
    if (!siteId || !host) throw new Error("The website hasn't been built yet");
    const raw = (ctx.input || ctx.customer.data.domain || ctx.customer.data.intake?.website || "").trim().toLowerCase();
    const domain = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

    if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      requireAutomation("godaddy");
      const ideas = domainIdeas(ctx.customer.business || ctx.customer.data.intake?.business || "", ctx.customer.data.intake?.area);
      const checked = [];
      for (const d of ideas) {
        try {
          checked.push(await checkAvailable(d));
        } catch {
          // skip names GoDaddy can't check
        }
      }
      const free = checked.filter((c) => c.available);
      return {
        type: "manual",
        title: `Choose a web address for ${customerLabel(ctx)}`,
        instructions:
          "They don't have a web address yet. Nothing is bought automatically.\n\n" +
          (free.length
            ? `Free right now:\n${free.map((f) => `- ${f.domain}${f.price ? ` (about £${f.price.toFixed(2)} a year)` : ""}`).join("\n")}\n\n`
            : "None of the obvious names are free; pick another.\n\n") +
          "Buy the one you want in GoDaddy (https://www.godaddy.com/domains), then type it below. " +
          "It's then connected to their website automatically.",
        inputLabel: "Web address you bought (for example ownerplumbing.co.uk)",
        saveAs: "domain",
        rerun: true,
      };
    }

    await setCustomDomain(siteId, domain);
    if (await inOurAccount(domain).catch(() => false)) {
      await pointAtNetlify(domain, host);
      await query(`UPDATE customers SET data = data || jsonb_build_object('domain', $2::text, 'domain_connected', true) WHERE id = $1`, [ctx.customer.id, domain]);
      return { type: "done", note: `${domain} pointed at the website` };
    }
    await query(`UPDATE customers SET data = data || jsonb_build_object('domain', $2::text) WHERE id = $1`, [ctx.customer.id, domain]);
    return {
      type: "email",
      approval: false,
      subject: `One small step to put your website on ${domain}`,
      body:
        `Hello ${firstName(ctx)},\n\nYour website is approved and ready. To show it at ${domain}, whoever looks after ` +
        `your web address (often the company you bought it from) needs to change two settings:\n\n` +
        `1. An "A" record for ${domain} pointing to ${NETLIFY_IP}\n` +
        `2. A "CNAME" record for www pointing to ${host}\n\n` +
        `If you forward this email to them, they'll know exactly what to do. Your email keeps working as it is. ` +
        `Once it's done the site appears within an hour or so, with the padlock (https) added automatically.\n\n` +
        `If you'd rather we did it, reply and we'll talk you through it.\n\nFelix`,
    };
  },

  /**
   * Connect the client's Google Business Profile in Local Falcon, then set up the monthly ranking
   * scans and profile monitoring. The client adds Felix as a manager (they're emailed how); Felix
   * accepts and imports it in Local Falcon (the one click Google needs a person for); this step
   * finds it by itself and carries on.
   */
  async obb_gbp_connect(ctx) {
    requireAutomation("localfalcon");
    const intake = ctx.customer.data.intake ?? {};
    const manager = process.env.GBP_MANAGER_EMAIL?.trim() || config.admin.alertEmail;
    let placeId: string | undefined = ctx.customer.data.gbp_place_id;
    if (!placeId) {
      const names = [intake.gbp_name, intake.business, ctx.customer.business].filter(Boolean).map((x: string) => x.toLowerCase());
      const found = (await linkedLocations()).find((l) => names.some((nm) => l.name.toLowerCase().includes(nm) || nm.includes(l.name.toLowerCase())));
      if (found) {
        placeId = found.place_id;
        await query(`UPDATE customers SET data = data || jsonb_build_object('gbp_place_id', $2::text, 'gbp_location_name', $3::text) WHERE id = $1`, [ctx.customer.id, placeId, found.name]);
      }
    }
    if (!placeId) {
      if (!ctx.customer.data.gbp_invite_sent) {
        await queueEmail({
          product: ctx.product.slug,
          customerId: ctx.customer.id,
          kind: "gbp_invite",
          to: ctx.customer.email,
          subject: "One quick thing: access to your Google Business Profile",
          body:
            `Hello ${firstName(ctx)},\n\nSo we can look after your Google profile (weekly posts, answering reviews and your monthly ` +
            `report), please add us as a manager. It takes about two minutes:\n\n` +
            `1. Go to business.google.com and sign in.\n2. Open your profile and choose "Business Profile settings", then "Managers".\n` +
            `3. Choose "Add" and enter ${manager}, with the role Manager.\n4. Choose "Invite".\n\n` +
            `If you don't have a Google Business Profile yet, just reply and we'll set one up for you.\n\nThank you,\nFelix`,
        });
        await query(`UPDATE customers SET data = data || '{"gbp_invite_sent": true}'::jsonb WHERE id = $1`, [ctx.customer.id]);
      }
      return {
        type: "manual",
        title: `Connect ${customerLabel(ctx)}'s Google profile in Local Falcon`,
        instructions: `The client has been emailed how to add ${manager} as a manager on their Google Business Profile.`,
        rerun: true,
        guide: {
          why: "Google needs a person to accept a manager invite; Local Falcon can't do that step for us.",
          minutes: 3,
          steps: [
            `Accept the Google email inviting ${manager} to manage "${intake.gbp_name || customerLabel(ctx)}".`,
            "In Local Falcon, open Saved Locations and choose Import From Google Account.",
            "Press Done below. HQ finds the profile and sets up scans, monitoring and weekly posts by itself.",
          ],
        },
      };
    }
    if (!ctx.customer.data.lf_campaign_key) {
      const area = intake.area || "";
      const type = intake.business_type || ctx.customer.business || "";
      const keywords = [`${type} ${area}`.trim(), `${type} near me`.trim(), `best ${type} ${area}`.trim()];
      const key = await createMonthlyCampaign({ name: `OBB ${customerLabel(ctx)}`, placeId, keywords, start: new Date(Date.now() + 864e5) });
      await addGuard(placeId).catch(() => undefined);
      await query(`UPDATE customers SET data = data || jsonb_build_object('lf_campaign_key', $2::text, 'lf_keywords', $3::jsonb) WHERE id = $1`, [ctx.customer.id, key, JSON.stringify(keywords)]);
    }
    return { type: "done", note: "Google profile connected; monthly scans and monitoring set up" };
  },

  async obb_weekly_post(ctx) {
    const last = await previousDelivery(ctx);
    const post = await draftJson<{ body: string }>({
      system:
        `You write Google Business Profile posts for local businesses. ${ctx.product.voice} ` +
        "Under 120 words, one clear call to action (call, book or visit). No prices, offers or claims that " +
        "aren't in the business details.",
      prompt:
        `Business details:\n${intakeSummary(ctx)}\n\nLast week's post (don't repeat its angle):\n${last?.body ?? last?.post ?? "(none)"}\n\n` +
        "Write this week's post.",
      schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
      maxTokens: 4000,
    });
    if (!ctx.customer.data.gbp_place_id || !getIntegration("localfalcon")?.configured()) {
      return {
        type: "manual",
        title: `Publish this week's Google post for ${customerLabel(ctx)}`,
        instructions: `Their Google profile isn't connected to Local Falcon yet. Publish this on their Google Business Profile:\n\n${post.body}`,
      };
    }
    const d = ctx.customer.data;
    const site: string | undefined = d.domain_connected && d.domain ? `https://${d.domain}` : d.netlify_host ? `https://${d.netlify_host}` : undefined;
    return {
      type: "publish",
      title: `This week's Google post for ${customerLabel(ctx)}`,
      body: post.body,
      publisher: "gbp_post",
      data: { body: post.body, link: site },
      approval: true,
    };
  },

  async obb_reviews(ctx) {
    requireAutomation("localfalcon");
    const placeId: string | undefined = ctx.customer.data.gbp_place_id;
    if (!placeId) return { type: "done", note: "Google profile not connected yet" };
    const reviews = await unansweredReviews(placeId);
    if (!reviews.length) return { type: "done", note: "No new reviews to answer" };
    const drafted = await draftJson<{ replies: { n: number; reply: string }[] }>({
      system:
        `You reply to Google reviews on behalf of a local business. ${ctx.product.voice} Thank the person by first name, ` +
        "keep it to two or three short sentences, mention something specific they said, never argue or admit liability, " +
        "and for a poor review apologise, and invite them to get in touch directly.",
      prompt:
        `Business details:\n${intakeSummary(ctx)}\n\nReviews:\n` +
        reviews.map((r, i) => `#${i + 1} (${r.rating} stars, ${r.author}): ${r.text || "(no text)"}`).join("\n"),
      schema: {
        type: "object",
        properties: { replies: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, reply: { type: "string" } }, required: ["n", "reply"], additionalProperties: false } } },
        required: ["replies"],
        additionalProperties: false,
      },
      maxTokens: 4000,
    });
    const replies = reviews.map((r, i) => ({ reviewId: r.id, reply: drafted.replies.find((x) => x.n === i + 1)?.reply ?? "" }));
    const body = reviews
      .map((r, i) => `Review #${i + 1} (${r.rating} stars, ${r.author}): ${r.text || "(no text)"}\nReply #${i + 1}:\n${replies[i]!.reply}`)
      .join("\n\n");
    return {
      type: "publish",
      title: `Replies to ${reviews.length} Google review${reviews.length === 1 ? "" : "s"} for ${customerLabel(ctx)}`,
      body,
      publisher: "gbp_review_replies",
      data: { replies },
      approval: true,
    };
  },

  async obb_monthly_report(ctx) {
    const placeId: string | undefined = ctx.customer.data.gbp_place_id;
    let figures = ctx.input ?? "";
    if (!figures && placeId && getIntegration("localfalcon")?.configured()) {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 864e5);
      const metrics = await profileMetrics(placeId, start, end).catch(() => ({} as Record<string, number>));
      const ranking = ctx.customer.data.lf_campaign_key ? await campaignSummary(ctx.customer.data.lf_campaign_key).catch(() => ({} as Record<string, any>)) : {};
      const period = end.toISOString().slice(0, 7);
      await saveMetrics(ctx.customer.id, period, { ...metrics });
      const kw: string[] = ctx.customer.data.lf_keywords ?? [];
      figures =
        `Last 30 days from Google: ${metrics.profile_views ?? "?"} profile views, ${metrics.calls ?? "?"} calls, ` +
        `${metrics.website_clicks ?? "?"} website clicks, ${metrics.direction_requests ?? "?"} direction requests.\n` +
        (ranking.averagePosition !== undefined
          ? `Google Maps ranking scan (searches: ${kw.join(", ")}): average position ${ranking.averagePosition}` +
            `${ranking.positionChange !== undefined ? ` (change ${ranking.positionChange})` : ""}, shows in ${ranking.shareOfVoice ?? "?"}% of the area` +
            `${ranking.shareChange !== undefined ? ` (change ${ranking.shareChange})` : ""}.\n`
          : "") +
        (ranking.reportUrl ? `Full ranking map: ${ranking.reportUrl}\n` : "");
    }
    if (!figures) {
      return needData(
        ctx,
        "This month's ranking figures",
        "Their Google profile isn't connected to Local Falcon yet, so paste this month's figures: Maps positions, profile views, calls, direction requests, website visits and new reviews.",
      );
    }
    const last = await previousDelivery(ctx);
    const draft = await draftCustomerEmail(
      ctx,
      "Write this month's progress report as an email: how they're showing on Google and Maps, what we did " +
        "(posts, reviews answered, site updates), what changed since last month, and what's next. Use only the figures given. " +
        "If a ranking map link is given, include it.",
      `This month:\n${figures}\n\nLast month's report:\n${last?.body ?? "(none)"}`,
    );
    return { type: "email", approval: false, ...draft };
  },

  /** Falcon Guard watches the profile; any change someone else made comes to Felix. */
  async obb_profile_check(ctx) {
    requireAutomation("localfalcon");
    const placeId: string | undefined = ctx.customer.data.gbp_place_id;
    if (!placeId) return { type: "done", note: "Google profile not connected yet" };
    const changes = await guardChanges(placeId);
    const seen: string[] = ctx.customer.data.gbp_changes_seen ?? [];
    const fresh = changes.filter((c) => !seen.includes(c));
    if (!fresh.length) return { type: "done", note: "No changes to their Google profile" };
    await query(`UPDATE customers SET data = data || jsonb_build_object('gbp_changes_seen', $2::jsonb) WHERE id = $1`, [ctx.customer.id, JSON.stringify([...seen, ...fresh].slice(-50))]);
    return {
      type: "manual",
      title: `${customerLabel(ctx)}'s Google profile was changed`,
      instructions: `Local Falcon spotted these changes to their Google Business Profile:\n\n${fresh.map((c) => `- ${c}`).join("\n")}\n\nIf anything looks wrong (for example a changed phone number or opening hours), check with the client.`,
    };
  },

  // -------------------------------------------------------- Good Questions

  async gq_build_scorecard() {
    requireAutomation("scoreapp");
    return { type: "done" };
  },

  async gq_findings(ctx) {
    if (!ctx.input) {
      return needData(
        ctx,
        "This week's responses",
        "Export this week's responses from ScoreApp and paste the summary (completions, average scores by area, notable answers).",
      );
    }
    const draft = await draftCustomerEmail(
      ctx,
      "Write a weekly findings update for the research sponsor: completions so far, what the answers show, " +
        "and anything worth watching. Use only the data given.",
      ctx.input,
    );
    return { type: "email", approval: true, ...draft };
  },
};

export function getHandler(name: string): Handler {
  const handler = handlers[name];
  if (!handler) throw new Error(`No handler named ${name}`);
  return handler;
}

export function handlerNames(): string[] {
  return Object.keys(handlers);
}

