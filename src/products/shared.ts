import type { StepDef } from "./types.js";

export const BOOKING_URL = "https://calendly.com/felixclarke/chat-with-felix-clarke";
export const AIFT = "AI Future Technologies Ltd (company 16785608)";

export const HOUSE_VOICE =
  "Write in plain British English with UK spelling. Confident but understated: no hype, " +
  "no exclamation marks, no competitor bashing, no invented facts, figures or testimonials. " +
  "Short paragraphs. Sign off as Felix.";

export function fromAddress(slug: string, fallback: string): string {
  const key = `FROM_${slug.toUpperCase().replace(/-/g, "_")}`;
  return process.env[key]?.trim() || fallback;
}

/** Every product starts onboarding the same way. */
export const welcomeSteps: StepDef[] = [
  { key: "welcome", title: "Send welcome email with intake form", kind: "auto", handler: "send_welcome" },
  { key: "intake", title: "Customer completes intake form", kind: "customer", handler: "await_intake" },
];

export const goLiveStep: StepDef = {
  key: "go_live",
  title: "Mark live and tell the customer",
  kind: "auto",
  handler: "go_live",
};
