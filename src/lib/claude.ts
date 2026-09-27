import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { getSetting, setSetting } from "./settings.js";
import { createTask } from "./tasks.js";
import { NotConfiguredError } from "./util.js";

// Per-million-token prices (USD) used to estimate spend against the budget.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function monthKey(): string {
  return `claude_spend:${new Date().toISOString().slice(0, 7)}`;
}

export async function claudeSpendThisMonth(): Promise<number> {
  return getSetting<number>(monthKey(), 0);
}

async function recordSpend(model: string, inputTokens: number, outputTokens: number): Promise<void> {
  const p = PRICES[model] ?? PRICES["claude-opus-5"]!; // unknown models are costed high
  const cost = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  await setSetting(monthKey(), Math.round(((await claudeSpendThisMonth()) + cost) * 10000) / 10000);
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new NotConfiguredError("anthropic", "ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export function claudeConfigured(): boolean {
  return Boolean(config.anthropic.apiKey);
}

/** Configured and still within this month's budget. */
export async function claudeAvailable(): Promise<boolean> {
  return claudeConfigured() && (await claudeSpendThisMonth()) < config.anthropic.monthlyBudgetUsd;
}


/**
 * Ask Claude for a JSON object matching `schema`. Used for every draft the
 * system produces (emails, reports, scripts), which then either go out
 * automatically or wait for approval depending on the product's autonomy settings.
 */
export async function draftJson<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const client = getClient();
  const spent = await claudeSpendThisMonth();
  if (spent >= config.anthropic.monthlyBudgetUsd) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: `Claude budget reached ($${spent.toFixed(2)} of $${config.anthropic.monthlyBudgetUsd} this month)`,
      body: "Drafting has stopped until next month; drafts become manual tasks. Raise CLAUDE_MONTHLY_BUDGET_USD to continue.",
      dedupeKey: `alert:claude-budget:${monthKey()}`,
    });
    throw new NotConfiguredError("anthropic", "this month's Claude budget has been reached");
  }
  const stream = client.beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: opts.maxTokens ?? 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: config.anthropic.effort,
      format: { type: "json_schema", schema: opts.schema },
    },
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });
  const message = await stream.finalMessage();
  await recordSpend(config.anthropic.model, message.usage.input_tokens, message.usage.output_tokens);

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to draft this; it needs a person");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude's draft was cut off (max_tokens)");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text) as T;
}

export const emailSchema = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text email body, no signature block beyond the sign-off." },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

export interface EmailDraft {
  subject: string;
  body: string;
}
