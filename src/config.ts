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
  },

  imap: {
    // e.g. imaps://replies%40example.com:password@imap.example.com:993
    url: str("IMAP_URL"),
  },

  anthropic: {
    apiKey: str("ANTHROPIC_API_KEY"),
    model: str("CLAUDE_MODEL", "claude-opus-5"),
    effort: str("CLAUDE_EFFORT", "medium") as "low" | "medium" | "high",
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
