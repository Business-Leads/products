// Reads an HQ backup back out of the owner's mailbox (see src/ops/snapshot.ts).
//
//   npx tsx scripts/hq-snapshot.ts fetch <id|latest> <out-file>
//       finds the parts in Gmail and joins them. Needs GMAIL_APP_PASSWORD; the
//       mailbox is REPLY_MAILBOX (default info@felixclarke.com).
//   npx tsx scripts/hq-snapshot.ts join <out-file> <part.eml> [<part.eml> ...]
//       the same from emails saved as files (in Gmail: open each part, ⋮, Download message).
//
// Writes <out-file> (a pg_dump file: restore it with pg_restore) and
// <out-file>.counts.json (rows per table a restore must match). Prints only
// sizes, part numbers and checksums.
import { readFileSync, writeFileSync } from "node:fs";
import { simpleParser } from "mailparser";
import { fetchSnapshot, joinSnapshot, type Snapshot } from "../src/ops/snapshot-mail.js";

function save(s: Snapshot, out: string) {
  writeFileSync(out, s.data);
  writeFileSync(`${out}.counts.json`, JSON.stringify(s.counts));
  console.log(`Backup ${s.id}: ${(s.data.length / 1048576).toFixed(1)} MB, SHA-256 ${s.sha256} (matches), ${Object.keys(s.counts).length} tables to check`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `id=${s.id}\n`, { flag: "a" });
}

const [cmd, a, b, ...more] = process.argv.slice(2);
if (cmd === "fetch" && a && b) {
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!pass) throw new Error("GMAIL_APP_PASSWORD is not set");
  save(await fetchSnapshot({ user: process.env.REPLY_MAILBOX || "info@felixclarke.com", pass, id: a, log: console.log }), b);
} else if (cmd === "join" && a && b) {
  save(joinSnapshot(await Promise.all([b, ...more].map((f) => simpleParser(readFileSync(f))))), a);
} else {
  throw new Error("usage: hq-snapshot.ts fetch <id|latest> <out-file> | join <out-file> <part.eml> ...");
}
