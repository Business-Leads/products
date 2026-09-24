import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { NotConfiguredError } from "./util.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new NotConfiguredError("anthropic", "ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export function claudeConfigured(): boolean {
  return Boolean(config.anthropic.apiKey);
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
  const stream = getClient().beta.messages.stream({
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
