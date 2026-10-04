import { config } from "../config.js";
import { getIntegration } from "../integrations/index.js";
import { draftJson, emailSchema, type EmailDraft } from "../lib/claude.js";
import { bookingLink, getPlan } from "../products/index.js";
import { NotConfiguredError } from "../lib/util.js";
import { query } from "../db/index.js";
import { checkAvailable, domainIdeas, inOurAccount, NETLIFY_IP, pointAtNetlify } from "../integrations/godaddy.js";
import { addSubscribers, campaignClickers, campaignStats, createCampaign, createList, createTemplate, ensureFields, unsubscribed, type Contact, type Sender } from "../integrations/mailwizz.js";
import { createLandingPage, landingPageHtml, mailwizzSession, publishLandingPage, setLandingContent } from "../integrations/mailwizz-pages.js";
import { countMatches, pickProspects, type AudienceFilter } from "./prospectdb.js";
import { suppress } from "./outreach.js";
import { emailOperator } from "../lib/email.js";
import { addGuard, campaignSummary, createMonthlyCampaign, guardChanges, linkedLocations, profileMetrics, unansweredReviews } from "../integrations/localfalcon.js";
import { queueEmail } from "../lib/email.js";
import { createSurvey, surveyFindings, surveySchema, surveyText, type Survey } from "./surveys.js";
import { listAgents, placeCall, subscribeCalls } from "../integrations/awaz.js";
import { campaignUsers, draftCampaign, field, getCampaign, linkedinChannels, previewEngagers, waitingLeads } from "../integrations/sbl.js";
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
function coldBrief(ctx: HandlerContext): string {
  const i = ctx.customer.data.intake ?? {};
  return (
    `LinkedIn outreach from ${ctx.customer.name} (${i.company ?? customerLabel(ctx)}), written in their voice: first person, warm, ` +
    `short, plain British English, no hype, no pitch in the connection request.\n\nWhat they sell and their proof: ${i.offer ?? ""}\n\n` +
    `Who to reach: ${i.icp ?? ""}\nNever approach: ${i.exclusions ?? "(none)"}\nNever say: ${i.never_say ?? "(nothing)"}\n` +
    `Price questions: ${i.price_questions ?? "suggest a call"}\nGoal: a short call${i.booking_link ? ` via ${i.booking_link}` : ""}.\n\n` +
    `Notes from the kickoff call: ${ctx.customer.data.call_notes ?? "(none)"}\nContent themes: ${ctx.customer.data.content_plan ?? ctx.customer.data.pillars ?? "(none)"}`
  ).slice(0, 19000);
}

function warmBrief(ctx: HandlerContext): string {
  return (
    `${coldBrief(ctx)}\n\nThis campaign goes to people who recently liked or commented on ${ctx.customer.name}'s LinkedIn posts. ` +
    "Never mention the post or that they engaged with it: start a natural conversation relevant to their role."
  ).slice(0, 19000);
}

interface EfCopy {
  emails: { subject: string; body: string }[];
  landing: string;
}

interface EfDay {
  date: string;
  list?: string;
  count: number;
  campaigns: string[];
}

function efCopyText(c: EfCopy): string {
  return `${c.emails.map((e, i) => `Email ${i + 1}\nSubject: ${e.subject}\n\n${e.body}`).join("\n\n---\n\n")}\n\n---\n\nLanding page\n\n${c.landing}`;
}

/** Our {FNAME}/{COMPANY} placeholders as MailWizz tags, and {LINK} as the client's landing page. */
export function mergeTags(text: string, link?: string): string {
  let out = text.replace(/\{FNAME\}/g, "[FNAME]").replace(/\{COMPANY\}/g, "[COMPANY]");
  if (link) out = /\{LINK\}/.test(out) ? out.replace(/\{LINK\}/g, link) : `${out.trimEnd()}\n\n${link}`;
  return out.replace(/\{LINK\}/g, "");
}

