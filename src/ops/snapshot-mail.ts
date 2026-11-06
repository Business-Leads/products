// Reading an HQ backup back out of the mailbox it was emailed to (see snapshot.ts).
// Used by HQ itself (restoring on start) and by scripts/hq-snapshot.ts (workflows).
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";

export const SNAPSHOT_SUBJECT = /^(hq-snapshot-\d{8}-\d{4}) part (\d+) of (\d+)$/;

export interface Snapshot {
  id: string;
  data: Buffer;
  sha256: string;
  /** Rows per table a restore must match. */
  counts: Record<string, number>;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Joins the part emails of one backup (the newest one in `mails` when id is "latest") and checks the checksum. */
export function joinSnapshot(mails: ParsedMail[], id = "latest"): Snapshot {
  const parsed = mails
    .map((mail) => ({ mail, s: SNAPSHOT_SUBJECT.exec(mail.subject ?? "") }))
    .filter((x): x is { mail: ParsedMail; s: RegExpExecArray } => Boolean(x.s));
  const wanted = id === "latest" ? parsed.map((x) => x.s[1]!).sort().at(-1) : id;
  const mine = parsed.filter((x) => x.s[1] === wanted);
  const total = Number(mine[0]?.s[3] ?? 0);
  const parts = new Map(mine.map((x) => [Number(x.s[2]), x.mail]));
  if (!wanted || !total || parts.size !== total) {
    throw new Error(`Backup ${wanted ?? id} is not complete (${parts.size} of ${total || "?"} parts)`);
  }
  const chunks: Buffer[] = [];
  let expected = "";
  let counts: Record<string, number> = {};
  for (let p = 1; p <= total; p++) {
    const mail = parts.get(p)!;
    const att = mail.attachments.find((a) => (a.filename ?? "").startsWith(`${wanted}.dump.part`));
    if (!att) throw new Error(`Part ${p} of ${wanted} has no backup attachment`);
    expected ||= String(mail.headers.get("x-hq-sha256") ?? "");
    const c = mail.attachments.find((a) => a.filename === `${wanted}.counts.json`);
    if (c) counts = JSON.parse(c.content.toString("utf8"));
    chunks.push(att.content);
  }
  const data = Buffer.concat(chunks);
  const got = sha(data);
  if (expected && got !== expected) throw new Error(`Backup ${wanted} checksum mismatch (got ${got}, expected ${expected})`);
  return { id: wanted, data, sha256: got, counts };
}

/** Finds a backup in a Gmail mailbox (all mail) and joins it. Waits up to about three minutes for parts still arriving. */
export async function fetchSnapshot(opts: { user: string; pass: string; host?: string; id?: string; log?: (s: string) => void }): Promise<Snapshot> {
  const id = opts.id || "latest";
  const log = opts.log ?? (() => {});
  const client = new ImapFlow({ host: opts.host ?? "imap.gmail.com", port: 993, secure: true, auth: { user: opts.user, pass: opts.pass }, logger: false });
  await client.connect();
  try {
    const all = (await client.list()).find((m) => m.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
    const lock = await client.getMailboxLock(all);
    try {
      for (let attempt = 0; ; attempt++) {
        const uids = ((await client.search({ gmraw: "has:attachment hq-snapshot" }, { uid: true })) || []) as number[];
        const found: { uid: number; id: string; part: number; total: number }[] = [];
        if (uids.length) {
          for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
            const s = SNAPSHOT_SUBJECT.exec(m.envelope?.subject ?? "");
            if (s) found.push({ uid: m.uid, id: s[1]!, part: Number(s[2]), total: Number(s[3]) });
          }
        }
        const wanted = id === "latest" ? found.map((f) => f.id).sort().at(-1) : id;
        const mine = found.filter((f) => f.id === wanted);
        const total = mine[0]?.total ?? 0;
        const have = new Set(mine.map((f) => f.part)).size;
        if (wanted && total && have === total) {
          const mails: ParsedMail[] = [];
          for (const f of mine) {
            const msg = await client.fetchOne(String(f.uid), { source: true }, { uid: true });
            if (msg && msg.source) mails.push(await simpleParser(msg.source));
          }
          return joinSnapshot(mails, wanted);
        }
        if (attempt >= 17) throw new Error(`Backup ${wanted ?? id} is not complete in the mailbox (${have} of ${total || "?"} parts)`);
        log(`Found ${have} of ${total || "?"} part(s) of ${wanted ?? "a backup"}; checking again shortly…`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
