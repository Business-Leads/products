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
    id: "imap",
    name: "Reply mailbox (IMAP)",
    purpose: "Reads replies: stops follow-ups, handles 'stop' requests, drafts answers",
    envVars: ["IMAP_URL", "REPLY_TO"],
    configured: () => Boolean(config.imap.url),
    automation: "full",
    notes: "Set REPLY_TO to this mailbox so every customer and lead reply lands here.",
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
    id: "netlify",
    name: "Netlify",
    purpose: "Hosting the websites built for Online Business Builder clients",
    envVars: ["NETLIFY_AUTH_TOKEN"],
    configured: has("NETLIFY_AUTH_TOKEN"),
    automation: "full",
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    purpose: "Checking domain names and pointing them at client websites",
    envVars: ["GODADDY_API_KEY", "GODADDY_API_SECRET"],
    configured: has("GODADDY_API_KEY", "GODADDY_API_SECRET"),
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
    purpose: "Online Business Builder's Google profiles: posts, review replies, ranking scans, figures and monitoring",
    envVars: ["LOCALFALCON_API_KEY"],
    configured: has("LOCALFALCON_API_KEY"),
    automation: "full",
    notes: "Basic plan or above. Felix's Google account is connected in Local Falcon; each client's profile is imported there once.",
  },
  {
    id: "mailwizz",
    name: "Mailpulse / MailWizz",
    purpose: "EmailFirst lists, templates and campaigns",
    envVars: ["MAILWIZZ_API_URL", "MAILWIZZ_API_KEY"],
    configured: has("MAILWIZZ_API_URL", "MAILWIZZ_API_KEY"),
    automation: "full",
    notes: "Weekly results are collected automatically. Lists and campaigns are still set up by hand in Mailpulse.",
  },
  {
    id: "feedboss",
    name: "FeedBoss",
    purpose: "Linkn posts in the client's voice",
    envVars: ["FEEDBOSS_API_KEY"],
    configured: has("FEEDBOSS_API_KEY"),
    automation: "full",
    notes: "Weekly post drafts and monthly figures are automatic. Felix checks and schedules posts in FeedBoss.",
  },
  {
    id: "sblso",
    name: "Sbl.so",
    purpose: "Linkn LinkedIn outreach and conversations",
    envVars: ["SBL_WEBHOOK_SECRET", "SBL_API_KEY", "SBL_COMPANY_ID"],
    // The webhook brings results in; the API key (app.secondbrainlabs.com/mcp-server) lets HQ run campaigns.
    configured: has("SBL_API_KEY", "SBL_COMPANY_ID"),
    notes: "API key from app.secondbrainlabs.com/mcp-server, company id from Settings, Company. The webhook works without it.",
    automation: "full",
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
