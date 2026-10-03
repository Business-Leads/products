import { createReadStream } from "node:fs";
import { one, query } from "../db/index.js";
import { setSetting } from "../lib/settings.js";

// Our own UK prospect database. The master prospect file (a CSV) is uploaded
// once in HQ and loaded here; EmailFirst and Good Questions then pick each
// client's contacts from it: matching their audience, never suppressed, never
// twice for the same client, and rested between clients.

const COLUMNS: [keyof Row, RegExp][] = [
  ["email", /^(e-?mail|email ?address|work ?email)$/i],
  ["first_name", /^(first ?name|forename|fname|given ?name)$/i],
  ["last_name", /^(last ?name|surname|lname|family ?name)$/i],
  ["company", /^(company|company ?name|organisation|organization|business|business ?name|employer)$/i],
  ["title", /^(title|job ?title|position|role|job|designation)$/i],
  ["sector", /^(sector|industry|sic|sic ?description|category|trade)$/i],
  ["region", /^(region|county|city|town|location|area|postcode|post ?code|country)$/i],
  ["company_type", /^(company ?type|legal ?form|entity ?type|type)$/i],
];

interface Row {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  sector?: string;
  region?: string;
  company_type?: string;
  extra: Record<string, string>;
}

/** Map a header row to our columns; anything else is kept as extra fields. */
export function mapHeader(header: string[]): (keyof Row | null)[] {
  const used = new Set<string>();
  return header.map((h) => {
    const name = h.trim();
    const hit = COLUMNS.find(([col, re]) => !used.has(col) && re.test(name));
    if (!hit) return null;
    used.add(hit[0]);
    return hit[0];
  });
}

/** A streaming CSV reader (quotes, escaped quotes, CRLF), so large files never sit in memory. */
export async function* csvRecords(path: string): AsyncGenerator<string[]> {
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    for (const ch of chunk as string) {
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field.replace(/\r$/, ""));
        field = "";
        if (row.some((c) => c.trim())) yield row;
        row = [];
      } else field += ch;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((c) => c.trim())) yield row;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Load (or refresh) the database from a CSV file. Existing contacts keep their send history. */
export async function importProspectFile(path: string, onProgress?: (n: number) => Promise<void>): Promise<{ imported: number; skipped: number; columns: string[] }> {
  let mapping: (keyof Row | null)[] | undefined;
  let header: string[] = [];
  let batch: Row[] = [];
  let imported = 0;
  let skipped = 0;
  const flush = async () => {
    if (!batch.length) return;
    const values: unknown[] = [];
    const rows = batch.map((r, i) => {
      values.push(r.email, r.first_name ?? null, r.last_name ?? null, r.company ?? null, r.title ?? null, r.sector ?? null, r.region ?? null, r.company_type ?? null, JSON.stringify(r.extra));
      const b = i * 9;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb)`;
    });
    await query(
      `INSERT INTO prospect_db (email, first_name, last_name, company, title, sector, region, company_type, extra) VALUES ${rows.join(",")}
       ON CONFLICT (lower(email)) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, company = EXCLUDED.company,
         title = EXCLUDED.title, sector = EXCLUDED.sector, region = EXCLUDED.region, company_type = EXCLUDED.company_type, extra = EXCLUDED.extra`,
      values,
    );
    imported += batch.length;
    batch = [];
    if (onProgress && imported % 20000 < 500) await onProgress(imported);
  };
  const seen = new Set<string>();
  for await (const rec of csvRecords(path)) {
    if (!mapping) {
      header = rec;
      mapping = mapHeader(rec);
      if (!mapping.includes("email")) throw new Error(`No email column found. Columns: ${rec.join(", ")}`);
      continue;
    }
    const r: Row = { email: "", extra: {} };
    rec.forEach((v, i) => {
      const col = mapping![i];
      const val = v.trim();
      if (!val) return;
      if (col === "extra" || col === null || col === undefined) r.extra[header[i] ?? `col${i}`] = val.slice(0, 300);
      else (r as any)[col] = val.slice(0, 300);
    });
    const email = r.email.toLowerCase();
    if (!EMAIL.test(email) || seen.has(email)) {
      skipped++;
      continue;
    }
    seen.add(email);
    r.email = email;
    batch.push(r);
    if (batch.length >= 500) await flush();
  }
  await flush();
  return { imported, skipped, columns: header };
}

export interface AudienceFilter {
  /** Job title words, any of which must appear in the title (empty = any title). */
  titles: string[];
  /** Sector/industry words, any of which must appear in sector or extra fields (empty = any). */
  sectors: string[];
  /** Places, any of which must appear in region or extra fields (empty = anywhere in the UK). */
  regions: string[];
  /** Words that rule a contact out (titles, sectors or companies). */
  exclude: string[];
}

function anyLike(column: string, words: string[], params: unknown[]): string {
  if (!words.length) return "TRUE";
  const parts = words.map((w) => {
    params.push(`%${w.replace(/[%_\\]/g, "")}%`);
    return `${column} ILIKE $${params.length}`;
  });
  return `(${parts.join(" OR ")})`;
}

function whereFor(f: AudienceFilter, customerId: string, restDays: number, params: unknown[]): string {
  params.push(customerId, restDays);
  const cust = params.length - 1;
  const rest = params.length;
  const exclude = f.exclude.length
    ? `NOT ${anyLike("(coalesce(p.title,'') || ' ' || coalesce(p.sector,'') || ' ' || coalesce(p.company,''))", f.exclude, params)}`
    : "TRUE";
  return `
    ${anyLike("p.title", f.titles, params)}
    AND ${anyLike("(coalesce(p.sector,'') || ' ' || p.extra::text)", f.sectors, params)}
    AND ${anyLike("(coalesce(p.region,'') || ' ' || p.extra::text)", f.regions, params)}
    AND ${exclude}
    AND (p.last_used_at IS NULL OR p.last_used_at < now() - make_interval(days => $${rest}))
    AND NOT EXISTS (SELECT 1 FROM prospect_uses u WHERE u.prospect_id = p.id AND u.customer_id = $${cust})
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.value = lower(p.email) OR s.value = '@' || split_part(lower(p.email), '@', 2))`;
}

export async function countMatches(f: AudienceFilter, customerId: string, restDays = 14): Promise<number> {
  const params: unknown[] = [];
  const row = await one<{ n: number }>(`SELECT count(*)::int AS n FROM prospect_db p WHERE ${whereFor(f, customerId, restDays, params)}`, params);
  return row?.n ?? 0;
}

export interface Picked {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
}

/** Pick and reserve today's contacts for a client. */
export async function pickProspects(f: AudienceFilter, customerId: string, n: number, batch: string, restDays = 14): Promise<Picked[]> {
  const params: unknown[] = [];
  const where = whereFor(f, customerId, restDays, params);
  params.push(n);
  const rows = await query<Picked>(
    `SELECT p.id, p.email, p.first_name, p.last_name, p.company, p.title FROM prospect_db p WHERE ${where} ORDER BY random() LIMIT $${params.length}`,
    params,
  );
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await query(`UPDATE prospect_db SET last_used_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
    await query(
      `INSERT INTO prospect_uses (prospect_id, customer_id, batch) SELECT unnest($1::bigint[]), $2, $3 ON CONFLICT DO NOTHING`,
      [ids, customerId, batch],
    );
  }
  return rows;
}

