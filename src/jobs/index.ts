import { config } from "../config.js";
import { query } from "../db/index.js";
import { pauseOverdueCustomers } from "../engine/billing.js";
import { processLeads } from "../engine/leads.js";
import { advanceOnboarding, runRoutines } from "../engine/workflow.js";
import { queueEmail, sendDueEmails } from "../lib/email.js";
import { createTask } from "../lib/tasks.js";
import { requireProduct } from "../products/index.js";
import { sendDigest } from "./digest.js";
import { checkSites } from "./health.js";

export type Schedule = { everyMinutes: number } | { dailyAt: string }; // "HH:MM" UK time

export interface Job {
  name: string;
  description: string;
  schedule: Schedule;
  run: () => Promise<string>;
}

async function onboardingTick(): Promise<string> {
  const customers = await query<{ id: string }>(
    `SELECT DISTINCT c.id FROM customers c JOIN onboarding_steps s ON s.customer_id = c.id
     WHERE c.status IN ('onboarding','active') AND s.status IN ('pending','failed','waiting') AND s.task_id IS NULL`,
  );
  for (const c of customers) await advanceOnboarding(c.id);
  const reminders = await intakeReminders();
  return `${customers.length} customer(s) advanced, ${reminders} intake reminder(s)`;
}

/** Nudge customers who haven't filled in the intake form; after two nudges, ask a person to call. */
async function intakeReminders(): Promise<number> {
  const waiting = await query(
    `SELECT c.*, s.started_at AS step_started FROM customers c
     JOIN onboarding_steps s ON s.customer_id = c.id AND s.key = 'intake' AND s.status = 'waiting'
     WHERE c.status = 'onboarding' AND s.started_at < now() - interval '2 days'`,
  );
  let sent = 0;
  for (const c of waiting) {
    const count = Number(c.data.intake_reminders ?? 0);
    const last = c.data.intake_reminded_at ? new Date(c.data.intake_reminded_at).getTime() : 0;
    if (Date.now() - last < 2 * 86_400_000) continue;
    const product = requireProduct(c.product);
    if (count >= 2) {
      await createTask({
        kind: "manual",
        title: `Call ${c.name ?? c.email}: ${product.name} intake form not filled in`,
        body: `Signed up ${c.created_at.toDateString()} and hasn't completed the form after two reminders. Phone: ${c.phone ?? "none"}.`,
        product: product.slug,
        customerId: c.id,
        dedupeKey: `intake-chase:${c.id}`,
      });
      continue;
    }
    await queueEmail({
      product: product.slug,
      customerId: c.id,
      kind: "intake_reminder",
      to: c.email,
      subject: `A quick reminder: your ${product.name} setup form`,
      body:
        `Hello,\n\nWe're ready to set up ${product.name} for you as soon as we have a few details:\n\n` +
        `${config.baseUrl}/start/${c.intake_token}\n\nIt takes about five minutes. Reply if you'd rather ` +
        `do it over the phone.\n\nFelix`,
    });
    await query(
      `UPDATE customers SET data = data || jsonb_build_object('intake_reminders', $2::int, 'intake_reminded_at', now()) WHERE id = $1`,
      [c.id, count + 1],
    );
    sent++;
  }
  return sent;
}

/** Raise an alert if a job hasn't succeeded for a while: the system watching itself. */
async function watchdog(): Promise<string> {
  const stale: string[] = [];
  for (const job of jobs) {
    if (job.name === "watchdog") continue;
    const window = "everyMinutes" in job.schedule ? job.schedule.everyMinutes * 4 : 26 * 60;
    const rows = await query(
      `SELECT 1 FROM job_runs WHERE job = $1 AND status = 'ok' AND started_at > now() - ($2::int * interval '1 minute') LIMIT 1`,
      [job.name, window],
    );
    const everRan = await query(`SELECT 1 FROM job_runs WHERE job = $1 LIMIT 1`, [job.name]);
    if (!rows.length && everRan.length) stale.push(job.name);
  }
  if (stale.length) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: `Automation stalled: ${stale.join(", ")}`,
      body: "These jobs have not completed successfully recently. Check the System page for errors.",
      dedupeKey: `alert:stalled:${stale.sort().join(",")}`,
    });
  }
  return stale.length ? `stale: ${stale.join(", ")}` : "all jobs healthy";
}

async function housekeeping(): Promise<string> {
  await query(`DELETE FROM health_checks WHERE checked_at < now() - interval '30 days'`);
  await query(`DELETE FROM job_runs WHERE started_at < now() - interval '30 days'`);
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
  return "pruned old records";
}

export const jobs: Job[] = [
  {
    name: "outbox",
    description: "Send queued emails",
    schedule: { everyMinutes: 1 },
    run: async () => {
      const r = await sendDueEmails();
      return `${r.sent} sent, ${r.failed} failed, ${r.held} held`;
    },
  },
  {
    name: "leads",
    description: "Reply to new enquiries and follow up",
    schedule: { everyMinutes: 5 },
    run: async () => {
      const r = await processLeads();
      return `${r.drafted} drafted, ${r.failed} failed`;
    },
  },
  { name: "onboarding", description: "Move customer onboarding forward", schedule: { everyMinutes: 5 }, run: onboardingTick },
  {
    name: "routines",
    description: "Create and run recurring customer deliverables",
    schedule: { everyMinutes: 30 },
    run: async () => {
      const r = await runRoutines();
      return `${r.created} created, ${r.ran} run`;
    },
  },
  { name: "health", description: "Check every product site is up", schedule: { everyMinutes: 5 }, run: checkSites },
  {
    name: "billing",
    description: "Pause customers with long-overdue payments",
    schedule: { everyMinutes: 60 },
    run: async () => `${await pauseOverdueCustomers()} paused`,
  },
  { name: "digest", description: "Daily quality-control email", schedule: { dailyAt: "07:30" }, run: sendDigest },
  { name: "watchdog", description: "Alert if any automation stalls", schedule: { everyMinutes: 15 }, run: watchdog },
  { name: "housekeeping", description: "Prune old logs", schedule: { dailyAt: "03:00" }, run: housekeeping },
];
