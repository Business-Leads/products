// HQ backs up its own database before it is shut down (Nov 2026; see RESTART.md).
//
// HQ's data lives in a database only the app itself can reach, so the backup is
// made from inside: when SNAPSHOT_REQUEST below names a backup that hasn't been
// made yet, HQ pauses everything (Settings, Pause everything), runs pg_dump on its
// own schema and emails the file, in 15 MB parts, to its own Gmail mailbox (the
// login in SMTP_URL). The repo is public, so the backup never goes anywhere else.
// The "HQ snapshot" workflow then reads the parts back and test-restores them.
//
// Restoring works the same way round: when RESTORE_REQUEST names a backup, HQ
// fetches it from the mailbox's Sent Mail when it starts (only emails it sent
// itself count), loads it before setting up its tables, once, and starts paused.
//
// The database password is passed to pg_dump and pg_restore in the environment,
// never on the command line, so it can't appear in an error. Only sizes, counts
// and checksums are logged.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { pool, SCHEMA } from "../db/index.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { fetchSnapshot, type Snapshot } from "./snapshot-mail.js";

/** The backup to make. Change it to ask for a new one; "" turns this off. */
export const SNAPSHOT_REQUEST = "hq-snapshot-20261106-1503";

/**
 * The backup to load when HQ starts, by its exact name (e.g. "hq-snapshot-20261106-1440").
 * "" turns this off. It is loaded once: the database then remembers it.
 */
export const RESTORE_REQUEST = "";

const PART = 15 * 1024 * 1024; // Gmail takes 25 MB a message, and attachments grow by a third in transit.
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const run = promisify(execFile);

function pgTool(name: "pg_dump" | "pg_restore"): string {
  const p = `/usr/lib/postgresql/16/bin/${name}`; // the image installs postgresql-client-16
  return existsSync(p) ? p : name;
}

/** libpq settings for HQ's database, as environment variables, so the password never appears in argv or errors. */
function pgEnv(): NodeJS.ProcessEnv {
  const u = new URL(config.databaseUrl);
  const sslmode = u.searchParams.get("sslmode") ?? (process.env.DATABASE_CA_CERT || config.databaseSsl ? "require" : "prefer");
  return {
    ...process.env,
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGSSLMODE: sslmode,
  };
}

const hide = (s: string) => s.replace(/:\/\/[^@\s]*@/g, "://(hidden)@").replace(/(password=)\S+/gi, "$1(hidden)");
/** The useful end of a failure (a tool's own error output), never a password. */
function why(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; signal?: unknown };
  const text = String(e?.stderr || e?.message || err).trim();
  return hide(text).slice(-600) + (e?.signal ? ` (stopped by ${String(e.signal)})` : "");
}

async function counts(): Promise<Record<string, number>> {
  const tables = (
    await pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
      [SCHEMA],
    )
  ).rows.map((r) => r.t);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await pool.query(`SELECT count(*) AS n FROM "${SCHEMA}"."${t.replace(/"/g, "")}"`)).rows[0].n);
  return out;
}

/** The Gmail mailbox HQ sends as (SMTP_URL), or null if SMTP_URL isn't a Gmail login. The backup only ever goes there. */
function gmailMailbox(): string | null {
  if (!config.smtp.url || config.smtp.url === "log") return null;
  const u = new URL(config.smtp.url);
  const user = decodeURIComponent(u.username);
  return u.hostname === "smtp.gmail.com" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user) ? user : null;
}

