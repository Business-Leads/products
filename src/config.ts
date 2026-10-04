// All runtime configuration comes from environment variables so that secrets
// live in the hosting platform (DigitalOcean App Platform), never in the repo.

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  // The name shown on the dashboard and on operator emails.
  brand: str("BRAND_NAME", "Online Business Builder"),
  env: str("NODE_ENV", "development"),
  port: int("PORT", 8080),
  // Public base URL of this app, used in links sent to customers (checkout
  // return URLs, onboarding forms). e.g. https://hq.business-leads.co.uk
  baseUrl: str("BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
  databaseUrl: str("DATABASE_URL", "postgres://localhost:5432/products_hq"),
  databaseSsl: str("DATABASE_SSL", "") === "true",

  admin: {
    password: str("ADMIN_PASSWORD"),
    // Where the daily digest and urgent alerts go.
    alertEmail: str("ALERT_EMAIL", "info@felixclarke.com"),
    // Sender for the digest and alerts; must be on a domain verified for sending.
    fromEmail: str("OPERATOR_FROM", "hello@onlinebusinessbuilder.co.uk"),
  },

  portal: {
    // Products whose account area is served on its own domain (portal.host in
    // the product registry), as a comma-separated list of slugs, or "all".
    // The others are served at BASE_URL/portal/<slug> until their DNS is set up.
    domains: str("PORTAL_DOMAINS"),
  },

  calcom: {
    // Dad's Cal.com username; booking links are cal.com/<username>/<product>-chat|onboarding.
    username: str("CALCOM_USERNAME"),
    // Secret path segment for the Cal.com webhook: /webhooks/calcom/<token>
    webhookToken: str("CALCOM_WEBHOOK_TOKEN"),
  },

  sbl: {
    // Secret path segment for the Sbl.so webhook: /webhooks/sbl/<token>
    webhookToken: str("SBL_WEBHOOK_TOKEN"),
  },

  stripe: {
    secretKey: str("STRIPE_SECRET_KEY"),
    webhookSecret: str("STRIPE_WEBHOOK_SECRET"),
  },

  smtp: {
    // e.g. smtps://user:pass@smtp.example.com:465
    url: str("SMTP_URL"),
    // Optional shared reply-to for customer and lead email, so every reply lands
    // in the one mailbox this app reads (IMAP_URL).
    replyTo: str("REPLY_TO"),
    // When the mail server only sends as one mailbox (Google), every email goes
    // from this address, keeping each product's name as the sender name.
    fromAddress: str("SMTP_FROM"),
  },

  imap: {
    // e.g. imaps://replies%40example.com:password@imap.example.com:993
    url: str("IMAP_URL"),
    // Only this folder/label is read (e.g. a Gmail label), never the whole inbox.
    folder: str("IMAP_FOLDER", "INBOX"),
  },

  anthropic: {
    apiKey: str("ANTHROPIC_API_KEY"),
    model: str("CLAUDE_MODEL", "claude-opus-5-5"),
    effort: str("CLAUDE_EFFORT", "medium") as "low" | "medium" | "high",
    // Hard monthly spending cap in US dollars. Drafting stops (and raises an
    // alert) once this month's estimated spend reaches it.
    monthlyBudgetUsd: Number.parseFloat(str("CLAUDE_MONTHLY_BUDGET_USD", "20")),
  },

  scheduler: {
    enabled: str("SCHEDULER_ENABLED", "true") !== "false",
    tickSeconds: int("SCHEDULER_TICK_SECONDS", 60),
    timezone: "Europe/London",
  },
};

export const isProduction = config.env === "production";

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (!config.admin.password) problems.push("ADMIN_PASSWORD is not set");
  return problems;
}
