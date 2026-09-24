import { config } from "../config.js";
import { getIntegration } from "../integrations/index.js";
import { draftJson, emailSchema, type EmailDraft } from "../lib/claude.js";
import { getPlan } from "../products/index.js";
import { NotConfiguredError } from "../lib/util.js";
import { query } from "../db/index.js";
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

const handlers: Record<string, Handler> = {
  // ---------------------------------------------------------------- shared

  async send_welcome(ctx) {
    const link = `${config.baseUrl}/start/${ctx.customer.intake_token}`;
    return {
      type: "email",
      approval: false,
      subject: `Welcome to ${ctx.product.name}: one form to get started`,
      body:
        `Hello ${firstName(ctx)},\n\n` +
        `Thank you for signing up to ${ctx.product.name}. The next step is a short form so we can set ` +
        `everything up for you:\n\n${link}\n\n` +
        `It takes about five minutes. As soon as it's in, we'll get to work and keep you posted.\n\n` +
        `If anything is unclear, just reply to this email.\n\nFelix`,
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
        `${customerLabel(ctx)}. You don't need to do anything else. We'll be in touch with your first ` +
        `results, and you can reply to this email at any time.\n\nFelix`,
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

  async linkn_reply_triage(ctx) {
    requireAutomation("sblso");
    return { type: "done", note: `No automated triage for ${customerLabel(ctx)}` };
  },

  async linkn_weekly_harvest() {
    requireAutomation("feedboss");
    return { type: "done" };
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
    return {
      type: "manual",
      title: `Send data processing agreement to ${customerLabel(ctx)}`,
      instructions:
        "Send the Speed to Lead data processing agreement for signature, with the recording retention " +
        `period they chose (${ctx.customer.data.intake?.retention ?? "see intake"}). Mark done once signed.`,
    };
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
    requireAutomation("awaz");
    return { type: "done", note: `Assistant created for ${customerLabel(ctx)}` };
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
    return {
      type: "manual",
      title: `Confirm ${customerLabel(ctx)} approved their emails`,
      instructions: "When the client replies approving the copy (or with changes you've made), mark this done.",
    };
  },

  async ef_provision_sending() {
    requireAutomation("mailwizz");
    return { type: "done" };
  },

  async ef_weekly_summary(ctx) {
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

