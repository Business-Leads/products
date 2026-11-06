// HQ backs up its own database before it is shut down (Nov 2026; see RESTART.md).
//
// HQ's data lives in a database only the app itself can reach, so the backup is
// made from inside: when SNAPSHOT_REQUEST below names a backup that hasn't been
// made yet, HQ pauses everything (Settings, Pause everything), runs pg_dump on its
// own schema and emails the file, in 15 MB parts, to its own mailbox (the Gmail
// account in SMTP_URL). The repo is public, so the backup never goes anywhere else.
// The "HQ snapshot" workflow then reads the parts back from the mailbox and
// test-restores them (snapshot-mail.ts reads them).
//
// Restoring works the same way round: when RESTORE_REQUEST names a backup (or
// "latest"), HQ fetches it from the mailbox on start, before anything else, and
// loads it into its own database, once. The restored HQ starts paused.
// Only sizes, counts and checksums are logged.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { pool, SCHEMA } from "../db/index.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { fetchSnapshot, type Snapshot } from "./snapshot-mail.js";

/** The backup to make. Change it to ask for a new one; "" turns this off. */
export const SNAPSHOT_REQUEST = ""; // set to "hq-snapshot-20261106-1440" once reviewed

/**
 * The backup to load when HQ starts: a name such as "hq-snapshot-20261106-1440", or
 * "latest". "" turns this off. It is loaded once (the database then remembers it).
 */
export const RESTORE_REQUEST = "";

const PART = 15 * 1024 * 1024; // Gmail takes 25 MB a message, and attachments grow by a third in transit.
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const run = promisify(execFile);

function pgTool(name: "pg_dump" | "pg_restore"): string {
  for (const v of ["18", "17", "16"]) {
    const p = `/usr/lib/postgresql/${v}/bin/${name}`;
    if (existsSync(p)) return p;
  }
  return name;
}
const hide = (s: string) => s.replace(/:\/\/[^@\s]*@/g, "://(hidden)@").slice(0, 300);

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