export async function databaseSize(): Promise<number> {
  return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM prospect_db`))?.n ?? 0;
}

export async function recordImportStatus(status: Record<string, unknown>): Promise<void> {
  await setSetting("prospect_db:import", { ...status, at: new Date().toISOString() });
}

// ------------------------------------------------ sync from Business Leads

/**
 * Everything Business Leads has loaded into Mailpulse since the master file:
 * every list's contacts are merged into the database (keeping the master file's
 * details, adding the list name so audiences like "saas" or "contractors" can be
 * matched), and anyone unsubscribed or blacklisted goes on the do-not-contact list.
 * Lists already synced are skipped unless their size changed. HQ's own sending
 * lists (EF | / GQ |) are skipped.
 */
export async function syncFromMailpulse(): Promise<string> {
  const { allLists, listSubscribers } = await import("../integrations/mailwizz.js");
  const { getSetting } = await import("../lib/settings.js");
  const done = await getSetting<Record<string, number>>("prospect_db:synced_lists", {});
  let lists = 0;
  let contacts = 0;
  let suppressed = 0;
  for (const list of await allLists()) {
    if (/^(EF|GQ) \|/.test(list.name)) continue;
    let page = 1;
    let seen = 0;
    const first = await listSubscribers(list.uid, 1);
    if (done[list.uid] !== undefined && done[list.uid] === first.records.length && !first.more) continue;
    let batch = first;
    for (;;) {
      const keep = batch.records.filter((s) => EMAIL.test(s.EMAIL.trim().toLowerCase()));
      const bad = keep.filter((s) => /unsubscribed|blacklisted/.test(s.status));
      for (const s of bad) {
        await query(`INSERT INTO suppressions (value, reason) VALUES ($1, $2) ON CONFLICT (value) DO NOTHING`, [s.EMAIL.trim().toLowerCase(), "Unsubscribed in Mailpulse"]);
      }
      suppressed += bad.length;
      const good = keep.filter((s) => !/unsubscribed|blacklisted/.test(s.status));
      for (let i = 0; i < good.length; i += 500) {
        const chunk = good.slice(i, i + 500);
        const values: unknown[] = [];
        const rows = chunk.map((s, j) => {
          values.push(s.EMAIL.trim().toLowerCase(), s.FNAME || null, s.LNAME || null, s.COMPANY || null, s.TITLE || null, JSON.stringify({ lists: [list.name] }));
          const b = j * 6;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb)`;
        });
        await query(
          `INSERT INTO prospect_db (email, first_name, last_name, company, title, extra) VALUES ${rows.join(",")}
           ON CONFLICT (lower(email)) DO UPDATE SET
             first_name = COALESCE(prospect_db.first_name, EXCLUDED.first_name),
             last_name = COALESCE(prospect_db.last_name, EXCLUDED.last_name),
             company = COALESCE(prospect_db.company, EXCLUDED.company),
             title = COALESCE(prospect_db.title, EXCLUDED.title),
             extra = prospect_db.extra || jsonb_build_object('lists',
               (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(COALESCE(prospect_db.extra->'lists', '[]'::jsonb) || (EXCLUDED.extra->'lists')) v))`,
          values,
        );
        contacts += chunk.length;
      }
      seen += batch.records.length;
      if (!batch.more) break;
      batch = await listSubscribers(list.uid, ++page);
    }
    done[list.uid] = page === 1 ? seen : -1; // multi-page lists are re-checked each night
    lists++;
  }
  await setSetting("prospect_db:synced_lists", done);
  return `${lists} list(s) synced: ${contacts} contacts merged, ${suppressed} unsubscribed added to do-not-contact`;
}
