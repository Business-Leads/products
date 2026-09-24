import { config } from "../config.js";

// Every outside service the products depend on. The dashboard shows which are
// connected. When an action needs a service that isn't connected yet, the
// engine turns it into a manual task with instructions instead of failing
// silently, so nothing stalls unseen.

export interface Integration {
  id: string;
  name: string;
  purpose: string;
  envVars: string[];
  configured: () => boolean;
  /** Whether this app can drive it through an API yet, or only raise manual tasks. */
  automation: "full" | "manual";
  notes?: string;
}

const has = (...names: string[]) => () => names.every((n) => Boolean(process.env[n]?.trim()));

export const integrations: Integration[] = [
  {
    id: "stripe",
    name: "Stripe (Email First Ltd)",
    purpose: "Checkout, subscriptions, failed payments, disputes",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    configured: () => Boolean(config.stripe.secretKey && config.stripe.webhookSecret),
    automation: "full",
  },
  {
    id: "smtp",
    name: "Email sending (SMTP)",
    purpose: "Lead replies, onboarding, reports, digest",
    envVars: ["SMTP_URL"],
    configured: () => Boolean(config.smtp.url),
    automation: "full",
    notes: "Each product's from-address domain needs SPF/DKIM for this server.",
  },
  {
    id: "anthropic",
    name: "Claude API",
    purpose: "Drafts replies, scripts, copy and reports",
    envVars: ["ANTHROPIC_API_KEY"],
    configured: () => Boolean(config.anthropic.apiKey),
    automation: "full",
  },
  {
    id: "awaz",
    name: "Awaz.ai",
    purpose: "Speed to Lead voice assistants and numbers",
    envVars: ["AWAZ_API_KEY"],
    configured: has("AWAZ_API_KEY"),
    automation: "manual",
    notes: "API calls not wired yet: needs Awaz API documentation for the white-label account.",
  },
  {
    id: "localfalcon",
    name: "Local Falcon",
    purpose: "FirstPageLocal Maps grid scans and AI visibility checks",
    envVars: ["LOCALFALCON_API_KEY"],
    configured: has("LOCALFALCON_API_KEY"),
    automation: "manual",
    notes: "API calls not wired yet: confirm the plan includes API access and credits.",
  },
  {
    id: "mailwizz",
    name: "Mailpulse / MailWizz",
    purpose: "EmailFirst lists, templates and campaigns",
    envVars: ["MAILWIZZ_API_URL", "MAILWIZZ_API_KEY"],
    configured: has("MAILWIZZ_API_URL", "MAILWIZZ_API_KEY"),
    automation: "manual",
    notes: "API calls not wired yet: confirm per-client provisioning with XLMG.",
  },
  {
    id: "feedboss",
    name: "FeedBoss",
    purpose: "Linkn posts in the client's voice",
    envVars: ["FEEDBOSS_API_KEY"],
    configured: has("FEEDBOSS_API_KEY"),
    automation: "manual",
  },
  {
    id: "sblso",
    name: "Sbl.so",
    purpose: "Linkn LinkedIn outreach and conversations",
    envVars: ["SBL_API_KEY", "SBL_COMPANY_ID"],
    configured: has("SBL_API_KEY", "SBL_COMPANY_ID"),
    automation: "manual",
  },
  {
    id: "scoreapp",
    name: "ScoreApp",
    purpose: "Good Questions scorecards and responses",
    envVars: ["SCOREAPP_API_KEY"],
    configured: has("SCOREAPP_API_KEY"),
    automation: "manual",
  },
];

export function getIntegration(id: string): Integration | undefined {
  return integrations.find((i) => i.id === id);
}
