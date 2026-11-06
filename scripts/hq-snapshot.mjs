#!/usr/bin/env node
// Carries HQ's database backup to and from the owner's own Gmail mailbox.
// The repo is public, so the backup (which holds contact data) is never stored
// here or printed in a log: it travels as email attachments instead.
//
//   node scripts/hq-snapshot.mjs send  <id> <file> [notes-file]
//       splits <file> into 15 MB parts and emails each one to the mailbox,
//       subject "<id> part N of M"
//   node scripts/hq-snapshot.mjs fetch <id|latest> <out-file>
//       finds those emails in the mailbox, joins the parts and checks them
//
// Needs GMAIL_APP_PASSWORD; the mailbox is REPLY_MAILBOX (default info@felixclarke.com).
// Prints only sizes, part numbers and checksums.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const user = process.env.REPLY_MAILBOX || "info@felixclarke.com";
const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
if (!pass) throw new Error("GMAIL_APP_PASSWORD is not set");

const PART = 15 * 1024 * 1024; // Gmail takes 25 MB a message, and attachments grow by a third in transit.
const sha = (b) => createHash("sha256").update(b).digest("hex");
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const SUBJECT = /^(hq-snapshot-\d{8}-\d{4}) part (\d+) of (\d+)$/;

const [cmd, id, file, notesFile] = process.argv.slice(2);

if (cmd === "send") {
  if (!id || !file) throw new Error("usage: send <id> <file> [notes-file]");
  const data = readFileSync(file);
  const total = Math.max(1, Math.ceil(data.length / PART));
  const whole = sha(data);
  const notes = notesFile ? readFileSync(notesFile, "utf8") : "";
  const t = nodemailer.createTransport(`smtps://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@smtp.gmail.com:465`);
  for (let i = 0; i < total; i++) {
    const chunk = data.subarray(i * PART, (i + 1) * PART);
    const n = String(i + 1).padStart(2, "0");
    const r = await t.sendMail({
      from: `HQ snapshot <${user}>`,
      to: user,
      subject: `${id} part ${i + 1} of ${total}`,
      text:
        `This is part ${i + 1} of ${total} of a full backup of the HQ database (Online Business Builder), ` +
        `taken when HQ was shut down. Please keep every part of it; don't delete these emails.\n\n` +
        `Whole backup: ${mb(data.length)}, SHA-256 ${whole}\n\n` +
        `To bring HQ back, see RESTART.md in the Business-Leads/products repository. The "Restore HQ ` +
        `snapshot" workflow finds these emails by their subject and loads them for you.\n\n${notes}`,
      attachments: [{ filename: `${id}.dump.part${n}`, content: chunk, contentType: "application/octet-stream" }],
      headers: { "X-HQ-Snapshot": id, "X-HQ-Part": `${i + 1}/${total}`, "X-HQ-Sha256": whole },
    });
    if (!r.accepted?.length) throw new Error(`Gmail did not accept part ${i + 1}: ${r.response}`);
    console.log(`Emailed part ${i + 1} of ${total} (${mb(chunk.length)}): ${r.response}`);
  }
  console.log(`Backup ${id}: ${mb(data.length)} in ${total} part(s), SHA-256 ${whole}`);
} else if (cmd === "fetch") {
  if (!id || !file) throw new Error("usage: fetch <id|latest> <out-file>");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const all = (await client.list()).find((m) => m.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
    const lock = await client.getMailboxLock(all);
    try {
      // Newly sent parts can take a minute to show up in the mailbox.
      let parts = new Map();
      let wanted = id;
      let total = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const uids = (await client.search({ gmraw: "has:attachment hq-snapshot" }, { uid: true })) || [];
        const found = [];
        if (uids.length) for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
          const s = SUBJECT.exec(m.envelope?.subject ?? "");
          if (s) found.push({ uid: m.uid, id: s[1], part: Number(s[2]), total: Number(s[3]) });
        }
        if (id === "latest") wanted = found.map((f) => f.id).sort().at(-1);
        const mine = found.filter((f) => f.id === wanted);
        total = mine[0]?.total ?? 0;
        parts = new Map(mine.map((f) => [f.part, f]));
        if (total && parts.size === total) break;
        console.log(`Found ${parts.size} of ${total || "?"} part(s) of ${wanted ?? "a snapshot"}; checking again shortly…`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (!total || parts.size !== total) throw new Error(`Snapshot ${wanted ?? id} is not complete in the mailbox (${parts.size} of ${total || "?"} parts)`);
      const chunks = [];
      let expected;
      for (let p = 1; p <= total; p++) {
        const msg = await client.fetchOne(String(parts.get(p).uid), { source: true }, { uid: true });
        const mail = await simpleParser(msg.source);
        const att = mail.attachments.find((a) => (a.filename ?? "").startsWith(`${wanted}.dump.part`));
        if (!att) throw new Error(`Part ${p} has no backup attachment`);
        expected ??= String(mail.headers.get("x-hq-sha256") ?? "");
        chunks.push(att.content);
      }
      const data = Buffer.concat(chunks);
      const got = sha(data);
      if (expected && got !== expected) throw new Error(`Snapshot ${wanted} checksum mismatch (got ${got}, expected ${expected})`);
      writeFileSync(file, data);
      console.log(`Fetched ${wanted}: ${mb(data.length)} from ${total} part(s), SHA-256 ${got} (matches)`);
      if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `id=${wanted}\n`, { flag: "a" });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
} else {
  throw new Error("usage: hq-snapshot.mjs send|fetch …");
}