/** The client's brand colour, if their website declares one (theme-color, or the most used colour in its CSS). */
async function siteColour(website: string | undefined): Promise<string | undefined> {
  if (!website) return undefined;
  try {
    const url = /^https?:/.test(website) ? website : `https://${website}`;
    const html = await (await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0" } })).text();
    const theme = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{6})["']/i.exec(html)?.[1];
    if (theme) return theme;
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/#([0-9a-f]{6})\b/gi)) {
      const hex = m[1]!.toLowerCase();
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const max = Math.max(r!, g!, b!), min = Math.min(r!, g!, b!);
      if (max - min < 40 || max < 60 || min > 200) continue; // skip greys, near-black and pastels
      counts.set(`#${hex}`, (counts.get(`#${hex}`) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  } catch {
    return undefined;
  }
}

/** A plain-English audience as search filters on our prospect database. */
async function audienceFilters(audience: string, about: string): Promise<AudienceFilter> {
  return draftJson<AudienceFilter>({
    system:
      "You turn a description of who should be emailed into search filters for a UK B2B contact database. " +
      "titles: short words that appear in matching job titles (e.g. 'director', 'owner', 'head of marketing'). " +
      "sectors: short industry words; empty if any sector. regions: UK places; empty if anywhere in the UK. " +
      "exclude: words that rule people out (competitors, existing clients, unsuitable roles). Keep each list short.",
    prompt: `Who to email: ${audience}\nContext: ${about}`,
    schema: {
      type: "object",
      properties: { titles: { type: "array", items: { type: "string" } }, sectors: { type: "array", items: { type: "string" } }, regions: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } } },
      required: ["titles", "sectors", "regions", "exclude"],
      additionalProperties: false,
    },
    maxTokens: 1500,
  });
}

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

  /** New LinkedIn replies waiting for a person: AI drafts each answer in the client's voice; approving sends them. */
  async linkn_reply_triage(ctx) {
    requireAutomation("sblso");
    const campaigns: string[] = ctx.customer.data.sbl_campaign_ids ?? [];
    if (!campaigns.length) return { type: "done", note: "No campaigns yet" };
    const leads = await waitingLeads(campaigns);
    if (!leads.length) return { type: "done", note: "No replies waiting" };
    const intake = ctx.customer.data.intake ?? {};
    const drafted = await draftJson<{ replies: { n: number; reply: string }[] }>({
      system:
        `You reply to LinkedIn messages as ${ctx.customer.name ?? "the client"} of ${intake.company ?? customerLabel(ctx)}. ` +
        "Write in their voice: first person, warm, brief (under 80 words), plain British English, no hype. Answer what they asked, " +
        "and if they're interested, suggest a short call" + (intake.booking_link ? ` using ${intake.booking_link}` : "") + ". " +
        `Price questions: ${intake.price_questions || "say it depends on what they need and suggest a call"}. ` +
        `Never say: ${intake.never_say || "(nothing listed)"}. If they ask not to be contacted, reply politely that you won't message again. ` +
        "Never invent facts.",
      prompt:
        `What they sell: ${intake.offer ?? ""}\n\n` +
        leads.map((l, i) => `Conversation #${i + 1} with ${l.name}:\n${l.thread}`).join("\n\n") +
        "\n\nDraft one reply for each conversation.",
      schema: {
        type: "object",
        properties: { replies: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, reply: { type: "string" } }, required: ["n", "reply"], additionalProperties: false } } },
        required: ["replies"],
        additionalProperties: false,
      },
      maxTokens: 6000,
    });
    const replies = leads.map((l, i) => ({ campaignId: l.campaignId, userId: l.userId, reply: drafted.replies.find((x) => x.n === i + 1)?.reply ?? "" }));
    return {
      type: "publish",
      title: `LinkedIn replies for ${customerLabel(ctx)} (${leads.length})`,
      body: leads.map((l, i) => `Conversation #${i + 1} with ${l.name}:\n${l.thread.slice(-1500)}\nReply #${i + 1}:\n${replies[i]!.reply}`).join("\n\n"),
      publisher: "sbl_replies",
      data: { replies },
      approval: true,
    };
  },

  /**
   * People who engaged with the client's recent posts: a free preview from Sbl.so, scored against
   * their ideal customer by AI. If enough fit, approving imports them and starts this week's warm campaign.
   */
  async linkn_weekly_harvest(ctx) {
    requireAutomation("sblso");
    const d = ctx.customer.data;
    if (!d.feedboss_workspace || !d.sbl_channel_id || !getIntegration("feedboss")?.configured()) return { type: "done", note: "FeedBoss or LinkedIn sender not connected yet" };
    const twoDays = Date.now() - 2 * 864e5;
    const posts = (await recentPosts(d.feedboss_workspace))
      .filter((p) => p.status === "published" && p.postUrl && new Date(p.createdAt).getTime() < twoDays && new Date(p.createdAt).getTime() > Date.now() - 14 * 864e5)
      .filter((p) => (p.metrics?.likes ?? 0) + (p.metrics?.comments ?? 0) > 0)
      .slice(0, 3);
    if (!posts.length) return { type: "done", note: "No recent posts with engagement" };
    const week = ctx.delivery?.period ?? new Date().toISOString().slice(0, 10);
    const intake = d.intake ?? {};
    const campaignId = await draftCampaign(warmBrief(ctx), `lnk-${ctx.customer.id}-warm-${week}`, Number(d.sbl_channel_id));
    const previews: { previewId: string; people: string }[] = [];
    for (const [i, post] of posts.entries()) {
      for (const mode of ["comments", "likes"] as const) {
        const pv = await previewEngagers(campaignId, post.postUrl!, mode, `lnk-${ctx.customer.id}-${week}-${i}-${mode}`).catch(() => undefined);
        if (pv?.previewId) previews.push(pv);
      }
    }
    if (!previews.length) return { type: "done", note: "No engagers found" };
    const scored = await draftJson<{ fit: number; total: number; summary: string }>({
      system: "You score LinkedIn engagers against a client's ideal customer. Count only clear fits. Never invent people.",
      prompt: `Ideal customer: ${intake.icp ?? ""}\nNever approach: ${intake.exclusions ?? "(none)"}\n\nEngagers:\n${previews.map((p) => p.people).join("\n")}`,
      schema: { type: "object", properties: { fit: { type: "integer" }, total: { type: "integer" }, summary: { type: "string" } }, required: ["fit", "total", "summary"], additionalProperties: false },
      maxTokens: 3000,
    });
    if (scored.fit < 5 || scored.fit < scored.total / 3) return { type: "done", note: `Only ${scored.fit} of ${scored.total} engagers fit; not imported` };
    return {
      type: "publish",
      title: `Warm outreach to ${scored.fit} people who engaged with ${customerLabel(ctx)}'s posts`,
      body: `${scored.summary}\n\nApproving imports them into this week's warm campaign and starts it from ${customerLabel(ctx)}'s LinkedIn. Messages never mention the post.`,
      publisher: "sbl_harvest",
      data: { campaignId, previewIds: previews.map((p) => p.previewId) },
      approval: true,
    };
  },

  /** Draft the cold and warm Sbl.so campaigns from the client's answers, bound to their own LinkedIn sender. */
  async linkn_campaigns(ctx) {
    requireAutomation("sblso");
    let channel: number | undefined = ctx.customer.data.sbl_channel_id;
    if (!channel) {
      const name = (ctx.customer.name ?? "").toLowerCase();
      const found = name ? (await linkedinChannels()).find((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase())) : undefined;
      if (!found) {
        return {
          type: "manual",
          title: `Connect ${customerLabel(ctx)}'s LinkedIn in Sbl.so`,
          instructions: `No LinkedIn sender called "${ctx.customer.name}" is connected in Sbl.so yet.`,
          rerun: true,
          guide: {
            why: "Only the client can sign in to their own LinkedIn.",
            minutes: 5,
            steps: [
              "Ask the client to connect their LinkedIn as a sender in Sbl.so (Settings, Communication), ideally on the kickoff call.",
              "Press Done below. HQ finds their sender and drafts both campaigns by itself.",
            ],
          },
        };
      }
      channel = found.id;
      await query(`UPDATE customers SET data = data || jsonb_build_object('sbl_channel_id', $2::int) WHERE id = $1`, [ctx.customer.id, channel]);
    }
    const ym = new Date().toISOString().slice(0, 7);
    const cold = await draftCampaign(coldBrief(ctx), `lnk-${ctx.customer.id}-cold-${ym}`, channel);
    const warm = await draftCampaign(warmBrief(ctx), `lnk-${ctx.customer.id}-warm-start`, channel);
    await query(`UPDATE customers SET data = data || jsonb_build_object('sbl_campaign_ids', $2::jsonb, 'sbl_cold_id', $3::text, 'sbl_warm_id', $4::text) WHERE id = $1`, [
      ctx.customer.id,
      JSON.stringify([cold, warm]),
      cold,
      warm,
    ]);
    return { type: "done", note: `Campaigns drafted in Sbl.so (cold ${cold}, warm ${warm})` };
  },

  /** Launch: Felix's approval finds 25 matching leads (billable) and starts the cold campaign. */
  async linkn_launch(ctx) {
    requireAutomation("sblso");
    const cold: string | undefined = ctx.customer.data.sbl_cold_id;
    if (!cold) return { type: "done", note: "No cold campaign to launch" };
    const c = await getCampaign(cold);
    const first = String(field(c, "initialMessage", "initial_message") ?? "(see the campaign in Sbl.so)");
    let published = "";
    if (ctx.customer.data.feedboss_workspace && getIntegration("feedboss")?.configured()) {
      const live = (await recentPosts(ctx.customer.data.feedboss_workspace)).filter((p) => p.status === "published").length;
      published = `\n\nPosts live on their LinkedIn: ${live}${live < 4 ? " (we usually wait for four before starting outreach)" : ""}.`;
    }
    return {
      type: "publish",
      title: `Start LinkedIn outreach for ${customerLabel(ctx)}`,
      body:
        `Opening message:\n${first}\n\nWho it goes to: ${ctx.customer.data.intake?.icp ?? ""}${published}\n\n` +
        "Approving finds the first 25 people who match (this uses Sbl.so lead credits) and starts the campaign from their LinkedIn.",
      publisher: "sbl_launch",
      data: { cold, prompt: ctx.customer.data.intake?.icp ?? "", key: `lnk-${ctx.customer.id}-launch-${new Date().toISOString().slice(0, 7)}` },
      approval: true,
    };
  },

  async linkn_call_guide(ctx) {
    const guide = await draftJson<{ body: string }>({
      system: `You write telephone call guides in the client's voice. ${ctx.product.voice}`,
      prompt:
        `Client answers:\n${intakeSummary(ctx)}\n\nKickoff notes:\n${ctx.customer.data.call_notes ?? "(none)"}\n\n` +
        "Write a one-page call guide for following up LinkedIn conversations by phone: who we are, why we're calling, " +
        "three good questions, handling 'not interested' and price questions, and how to book a meeting. Remind the caller " +
        "to check every number against TPS/CTPS before calling.",
      schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
      maxTokens: 4000,
    });
    return { type: "review", title: `Call guide for ${customerLabel(ctx)}`, body: guide.body, saveAs: "call_guide" };
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

  /** The month's call list: people who replied or are mid-conversation, for the calling team. */
  async linkn_call_sheet(ctx) {
    requireAutomation("sblso");
    const campaigns: string[] = ctx.customer.data.sbl_campaign_ids ?? [];
    const people: any[] = [];
    for (const id of campaigns) for (const status of ["4", "13"]) people.push(...(await campaignUsers(id, status).catch(() => [])));
    if (!people.length) return { type: "done", note: "Nobody to call this month" };
    const rows = people
      .slice(0, 60)
      .map((u) => `- ${u.name ?? u.fullName ?? "?"}${u.title ? `, ${u.title}` : ""}${u.company ? ` at ${u.company}` : ""} ${u.linkedinProfileUrl ?? u.linkedin_profile ?? ""}`)
      .join("\n");
    return {
      type: "review",
      title: `Call sheet for ${customerLabel(ctx)} (${people.length} people)`,
      body: `People who replied or are talking with ${customerLabel(ctx)} on LinkedIn:\n\n${rows}\n\nCheck every number against TPS/CTPS before calling. Use the call guide saved on their page.`,
      saveAs: "call_sheet",
    };
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

  /**
   * Awaz can't create assistants through its API, so this is one short guided job in Awaz.
   * Everything around it is automatic: we find the new assistant by name, record it, and
   * ask Awaz to send its calls straight to HQ.
   */
  async stl_provision_agent(ctx) {
    const awazReady = Boolean(process.env.AWAZ_API_KEY?.trim());
    if (ctx.input) {
      const [nameOrId, numberRaw] = ctx.input.split(",").map((x) => x.trim());
      let agentId = nameOrId ?? "";
      if (awazReady && nameOrId) {
        const agents = await listAgents().catch(() => []);
        const match = agents.find((a) => a.id === nameOrId) ?? agents.find((a) => a.name.toLowerCase() === nameOrId.toLowerCase());
        if (!match) {
          return {
            type: "manual",
            title: `Couldn't find "${nameOrId}" in Awaz for ${customerLabel(ctx)}`,
            instructions: `There's no Awaz agent called "${nameOrId}". Check the name and try again (agent name, phone number).`,
            inputLabel: "Agent name in Awaz, phone number",
            rerun: true,
          };
        }
        agentId = match.id;
      }
      const number = numberRaw || ctx.customer.data.forwarding_number || null;
      await query(
        `UPDATE customers SET data = data || jsonb_build_object('awaz_agent_ids', $2::jsonb, 'forwarding_number', $3::text) WHERE id = $1`,
        [ctx.customer.id, JSON.stringify(agentId ? [agentId] : []), number],
      );
      const token = process.env.AWAZ_WEBHOOK_TOKEN?.trim();
      if (awazReady && token && agentId) {
        await subscribeCalls(`${config.baseUrl}/webhooks/awaz/${token}`, [agentId]).catch(() => undefined);
      }
      return { type: "done", note: `Assistant ${agentId} on ${number ?? "(number not given)"}; calls now come into HQ` };
    }
    const intake = ctx.customer.data.intake ?? {};
    const name = `STL ${customerLabel(ctx)}`;
    return {
      type: "manual",
      title: `Set up the phone assistant for ${customerLabel(ctx)} in Awaz`,
      instructions:
        `Approved call script:\n\n${ctx.customer.data.script ?? "(see Notes and drafts)"}\n\n` +
        `Urgent transfer number: ${intake.urgent_mobile ?? intake.notify_mobile ?? "(see their answers)"}`,
      inputLabel: "Agent name in Awaz, phone number (for example STL Jo Plumbing, +441134960000)",
      rerun: true,
      guide: {
        why: "Awaz doesn't let other systems create assistants or attach numbers; everything else is automatic.",
        minutes: 5,
        steps: [
          `In Awaz, duplicate the "Speed to Lead template" agent and name it "${name}".`,
          "Paste the approved script (below, under More detail) into its Prompt.",
          "Attach one of our UK numbers to it, and set Transfer Call to the urgent number shown below.",
          `Type "${name}" and the number below, and save. HQ finds the agent, links its calls and carries on.`,
        ],
      },
    };
  },

  /**
   * Three test calls from our "test caller" agent to the client's business number: unanswered (checks
   * forwarding), a normal booking, an out-of-area enquiry. Completes when the calls come back.
   */
  async stl_test_calls(ctx) {
    const tester = process.env.AWAZ_TEST_AGENT_ID?.trim();
    const from = process.env.AWAZ_TEST_FROM_ID?.trim();
    const business = ctx.customer.data.intake?.phone;
    if (!tester || !from || !business || !process.env.AWAZ_API_KEY?.trim()) {
      return {
        type: "manual",
        title: `Test calls for ${customerLabel(ctx)}`,
        instructions: "Ring the business number and let it go unanswered; make a booking call, an out-of-area call and an urgent call.",
        guide: {
          why: "Automatic test calls need a test caller agent in Awaz (AWAZ_TEST_AGENT_ID and AWAZ_TEST_FROM_ID).",
          minutes: 15,
          steps: [
            "Ring the client's business number and let it go unanswered. It should forward to the assistant.",
            "Make a normal booking call, an out-of-area call and an urgent call.",
            "If anything sounds wrong, adjust the agent's prompt in Awaz, then mark this done.",
          ],
        },
      };
    }
    if (ctx.customer.data.test_calls_started_at) return { type: "waiting", note: "Waiting for the test calls to come back" };
    const personas = ["Test caller (booking)", "Test caller (out of area)", "Test caller (callback)"];
    const start = Date.now() + 2 * 60_000;
    for (const [i, persona] of personas.entries()) {
      await placeCall({ agent: tester, name: persona, phone: business, from, datetime: new Date(start + i * 5 * 60_000).toISOString() });
    }
    await query(`UPDATE customers SET data = data || jsonb_build_object('test_calls_started_at', to_jsonb(now())) WHERE id = $1`, [ctx.customer.id]);
    return { type: "waiting", note: "Three test calls placed; this ticks itself when they're answered" };
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

  /** Last week's calls, read by AI: what went well, what was missed, suggested script changes. */
  async stl_call_review(ctx) {
    const calls = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM awaz_events WHERE customer_id = $1 AND received_at > now() - interval '7 days' ORDER BY received_at`,
      [ctx.customer.id],
    );
    if (!calls.length) return { type: "done", note: "No calls this week" };
    const material = calls
      .map((c, i) => `Call ${i + 1}: ${JSON.stringify(c.payload).slice(0, 2500)}`)
      .join("\n\n")
      .slice(0, 60000);
    const review = await draftJson<{ body: string; changes_needed: boolean }>({
      system:
        "You review calls answered by an AI phone assistant for a UK trade business. Be specific and brief. " +
        "Say what went well, any call handled badly (wrong answer, missed booking, missed urgency, rude or confusing), " +
        "and exact wording changes for the assistant's script. Never invent calls.",
      prompt: `Current script:\n${ctx.customer.data.script ?? "(not recorded)"}\n\nThis week's calls:\n${material}`,
      schema: { type: "object", properties: { body: { type: "string" }, changes_needed: { type: "boolean" } }, required: ["body", "changes_needed"], additionalProperties: false },
      maxTokens: 6000,
    });
    if (!review.changes_needed) return { type: "done", note: `${calls.length} calls reviewed; no changes needed` };
    return { type: "review", title: `Suggested script changes for ${customerLabel(ctx)}`, body: review.body, saveAs: "script_suggestions" };
  },

  async stl_usage_summary(ctx) {
    let figures = ctx.input ?? "";
    if (!figures) {
      const rows = await query<{ payload: Record<string, any> }>(
        `SELECT payload FROM awaz_events WHERE customer_id = $1 AND received_at > now() - interval '1 month'`,
        [ctx.customer.id],
      );
      const t = rows.map((r) => JSON.stringify(r.payload).toLowerCase());
      figures =
        `Calls answered in the last month: ${rows.length}. Jobs booked: ${t.filter((x) => /book(ed|ing)|appointment/.test(x)).length}. ` +
        `Urgent calls transferred: ${t.filter((x) => /transfer/.test(x)).length}. Call backs requested: ${t.filter((x) => /call ?back/.test(x)).length}.`;
    }
    const plan = getPlan(ctx.product, ctx.customer.plan);
    const draft = await draftCustomerEmail(
      ctx,
      `Write a short monthly summary email of calls handled for them. Their plan (${plan?.name}) includes ` +
        `${plan?.id === "team" ? 300 : 150} calls a month; mention usage against that only if the figures show it.`,
      figures,
    );
    return { type: "email", approval: false, ...draft };
  },

  // ------------------------------------------------------------ EmailFirst

  /** The three cold emails and landing page copy, drafted from their answers; the client approves (or asks for changes) in their account. */
  async ef_draft_copy(ctx) {
    const feedback: string[] = ctx.customer.data.copy_feedback ?? [];
    const copy = await draftJson<EfCopy>({
      system:
        `You write cold B2B emails for UK decision makers for ${ctx.product.name}. ${ctx.product.voice} ` +
        "Three emails: an opener and two follow-ups, each under 150 words, plain text that reads like a personal email, " +
        "one clear call to action, no hype, no false familiarity, no fake 'Re:'. Use {FNAME} for the first name and " +
        "{COMPANY} for their company where natural, and put {LINK} on its own line where the link to their landing page goes. " +
        "Also the copy for a one-page landing page: the first line is the headline, then short paragraphs separated by blank lines, " +
        "'## ' before a subheading, '- ' before list items. No button text: the button is added from their call to action.",
      prompt:
        `Client answers:\n${intakeSummary(ctx)}` +
        (ctx.customer.data.ef_copy ? `\n\nPrevious draft:\n${efCopyText(ctx.customer.data.ef_copy)}` : "") +
        (feedback.length ? `\n\nThe client asked for these changes:\n${feedback.join("\n")}` : ""),
      schema: {
        type: "object",
        properties: {
          emails: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"], additionalProperties: false } },
          landing: { type: "string" },
        },
        required: ["emails", "landing"],
        additionalProperties: false,
      },
      maxTokens: 6000,
    });
    await query(`UPDATE customers SET data = data || jsonb_build_object('ef_copy', $2::jsonb) WHERE id = $1`, [ctx.customer.id, JSON.stringify(copy)]);
    return askClientToApprove(ctx, {
      title: "Your emails and landing page are ready to approve",
      body: `${efCopyText(copy)}\n\nIf you're happy, press Approve and sending is set up straight away. If not, press Ask for changes and tell us what to change: you'll get a new version.`,
    });
  },

  /** Their approved landing page copy, built into a MailWizz landing page in their colours and published. Re-running updates the same page. */
  async ef_landing_page(ctx) {
    requireAutomation("mailwizz");
    const copy: EfCopy | undefined = ctx.customer.data.ef_copy;
    if (!copy?.landing) return { type: "done", note: "No approved landing page copy" };
    const intake = ctx.customer.data.intake ?? {};
    const company = intake.company || customerLabel(ctx);
    const website: string | undefined = intake.website;
    const html = landingPageHtml({
      copy: copy.landing,
      company,
      ctaLabel: (intake.cta || "Find out more").slice(0, 60),
      ctaUrl: website ? (/^https?:/.test(website) ? website : `https://${website}`) : `mailto:${intake.reply_to || ctx.customer.email}`,
      colour: await siteColour(website),
    });
    const session = await mailwizzSession();
    let pageId: string | undefined = ctx.customer.data.ef_landing_id;
    if (!pageId) {
      pageId = await createLandingPage(session, company, `EmailFirst landing page for ${company} (HQ customer ${ctx.customer.id})`);
      await query(`UPDATE customers SET data = data || jsonb_build_object('ef_landing_id', $2::text) WHERE id = $1`, [ctx.customer.id, pageId]);
    }
    await setLandingContent(session, pageId, company, html);
    const url = await publishLandingPage(session, pageId);
    const live = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!live) throw new Error(`The landing page was published but ${url} isn't answering yet`);
    await query(`UPDATE customers SET data = data || jsonb_build_object('ef_landing_url', $2::text) WHERE id = $1`, [ctx.customer.id, url]);
    await postUpdate(ctx.customer, { title: "Your landing page is live", body: `Your landing page is published. Every email links to it, and we count who clicks.`, link: url });
    return { type: "done", note: `Landing page live at ${url}` };
  },

  /** Turn their audience into search filters on our database, check there are enough people, and create the templates. */
  async ef_provision_sending(ctx) {
    requireAutomation("mailwizz");
    const intake = ctx.customer.data.intake ?? {};
    const filters = await audienceFilters(intake.audience ?? "", intake.offer ?? "");
    const available = await countMatches(filters, ctx.customer.id);
    const copy: EfCopy | undefined = ctx.customer.data.ef_copy;
    if (!copy?.emails?.length) return { type: "done", note: "No approved copy" };
    const templates: string[] = [];
    const link: string | undefined = ctx.customer.data.ef_landing_url;
    for (const [i, e] of copy.emails.slice(0, 3).entries()) templates.push(await createTemplate(`EF ${customerLabel(ctx)} ${i + 1}`, mergeTags(e.body, link)));
    await query(`UPDATE customers SET data = data || jsonb_build_object('ef_filters', $2::jsonb, 'ef_templates', $3::jsonb, 'ef_available', $4::int) WHERE id = $1`, [
      ctx.customer.id,
      JSON.stringify(filters),
      JSON.stringify(templates),
      available,
    ]);
    if (available < 3000) {
      await emailOperator(
        `EmailFirst: only ${available} matching contacts for ${customerLabel(ctx)}`,
        `Their audience ("${intake.audience ?? ""}") matches ${available} people in our database, about ${Math.max(1, Math.floor(available / 600))} days of sending. ` +
          `Sending starts anyway. Filters used: ${JSON.stringify(filters)}`,
      );
    }
    return { type: "done", note: `Templates created; ${available} matching contacts in our database` };
  },

  /** Each weekday: today's ~600 contacts into a new list, the opener to them, and follow-ups to earlier days' lists. */
  async ef_daily_send(ctx) {
    requireAutomation("mailwizz");
    const d = ctx.customer.data;
    const templates: string[] = d.ef_templates ?? [];
    const copy: EfCopy | undefined = d.ef_copy;
    if (!templates.length || !copy || !d.ef_filters) return { type: "done", note: "Sending isn't set up yet" };
    const intake = d.intake ?? {};
    const sender: Sender = {
      fromName: intake.sender_name || ctx.customer.name || customerLabel(ctx),
      fromEmail: process.env.EF_FROM_EMAIL?.trim() || ctx.product.email.from,
      replyTo: intake.reply_to || ctx.customer.email,
      company: intake.company || customerLabel(ctx),
    };
    const today = new Date().toISOString().slice(0, 10);
    const history: EfDay[] = d.ef_lists ?? [];
    if (history.some((h) => h.date === today)) return { type: "done", note: "Already sent today" };
    const perDay = Number(d.ef_per_day ?? 600);
    const picked = await pickProspects(d.ef_filters, ctx.customer.id, perDay, `ef-${today}`);
    const sendAt = new Date(Math.max(Date.now() + 15 * 60_000, new Date(`${today}T09:30:00Z`).getTime()));
    const campaigns: string[] = [];
    let listUid: string | undefined;
    if (picked.length) {
      listUid = await createList(`EF | ${customerLabel(ctx)} | ${today}`, sender);
      await ensureFields(listUid, [{ tag: "COMPANY", label: "Company" }, { tag: "TITLE", label: "Job title" }]);
      await addSubscribers(listUid, picked.map((p) => ({ EMAIL: p.email, FNAME: p.first_name ?? "", LNAME: p.last_name ?? "", COMPANY: p.company ?? "", TITLE: p.title ?? "" })));
      campaigns.push(await createCampaign({ name: `EF ${customerLabel(ctx)} ${today} #1`, subject: mergeTags(copy.emails[0]!.subject), listUid, templateUid: templates[0]!, sendAt, sender }));
    }
    // Follow-ups: email 2 to the list from three sending days ago, email 3 to the one from seven.
    for (const [ago, n] of [[3, 1], [7, 2]] as const) {
      const earlier = history[history.length - ago];
      if (earlier?.list && templates[n] && copy.emails[n]) {
        campaigns.push(await createCampaign({ name: `EF ${customerLabel(ctx)} ${earlier.date} #${n + 1}`, subject: mergeTags(copy.emails[n]!.subject), listUid: earlier.list, templateUid: templates[n]!, sendAt, sender }));
      }
    }
    const entry: EfDay = { date: today, list: listUid, count: picked.length, campaigns };
    await query(`UPDATE customers SET data = data || jsonb_build_object('ef_lists', $2::jsonb) WHERE id = $1`, [ctx.customer.id, JSON.stringify([...history, entry].slice(-40))]);
    if (!picked.length) {
      await emailOperator(`EmailFirst: no new contacts left for ${customerLabel(ctx)}`, "Their audience has been fully used. Upload a fresh prospect file, or widen their audience.");
    }
    return { type: "done", note: `${picked.length} new contacts; ${campaigns.length} sends scheduled` };
  },

  /** Each weekday morning: who clicked yesterday, with a suggested follow-up for each, sent to the client. */
  async ef_daily_report(ctx) {
    requireAutomation("mailwizz");
    const history: EfDay[] = ctx.customer.data.ef_lists ?? [];
    const recent = history.filter((h) => Date.now() - new Date(h.date).getTime() < 4 * 864e5);
    if (!recent.length) return { type: "done", note: "Nothing sent recently" };
    const seen: string[] = ctx.customer.data.ef_reported ?? [];
    const clickers: Contact[] = [];
    for (const day of history.slice(-8)) {
      if (!day.list) continue;
      for (const uid of day.campaigns) {
        for (const c of await campaignClickers(day.list, uid, 2).catch(() => [])) {
          const key = (c.EMAIL ?? "").toLowerCase();
          if (key && !seen.includes(key) && !clickers.some((x) => x.EMAIL.toLowerCase() === key)) clickers.push(c);
        }
      }
      for (const email of await unsubscribed(day.list).catch(() => [])) await suppress(email, "Unsubscribed from EmailFirst");
    }
    await query(`UPDATE customers SET data = data || jsonb_build_object('ef_reported', $2::jsonb) WHERE id = $1`, [
      ctx.customer.id,
      JSON.stringify([...seen, ...clickers.map((c) => c.EMAIL.toLowerCase())].slice(-5000)),
    ]);
    const people = clickers.map((c) => `- ${[c.FNAME, c.LNAME].filter(Boolean).join(" ") || "(no name)"}, ${c.TITLE || "role not known"} at ${c.COMPANY || "company not known"} <${c.EMAIL}>`).join("\n");
    const draft = await draftCustomerEmail(
      ctx,
      clickers.length
        ? "Write this morning's short report: the people below clicked through to their page from our emails. List them exactly as given, " +
            "then a short, friendly follow-up email they could send to each (one template using the person's first name). Use only these facts."
        : "Write this morning's short report: nobody new clicked through yesterday. Keep it to two or three sentences and say sending continues today.",
      clickers.length ? `People who clicked:\n${people}` : "",
    );
    return { type: "email", approval: false, ...draft };
  },

  /** Weekly results from Mailpulse: this week's figures are the change in each campaign's running totals. */
  async ef_weekly_summary(ctx) {
    const weekAgo = Date.now() - 8 * 864e5;
    const uids = [
      ...String(ctx.customer.data.mailwizz_campaigns ?? "").split(/[\s,]+/).filter(Boolean),
      ...((ctx.customer.data.ef_lists ?? []) as EfDay[]).filter((h) => new Date(h.date).getTime() > weekAgo).flatMap((h) => h.campaigns),
    ];
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

  /** AI drafts the research questions from the brief; the sponsor approves (or asks for changes) in their account. */
  async gq_questions(ctx) {
    const feedback: string[] = ctx.customer.data.question_design_feedback ?? [];
    const survey = await draftJson<Survey>({
      system:
        "You design short business research surveys for Good Questions. Five areas, three questions each, each with three " +
        "answers scored 0, 1 and 2 points (2 = most mature). Plain British English, neutral wording, no leading questions. " +
        "Four result bands with a min percentage (0, 40, 60, 80) and one practical sentence of advice each.",
      prompt:
        `Sponsor: ${ctx.customer.data.intake?.organisation ?? customerLabel(ctx)}\nBrief:\n${intakeSummary(ctx)}` +
        (ctx.customer.data.gq_questions ? `\n\nPrevious draft:\n${surveyText(ctx.customer.data.gq_questions)}` : "") +
        (feedback.length ? `\n\nThe sponsor asked for these changes:\n${feedback.join("\n")}` : ""),
      schema: surveySchema as unknown as Record<string, unknown>,
      maxTokens: 8000,
    });
    await query(`UPDATE customers SET data = data || jsonb_build_object('gq_questions', $2::jsonb) WHERE id = $1`, [ctx.customer.id, JSON.stringify(survey)]);
    ctx.customer.data.gq_questions = survey;
    return askClientToApprove(ctx, {
      title: "Please approve your research questions",
      body: `Here are the questions for your research. Approve them, or tell us what to change and we'll send a new version.\n\n${surveyText(survey)}`,
    });
  },

  /** Legitimate interests note, privacy wording, invitation email and retention: drafted, then approved by the sponsor. */
  async gq_compliance(ctx) {
    const feedback: string[] = ctx.customer.data.compliance_feedback ?? [];
    const pack = await draftJson<{ body: string; invitation_subject: string; invitation_body: string }>({
      system:
        "You prepare a short UK GDPR/PECR compliance pack for B2B research by email: (1) a legitimate interests assessment " +
        "in a few sentences (purpose, necessity, balance), (2) the privacy wording shown on the survey, (3) the invitation " +
        "email (who we are, why we're writing, what it involves, how long, a clear opt-out line), (4) retention: answers kept " +
        "12 months then deleted. Corporate subscribers only. Plain British English. Not legal advice.",
      prompt:
        `Sponsor and brief:\n${intakeSummary(ctx)}\n\nSurvey: ${ctx.customer.data.gq_questions?.title ?? ""}\n` +
        "In the invitation body, write {SURVEY_LINK} where the survey link goes and {FNAME} for the first name." +
        (feedback.length ? `\n\nThe sponsor asked for these changes:\n${feedback.join("\n")}` : ""),
      schema: {
        type: "object",
        properties: { body: { type: "string" }, invitation_subject: { type: "string" }, invitation_body: { type: "string" } },
        required: ["body", "invitation_subject", "invitation_body"],
        additionalProperties: false,
      },
      maxTokens: 5000,
    });
    await query(`UPDATE customers SET data = data || jsonb_build_object('gq_compliance', $2::text, 'gq_invitation', $3::jsonb) WHERE id = $1`, [
      ctx.customer.id,
      pack.body,
      JSON.stringify({ subject: pack.invitation_subject, body: pack.invitation_body }),
    ]);
    return askClientToApprove(ctx, { title: "Please approve the privacy and invitation wording", body: pack.body });
  },

  /** Build the survey page from the approved questions (hosted by HQ, in place of ScoreApp). */
  async gq_build_survey(ctx) {
    const survey: Survey | undefined = ctx.customer.data.gq_questions;
    if (!survey) return { type: "done", note: "No approved questions" };
    let token: string | undefined = ctx.customer.data.gq_survey_token;
    if (!token) {
      token = await createSurvey(ctx.customer, survey);
      await query(`UPDATE customers SET data = data || jsonb_build_object('gq_survey_token', $2::text) WHERE id = $1`, [ctx.customer.id, token]);
    }
    const url = `${portalUrl(ctx.product)}/survey/${token}`;
    await postUpdate(ctx.customer, { title: "Your survey is ready", body: `Your research survey is live. You can try it here:\n${url}`, link: url });
    return { type: "done", note: `Survey live at ${url}` };
  },

  /** Set up the invitations: the audience as filters on our database, and the approved invitation as a template. */
  async gq_send_invites(ctx) {
    requireAutomation("mailwizz");
    const intake = ctx.customer.data.intake ?? {};
    const inv: { subject: string; body: string } | undefined = ctx.customer.data.gq_invitation;
    const token: string | undefined = ctx.customer.data.gq_survey_token;
    if (!inv || !token) return { type: "done", note: "No approved invitation or survey yet" };
    const filters = await audienceFilters(intake.audience ?? "", intake.objective ?? "");
    const link = `${portalUrl(ctx.product)}/survey/${token}`;
    const template = await createTemplate(`GQ ${customerLabel(ctx)} invitation`, mergeTags(inv.body).replace(/\{SURVEY_LINK\}/g, link));
    const available = await countMatches(filters, ctx.customer.id);
    await query(`UPDATE customers SET data = data || jsonb_build_object('gq_filters', $2::jsonb, 'gq_template', $3::text, 'gq_invites_sent', 0) WHERE id = $1`, [
      ctx.customer.id,
      JSON.stringify(filters),
      template,
    ]);
    return { type: "done", note: `Invitations ready; ${available} matching people in our database` };
  },

  /** Each weekday: up to 300 more invitations, until the target is reached. */
  async gq_daily_invites(ctx) {
    requireAutomation("mailwizz");
    const d = ctx.customer.data;
    if (!d.gq_template || !d.gq_filters || !d.gq_invitation) return { type: "done", note: "Invitations not set up yet" };
    const target = Number(d.gq_target ?? 3000);
    const sent = Number(d.gq_invites_sent ?? 0);
    if (sent >= target) return { type: "done", note: "All invitations sent" };
    const today = new Date().toISOString().slice(0, 10);
    const picked = await pickProspects(d.gq_filters, ctx.customer.id, Math.min(300, target - sent), `gq-${today}`, 30);
    if (!picked.length) return { type: "done", note: "No more matching people" };
    const sender: Sender = {
      fromName: "Felix at Good Questions",
      fromEmail: process.env.GQ_FROM_EMAIL?.trim() || ctx.product.email.from,
      replyTo: ctx.product.email.from,
      company: "Good Questions",
    };
    const list = await createList(`GQ | ${customerLabel(ctx)} | ${today}`, sender);
    await ensureFields(list, [{ tag: "COMPANY", label: "Company" }, { tag: "TITLE", label: "Job title" }]);
    await addSubscribers(list, picked.map((p) => ({ EMAIL: p.email, FNAME: p.first_name ?? "", LNAME: p.last_name ?? "", COMPANY: p.company ?? "", TITLE: p.title ?? "" })));
    await createCampaign({ name: `GQ ${customerLabel(ctx)} ${today}`, subject: mergeTags(d.gq_invitation.subject), listUid: list, templateUid: d.gq_template, sendAt: new Date(Date.now() + 15 * 60_000), sender });
    await query(`UPDATE customers SET data = data || jsonb_build_object('gq_invites_sent', $2::int) WHERE id = $1`, [ctx.customer.id, sent + picked.length]);
    return { type: "done", note: `${picked.length} invitations scheduled (${sent + picked.length} of ${target})` };
  },

  async gq_findings(ctx) {
    const figures = ctx.input || (await surveyFindings(ctx.customer));
    if (!figures) return { type: "done", note: "No survey yet" };
    const draft = await draftCustomerEmail(
      ctx,
      "Write a weekly findings update for the research sponsor: completions so far, what the answers show, " +
        "and anything worth watching. Use only the data given.",
      figures,
    );
    return { type: "email", approval: false, ...draft };
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

