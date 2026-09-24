import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { emailOperator } from "../lib/email.js";
import { fmtDate } from "../lib/util.js";
import { formatPrice, monthlyValuePence, products } from "../products/index.js";

/**
 * The daily quality-control email: what happened in the last 24 hours, what
 * is waiting on a person, and anything that looks wrong.
 */
export async function buildDigest(): Promise<{ subject: string; body: string }> {
  const lines: string[] = [];
  const openTasks = await query(
    `SELECT kind, priority, title, due_at FROM tasks WHERE status = 'open' ORDER BY priority, created_at LIMIT 30`,
  );
  const urgent = openTasks.filter((t) => t.priority === 1);

  let mrr = 0;
  lines.push("PRODUCTS (last 24 hours)");
  for (const p of products) {
    const c = await one(
      `SELECT count(*) FILTER (WHERE status IN ('active','onboarding','past_due')) AS live,
              count(*) FILTER (WHERE created_at > now() - interval '1 day') AS new,
              count(*) FILTER (WHERE cancelled_at > now() - interval '1 day') AS cancelled
       FROM customers WHERE product = $1`,
      [p.slug],
    );
    const l = await one(`SELECT count(*) AS n FROM leads WHERE product = $1 AND created_at > now() - interval '1 day'`, [p.slug]);
    const revenue = await query(
      `SELECT amount_pence, interval FROM customers WHERE product = $1 AND status IN ('active','onboarding','past_due')`,
      [p.slug],
    );
    const productMrr = revenue.reduce((s, r) => s + monthlyValuePence(r.amount_pence, r.interval), 0);
    mrr += productMrr;
    lines.push(
      `- ${p.name}: ${c.live} customers (${formatPrice(productMrr)}/mo), ${c.new} new, ${c.cancelled} cancelled, ${l.n} enquiries`,
    );
  }
  lines.push(`Total monthly recurring revenue: ${formatPrice(mrr)}`, "");

  const sent = await one(`SELECT count(*) AS n FROM emails WHERE status = 'sent' AND sent_at > now() - interval '1 day'`);
  const delivered = await one(
    `SELECT count(*) AS n FROM deliveries WHERE status = 'delivered' AND delivered_at > now() - interval '1 day'`,
  );
  lines.push("WORK DONE AUTOMATICALLY", `- ${sent.n} emails sent`, `- ${delivered.n} customer deliverables completed`, "");

  lines.push(`WAITING ON YOU (${openTasks.length}${openTasks.length === 30 ? "+" : ""})`);
  if (!openTasks.length) lines.push("- Nothing. The inbox is clear.");
  for (const t of openTasks) {
    lines.push(`- [${t.kind}${t.priority === 1 ? ", urgent" : ""}] ${t.title}${t.due_at ? ` (due ${fmtDate(t.due_at)})` : ""}`);
  }
  lines.push("");

  const failedJobs = await query(
    `SELECT job, count(*) AS n, max(error) AS error FROM job_runs
     WHERE status = 'error' AND started_at > now() - interval '1 day' GROUP BY job`,
  );
  const down = await query(
    `SELECT DISTINCT ON (url) url, ok FROM health_checks ORDER BY url, checked_at DESC`,
  );
  const problems = [
    ...failedJobs.map((j) => `- Job "${j.job}" failed ${j.n} time(s): ${j.error}`),
    ...down.filter((d) => !d.ok).map((d) => `- ${d.url} is down`),
  ];
  lines.push("SYSTEM HEALTH", ...(problems.length ? problems : ["- All jobs ran and all sites are up."]), "");
  lines.push(`Dashboard: ${config.baseUrl}`);

  const subject =
    `Products HQ daily: ${urgent.length ? `${urgent.length} urgent, ` : ""}${openTasks.length} waiting, ` +
    `${formatPrice(mrr)} MRR`;
  return { subject, body: lines.join("\n") };
}

export async function sendDigest(): Promise<string> {
  const { subject, body } = await buildDigest();
  await emailOperator(subject, body, "digest");
  return subject;
}