export async function makeSnapshot(id: string): Promise<void> {
  const key = `snapshot:${id}`;
  const state = await getSetting<{ status?: string } | null>(key, null);
  if (state) return; // already made (or under way) for this request
  if (!config.smtp.url || config.smtp.url === "log") {
    console.log(`HQ snapshot ${id}: no mail server, so no backup was made.`);
    return;
  }
  const mailbox = decodeURIComponent(new URL(config.smtp.url).username) || config.admin.alertEmail;

  // Recorded before the dump, so a restored HQ knows this backup was made and doesn't make it again.
  await setSetting(key, { status: "started", at: new Date().toISOString() });
  await setSetting("paused:all", true);
  console.log(`HQ snapshot ${id}: HQ is paused; backing up schema ${SCHEMA}.`);

  const dir = await mkdtemp(path.join(os.tmpdir(), "hq-snapshot-"));
  try {
    const file = path.join(dir, "backup.dump");
    const before = await counts();
    await run(pgTool("pg_dump"), ["-Fc", "-Z", "9", "--no-owner", "--no-acl", "-n", SCHEMA, "-f", file, "-d", config.databaseUrl], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    const after = await counts();
    // Tables whose count didn't move while the dump ran must match exactly after a restore.
    const stable = Object.fromEntries(Object.entries(after).filter(([t, n]) => before[t] === n));
    const data = await readFile(file);
    const whole = sha(data);
    const total = Math.max(1, Math.ceil(data.length / PART));
    const notes =
      `Rows per table at backup time:\n${Object.entries(after).map(([t, n]) => `  ${t} ${n}`).join("\n")}\n`;

    const transport = nodemailer.createTransport(config.smtp.url);
    for (let i = 0; i < total; i++) {
      const chunk = data.subarray(i * PART, (i + 1) * PART);
      const r = await transport.sendMail({
        from: `HQ snapshot <${mailbox}>`,
        to: mailbox,
        subject: `${id} part ${i + 1} of ${total}`,
        text:
          `This is part ${i + 1} of ${total} of a full backup of the HQ database (Online Business Builder), ` +
          `taken when HQ was shut down. Please keep every part of it; don't delete these emails.\n\n` +
          `Whole backup: ${mb(data.length)}, SHA-256 ${whole}\n\n` +
          `To bring HQ back, see RESTART.md in the Business-Leads/products repository. The "Restore HQ ` +
          `snapshot" workflow finds these emails by their subject and loads them for you.\n\n${notes}`,
        attachments: [
          { filename: `${id}.dump.part${String(i + 1).padStart(2, "0")}`, content: chunk, contentType: "application/octet-stream" },
          // Rows per table a restore must match (tables that didn't change during the dump).
          ...(i === 0 ? [{ filename: `${id}.counts.json`, content: JSON.stringify(stable), contentType: "application/json" }] : []),
        ],
        headers: { "X-HQ-Snapshot": id, "X-HQ-Part": `${i + 1}/${total}`, "X-HQ-Sha256": whole },
      });
      if (!r.accepted?.length) throw new Error(`the mail server didn't accept part ${i + 1}`);
      console.log(`HQ snapshot ${id}: emailed part ${i + 1} of ${total} (${mb(chunk.length)}).`);
    }
    await setSetting(key, { status: "sent", at: new Date().toISOString(), bytes: data.length, parts: total, sha256: whole, tables: Object.keys(after).length });
    console.log(`HQ snapshot ${id}: done, ${mb(data.length)} in ${total} part(s), SHA-256 ${whole}, ${Object.keys(after).length} tables.`);
  } catch (err) {
    // Cleared, so the next start tries again.
    await pool.query(`DELETE FROM settings WHERE key = $1`, [key]).catch(() => {});
    console.log(`HQ snapshot ${id}: failed (${hide((err as Error).message)})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The Gmail login HQ reads its mail with (IMAP_URL, else the SMTP_URL login for Gmail). */
function mailboxLogin(): { user: string; pass: string; host: string } | null {
  for (const raw of [config.imap.url, config.smtp.url]) {
    if (!raw || raw === "log") continue;
    const u = new URL(raw);
    if (!u.username || !u.password) continue;
    const host = u.protocol.startsWith("imap") ? u.hostname : u.hostname.replace(/^smtp\./, "imap.");
    return { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), host };
  }
  return null;
}

/** Loads a backup into HQ's database. Runs on start, before the tables are set up. */
export async function restoreSnapshot(request: string): Promise<void> {
  const done = async (id: string) =>
    (await pool.query(`SELECT to_regclass($1) AS t`, [`"${SCHEMA}".settings`])).rows[0].t &&
    (await pool.query(`SELECT 1 FROM "${SCHEMA}".settings WHERE key = $1`, [`restore:${id}`])).rowCount;
  if (request !== "latest" && (await done(request))) return;
  const login = mailboxLogin();
  if (!login) {
    console.log("HQ restore: no mailbox login (IMAP_URL or SMTP_URL), so nothing was restored.");
    return;
  }
  const snap = await fetchSnapshot({ ...login, id: request, log: (s) => console.log(`HQ restore: ${s}`) });
  if (await done(snap.id)) return;
  await loadSnapshot(snap);
}

/** pg_restore a fetched backup into HQ's database, check the row counts and pause HQ. */
export async function loadSnapshot(snap: Snapshot): Promise<void> {
  console.log(`HQ restore: loading ${snap.id} (${mb(snap.data.length)}, SHA-256 ${snap.sha256}).`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "hq-restore-"));
  try {
    const file = path.join(dir, "backup.dump");
    await import("node:fs/promises").then((fs) => fs.writeFile(file, snap.data));
    // One transaction: either the whole backup goes in, or nothing changes.
    await run(pgTool("pg_restore"), ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", "-d", config.databaseUrl, file], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
    const now = await counts();
    const wrong = Object.entries(snap.counts).filter(([t, n]) => now[t] !== n).map(([t, n]) => `${t} ${now[t] ?? "missing"} not ${n}`);
    await setSetting(`restore:${snap.id}`, { at: new Date().toISOString(), sha256: snap.sha256, mismatches: wrong });
    await setSetting("paused:all", true);
    console.log(
      `HQ restore: ${snap.id} loaded, ${Object.keys(now).length} tables` +
        (wrong.length ? `; rows differ from the backup's own count in: ${wrong.join(", ")}` : ", every row count matches") +
        ". HQ is paused until switched back on in Settings.",
    );
  } catch (err) {
    console.log(`HQ restore: failed (${hide((err as Error).message)})`);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
