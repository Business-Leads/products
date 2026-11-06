// Reading an HQ backup back out of the mailbox it was emailed to (see snapshot.ts).
// Used by HQ itself (restoring on start) and by scripts/hq-snapshot.ts (workflows).
//
// Only emails the mailbox sent itself count (they are in its Sent Mail, from its own
// address), so nobody can slip a forged backup in by emailing it. A backup retried
// under the same name is told apart by its checksum: the newest complete set wins.
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

interface PartRef<T> {
  id: string;
  part: number;
  total: number;
  sha: string;
  date: number;
  item: T;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The newest complete set of parts for `id` ("latest": the newest id that has a complete set). */
function pickSet<T>(refs: PartRef<T>[], id: string): { id: string; parts: PartRef<T>[] } | null {
  const sets = new Map<string, PartRef<T>[]>();
  for (const r of refs) {
    if (id !== "latest" && r.id !== id) continue;
    const k = `${r.id}|${r.sha}|${r.total}`;
    sets.set(k, [...(sets.get(k) ?? []), r]);
  }
  const complete = [...sets.values()]
    .map((list) => {
      const byPart = new Map<number, PartRef<T>>();
      for (const r of list.sort((a, b) => a.date - b.date)) byPart.set(r.part, r); // newest copy of each part
      return [...byPart.values()].sort((a, b) => a.part - b.part);
    })
    .filter((parts) => parts.length === parts[0]!.total && parts.every((p, i) => p.part === i + 1));
  complete.sort((a, b) => (a[0]!.id === b[0]!.id ? Math.max(...a.map((p) => p.date)) - Math.max(...b.map((p) => p.date)) : a[0]!.id < b[0]!.id ? -1 : 1));
  const best = complete.at(-1);
  return best ? { id: best[0]!.id, parts: best } : null;
}

/** Joins the part emails of one backup and checks its checksum. */
export function joinSnapshot(mails: ParsedMail[], id = "latest"): Snapshot {
  const refs: PartRef<ParsedMail>[] = [];
  for (const mail of mails) {
    const s = SNAPSHOT_SUBJECT.exec(mail.subject ?? "");
    if (!s) continue;
    refs.push({ id: s[1]!, part: Number(s[2]), total: Number(s[3]), sha: String(mail.headers.get("x-hq-sha256") ?? ""), date: mail.date?.getTime() ?? 0, item: mail });
  }
  const set = pickSet(refs, id);
  if (!set) throw new Error(`Backup ${id} is not complete (found ${refs.filter((r) => id === "latest" || r.id === id).length} part email(s))`);
  const chunks: Buffer[] = [];
  let counts: Record<string, number> = {};
  for (const p of set.parts) {
    const att = p.item.attachments.find((a) => (a.filename ?? "").startsWith(`${set.id}.dump.part`));
    if (!att) throw new Error(`Part ${p.part} of ${set.id} has no backup attachment`);
    const c = p.item.attachments.find((a) => a.filename === `${set.id}.counts.json`);
    if (c) counts = JSON.parse(c.content.toString("utf8"));
    chunks.push(att.content);
  }
  const data = Buffer.concat(chunks);
  const got = sha(data);
  const expected = set.parts[0]!.sha;
  if (!expected) throw new Error(`Backup ${set.id} has no checksum`);
  if (got !== expected) throw new Error(`Backup ${set.id} checksum mismatch (got ${got}, expected ${expected})`);
  return { id: set.id, data, sha256: got, counts };
}

/** Finds a backup in the Gmail mailbox's Sent Mail and joins it. Waits up to about three minutes for parts still arriving. */
export async function fetchSnapshot(opts: { user: string; pass: string; host?: string; id?: string; log?: (s: string) => void }): Promise<Snapshot> {
  const id = opts.id || "latest";
  const log = opts.log ?? (() => {});
  const me = opts.user.toLowerCase();
  const client = new ImapFlow({ host: opts.host ?? "imap.gmail.com", port: 993, secure: true, auth: { user: opts.user, pass: opts.pass }, logger: false });
  await client.connect();
  try {
    const sent = (await client.list()).find((m) => m.specialUse === "\\Sent")?.path ?? "[Gmail]/Sent Mail";
    const lock = await client.getMailboxLock(sent);
    try {
      for (let attempt = 0; ; attempt++) {
        const uids = ((await client.search({ gmraw: "has:attachment hq-snapshot" }, { uid: true })) || []) as number[];
        const refs: PartRef<number>[] = [];
        if (uids.length) {
          for await (const m of client.fetch(uids, { envelope: true, headers: ["x-hq-sha256"] }, { uid: true })) {
            const s = SNAPSHOT_SUBJECT.exec(m.envelope?.subject ?? "");
            const from = m.envelope?.from?.[0]?.address?.toLowerCase();
            if (!s || from !== me) continue;
            const h = /x-hq-sha256:\s*([0-9a-f]{64})/i.exec(m.headers?.toString() ?? "")?.[1] ?? "";
            refs.push({ id: s[1]!, part: Number(s[2]), total: Number(s[3]), sha: h.toLowerCase(), date: m.envelope?.date ? new Date(m.envelope.date).getTime() : 0, item: m.uid });
          }
        }
        const set = pickSet(refs, id);
        if (set) {
          const mails: ParsedMail[] = [];
          for (const p of set.parts) {
            const msg = await client.fetchOne(String(p.item), { source: true }, { uid: true });
            if (msg && msg.source) mails.push(await simpleParser(msg.source));
          }
          return joinSnapshot(mails, set.id);
        }
        const mine = refs.filter((r) => id === "latest" || r.id === id);
        if (attempt >= 17) throw new Error(`Backup ${id} is not complete in the mailbox's Sent Mail (${mine.length} part email(s) found)`);
        log(`Found ${mine.length} part email(s) of ${id}, not a complete set yet; checking again shortly…`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
