import { config } from "../config.js";
import { one, pool, query } from "../db/index.js";
import { jobs, type Job } from "../jobs/index.js";
import { logEvent } from "../lib/events.js";
import { errorMessage, londonParts } from "../lib/util.js";

// An in-process scheduler. Each job takes a Postgres advisory lock while it
// runs, so running more than one app instance never double-sends anything.

function lockId(name: string): number {
  let h = 0;
  for (const ch of `hq-job:${name}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

export async function isDue(job: Job, now = new Date()): Promise<boolean> {
  const last = await one<{ started_at: Date }>(
    `SELECT started_at FROM job_runs WHERE job = $1 ORDER BY started_at DESC LIMIT 1`,
    [job.name],
  );
  if ("everyMinutes" in job.schedule) {
    if (!last) return true;
    return now.getTime() - new Date(last.started_at).getTime() >= job.schedule.everyMinutes * 60_000 - 5_000;
  }
  const [hh, mm] = job.schedule.dailyAt.split(":").map(Number);
  const t = londonParts(now);
  if (t.hour * 60 + t.minute < hh! * 60 + mm!) return false;
  if (!last) return true;
  const l = londonParts(new Date(last.started_at));
  return !(l.year === t.year && l.month === t.month && l.day === t.day);
}

export async function runJob(job: Job): Promise<string | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) AS got`, [lockId(job.name)]);
    if (!rows[0].got) return null;
    const run = await one<{ id: string }>(`INSERT INTO job_runs (job) VALUES ($1) RETURNING id`, [job.name]);
    try {
      const summary = await job.run();
      await query(`UPDATE job_runs SET status = 'ok', finished_at = now(), summary = $2 WHERE id = $1`, [run!.id, summary]);
      return summary;
    } catch (err) {
      await query(`UPDATE job_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`, [
        run!.id,
        errorMessage(err),
      ]);
      await logEvent({ type: "job.error", level: "error", message: `${job.name}: ${errorMessage(err)}` });
      return null;
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockId(job.name)]);
    }
  } finally {
    client.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const job of jobs) {
      if (await isDue(job)) await runJob(job);
    }
  } catch (err) {
    console.error("scheduler tick failed", err);
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  if (!config.scheduler.enabled || timer) return;
  timer = setInterval(tick, config.scheduler.tickSeconds * 1000);
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