async function fileSha(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function makeSnapshot(id: string): Promise<void> {
  const key = `snapshot:${id}`;
  const state = await getSetting<{ status?: string; at?: string } | null>(key, null);
  if (state?.status === "sent") return; // made already (a restored HQ is marked like this too)
  if (state?.status === "started" && Date.now() - Date.parse(state.at ?? "") < 15 * 60_000) {
    console.log(`HQ snapshot ${id}: another start began it at ${state.at}; leaving it to finish.`);
    return;
  }
  if ((await pool.query(`SELECT 1 FROM settings WHERE key LIKE 'restore:%' LIMIT 1`)).rowCount) {
    console.log(`HQ snapshot ${id}: this HQ was restored from a backup, so it doesn't make this one.`);
    return;
  }
  const mailbox = gmailMailbox();
  if (!mailbox) {
    console.log(`HQ snapshot ${id}: SMTP_URL isn't a Gmail login, so no backup was made (it only goes to HQ's own Gmail mailbox).`);
    return;
  }
  const version = Number((await pool.query(`SHOW server_version_num`)).rows[0].server_version_num);
  if (Math.floor(version / 10000) > 16) {
    console.log(`HQ snapshot ${id}: the database is Postgres ${Math.floor(version / 10000)} and this image has pg_dump 16; no backup was made.`);
    return;
  }

  // Recorded before the dump, so the backup itself knows it was made.
  await setSetting(key, { status: "started", at: new Date().toISOString() });
  await setSetting("paused:all", true);
  console.log(`HQ snapshot ${id}: HQ is paused; backing up schema ${SCHEMA} (Postgres ${Math.floor(version / 10000)}.${version % 10000}).`);

  const dir = await mkdtemp(path.join(os.tmpdir(), "hq-snapshot-"));
  try {
    const file = path.join(dir, "backup.dump");
    const before = await counts();
    await run(pgTool("pg_dump"), ["-Fc", "-Z", "6", "--no-owner", "--no-acl", "-n", SCHEMA, "-f", file], {
      env: pgEnv(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20 * 60_000,
    });
    const after = await counts();
    // Tables whose count didn't move while the dump ran must match exactly after a restore.
    const stable = Object.fromEntries(Object.entries(after).filter(([t, n]) => before[t] === n));
    const size = (await stat(file)).size;
    const whole = await fileSha(file);
    const total = Math.max(1, Math.ceil(size / PART));
    console.log(`HQ snapshot ${id}: dump is ${mb(size)}, ${total} part(s), SHA-256 ${whole}.`);
    const notes = `Rows per table at backup time:\n${Object.entries(after).map(([t, n]) => `  ${t} ${n}`).join("\n")}\n`;
    // Settings that exist only on the running app (generated by the deploy, not kept in GitHub),
    // so a restarted HQ can keep the same webhook addresses and dashboard password.
    const env = (k: string) => process.env[k]?.trim() || undefined;
    const appOnly = {
      note: "Values that existed only on the HQ app when it was shut down. See RESTART.md.",
      ADMIN_PASSWORD: env("ADMIN_PASSWORD"),
      SBL_WEBHOOK_TOKEN: env("SBL_WEBHOOK_TOKEN"),
      AWAZ_WEBHOOK_TOKEN: env("AWAZ_WEBHOOK_TOKEN"),
      sbl_webhook_address: env("SBL_WEBHOOK_TOKEN") && `${config.baseUrl}/webhooks/sbl/${env("SBL_WEBHOOK_TOKEN")}`,
      awaz_webhook_address: env("AWAZ_WEBHOOK_TOKEN") && `${config.baseUrl}/webhooks/awaz/${env("AWAZ_WEBHOOK_TOKEN")}`,
    };

    const transport = nodemailer.createTransport(config.smtp.url);
    const fh = await open(file, "r");
    try {
      for (let i = 0; i < total; i++) {
        // One part in memory at a time.
        const chunk = Buffer.alloc(Math.min(PART, size - i * PART));
        await fh.read(chunk, 0, chunk.length, i * PART);
        const r = await transport.sendMail({
          from: `HQ snapshot <${mailbox}>`,
          to: mailbox,
          subject: `${id} part ${i + 1} of ${total}`,
          text:
            `This is part ${i + 1} of ${total} of a full backup of the HQ database (Online Business Builder), ` +
            `taken when HQ was shut down. Please keep every part of it; don't delete these emails.\n\n` +
            `Whole backup: ${mb(size)}, SHA-256 ${whole}\n\n` +
            `To bring HQ back, see RESTART.md in the Business-Leads/products repository: HQ finds these ` +
            `emails by their subject and loads them itself.` +
            (i === 0 ? ` Part 1 also carries the settings that existed only on the HQ app (its dashboard password and webhook addresses), so keep it private.` : ``) +
            `\n\n${notes}`,
          attachments: [
            { filename: `${id}.dump.part${String(i + 1).padStart(2, "0")}`, content: chunk, contentType: "application/octet-stream" },
            ...(i === 0
              ? [
                  // Rows per table a restore must match (tables that didn't change during the dump).
                  { filename: `${id}.counts.json`, content: JSON.stringify(stable), contentType: "application/json" },
                  { filename: `${id}.app-settings.json`, content: JSON.stringify(appOnly, null, 2), contentType: "application/json" },
                ]
              : []),
          ],
          headers: { "X-HQ-Snapshot": id, "X-HQ-Part": `${i + 1}/${total}`, "X-HQ-Sha256": whole },
        });
        if (!r.accepted?.length) throw new Error(`Gmail didn't accept part ${i + 1}`);
        console.log(`HQ snapshot ${id}: emailed part ${i + 1} of ${total} (${mb(chunk.length)}).`);
      }
    } finally {
      await fh.close();
    }
    await setSetting(key, { status: "sent", at: new Date().toISOString(), bytes: size, parts: total, sha256: whole, tables: Object.keys(after).length });
    console.log(`HQ snapshot ${id}: done, ${mb(size)} in ${total} part(s), SHA-256 ${whole}, ${Object.keys(after).length} tables.`);
  } catch (err) {
    // Cleared, so the next start tries again. HQ stays paused.
    await pool.query(`DELETE FROM settings WHERE key = $1`, [key]).catch(() => {});
    console.log(`HQ snapshot ${id}: failed, HQ stays paused (${why(err)})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The Gmail login HQ reads its mail with (IMAP_URL, else the SMTP_URL login when that is Gmail). */
function mailboxLogin(): { user: string; pass: string; host: string } | null {
  for (const raw of [config.imap.url, config.smtp.url]) {
    if (!raw || raw === "log") continue;
    const u = new URL(raw);
    if (!u.username || !u.password) continue;
    const login = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
    if (u.protocol.startsWith("imap")) return { ...login, host: u.hostname };
    if (u.hostname === "smtp.gmail.com") return { ...login, host: "imap.gmail.com" };
  }
  return null;
}

/**
 * Loads a backup into HQ's database. Runs on start, before the tables are set up.
 * Throws (so HQ doesn't carry on with an empty database, unpaused) if it can't.
 */
export async function restoreSnapshot(request: string): Promise<void> {
  const hasSettings = Boolean((await pool.query(`SELECT to_regclass($1) AS t`, [`"${SCHEMA}".settings`])).rows[0].t);
  const loaded = async (id: string) =>
    hasSettings && Boolean((await pool.query(`SELECT 1 FROM "${SCHEMA}".settings WHERE key = $1`, [`restore:${id}`])).rowCount);
  if (await loaded(request)) return;
  if (request === "latest" && hasSettings && (await pool.query(`SELECT 1 FROM "${SCHEMA}".settings WHERE key LIKE 'restore:%' LIMIT 1`)).rowCount) return;
  // Never over a live HQ: only a database with no customers, leads or prospects yet is replaced.
  for (const t of ["customers", "leads", "prospects", "prospect_db", "inbound_emails"]) {
    const exists = (await pool.query(`SELECT to_regclass($1) AS t`, [`"${SCHEMA}".${t}`])).rows[0].t;
    if (exists && (await pool.query(`SELECT 1 FROM "${SCHEMA}"."${t}" LIMIT 1`)).rowCount) {
      console.log(`HQ restore: this database already has ${t}, so ${request} was NOT loaded over it. Set RESTORE_REQUEST to "" (see RESTART.md).`);
      return;
    }
  }
  const login = mailboxLogin();
  if (!login) throw new Error("HQ restore: no Gmail login (IMAP_URL, or SMTP_URL for smtp.gmail.com), so the backup can't be fetched. Check the GMAIL_APP_PASSWORD secret and run Deploy again.");
  const snap = await fetchSnapshot({ ...login, id: request, log: (s) => console.log(`HQ restore: ${s}`) });
  await loadSnapshot(snap);
}

/** pg_restore a fetched backup into HQ's database (replacing what is there), check the row counts and pause HQ. */
export async function loadSnapshot(snap: Snapshot): Promise<void> {
  console.log(`HQ restore: loading ${snap.id} (${mb(snap.data.length)}, SHA-256 ${snap.sha256}).`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "hq-restore-"));
  try {
    const file = path.join(dir, "backup.dump");
    await writeFile(file, snap.data);
    // Anything already there (say from a start without the restore) goes first, so the backup loads cleanly.
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    // One transaction: either the whole backup goes in, or nothing does (and the next start tries again).
    const env = pgEnv();
    await run(pgTool("pg_restore"), ["--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", "-d", env.PGDATABASE!, file], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20 * 60_000,
    });
    const now = await counts();
    const wrong = Object.entries(snap.counts).filter(([t, n]) => now[t] !== n).map(([t, n]) => `${t} ${now[t] ?? "missing"} not ${n}`);
    await setSetting(`restore:${snap.id}`, { at: new Date().toISOString(), sha256: snap.sha256, mismatches: wrong });
    // A restored HQ never makes the backup it came from again.
    await setSetting(`snapshot:${snap.id}`, { status: "sent", restored: true });
    await setSetting("paused:all", true);
    console.log(
      `HQ restore: ${snap.id} loaded, ${Object.keys(now).length} tables` +
        (wrong.length ? `; rows differ from the backup's own count in: ${wrong.join(", ")}` : ", every row count matches") +
        ". HQ is paused until switched back on in Settings.",
    );
  } catch (err) {
    throw new Error(`HQ restore: failed (${why(err)})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
