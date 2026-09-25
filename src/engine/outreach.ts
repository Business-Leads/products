import { one, query } from "../db/index.js";
import { claudeConfigured, draftJson, emailSchema, type EmailDraft } from "../lib/claude.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { getSetting, isProductPaused } from "../lib/settings.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage, londonParts } from "../lib/util.js";
import { products, requireProduct, type Product } from "../products/index.js";

// Outbound prospecting. Deliberately conservative, because it writes to
// people who haven't asked to hear from us:
// - off until switched on per product, with a small daily cap;
// - by default only corporate subscribers (limited companies, LLPs, PLCs,
//   public bodies). Under PECR, sole traders and partnerships need consent;
// - every email identifies the sender and offers a one-word opt-out, and
//   anyone who opts out goes on a permanent suppression list;
// - weekdays, working hours, UK time.

export interface OutreachSettings {
  enabled: boolean;
  dailyCap: number;
  /** Also email prospects whose company type couldn't be determined. */
  allowUnknown: boolean;
  /** Days after the first email on which each follow-up is sent. */
  days: number[];
}

export const DEFAULT_OUTREACH: OutreachSettings = { enabled: false, dailyCap: 20, allowUnknown: false, days: [0, 4, 10] };

export async function outreachSettings(product: string): Promise<OutreachSettings> {
  return { ...DEFAULT_OUTREACH, ...(await getSetting<Partial<OutreachSettings>>(`outreach:${product}`, {})) };
}

const CORPORATE = ["limited", "llp", "plc", "public_sector"];

/** What the first cold email for each product should lead with. */
const ANGLES: Record<string, string> = {
  firstpagelocal:
    "Offer to show them whether ChatGPT, Gemini and Google's AI recommend their business for the searches their " +
    "customers use locally. Invite them to reply with the searches that matter to them; don't claim to have scanned them.",
  linkn:
    "Suggest their LinkedIn profile could bring them conversations with the buyers they want, written in their own " +
    "voice. Offer a free profile review.",
  speedtolead:
    "Point out that trades lose jobs to missed calls while they're on the tools, and that every missed call can be " +
    "answered, booked and passed to them. Ask how they handle calls they can't take.",
  emailfirst:
    "Offer a free pitch check: we'll tell them honestly whether their offer would land with UK decision makers by email.",
  goodquestions:
    "Offer to learn something useful about their sector through a short sponsored assessment of UK decision makers.",
};

export function normaliseCompanyType(type: string | undefined, business: string | undefined): string {
  const t = (type ?? "").toLowerCase();
  const b = (business ?? "").toLowerCase();
  if (/sole|self.?employed|individual/.test(t)) return "sole_trader";
  if (/partnership/.test(t) && !/llp|limited liability/.test(t)) return "partnership";
  if (/llp|limited liability/.test(t) || /\bllp\b/.test(b)) return "llp";
  if (/plc|public limited/.test(t) || /\bplc\b/.test(b)) return "plc";
  if (/ltd|limited|private|company/.test(t) || /\b(ltd|limited)\b\.?$/.test(b.trim()) || /\bltd\b/.test(b)) return "limited";
  if (/council|nhs|public sector|school|university|government/.test(t)) return "public_sector";
  return "unknown";
}

/** Minimal CSV parser (quoted fields, commas, newlines in quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export async function isSuppressed(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const domain = "@" + e.split("@")[1];
  return Boolean(await one(`SELECT 1 FROM suppressions WHERE value = $1 OR value = $2`, [e, domain]));
}

export async function suppress(value: string, reason: string): Promise<void> {
  const v = value.trim().toLowerCase();
  if (!v) return;
  await query(`INSERT INTO suppressions (value, reason) VALUES ($1,$2) ON CONFLICT (value) DO NOTHING`, [v, reason]);
  const where = v.startsWith("@") ? `lower(email) LIKE '%' || $1` : `lower(email) = $1`;
  await query(`UPDATE prospects SET status = 'suppressed', next_send_at = NULL, updated_at = now() WHERE ${where}`, [v]);
  await query(
    `UPDATE emails SET status = 'cancelled' WHERE status IN ('draft','queued') AND prospect_id IS NOT NULL AND ${where.replace("email", "to_address")}`,
    [v],
  );
}

export async function importProspects(
  productSlug: string,
  csv: string,
  source: string,
): Promise<{ added: number; duplicates: number; invalid: number; suppressed: number }> {
  const product = requireProduct(productSlug);
  let added = 0;
  let duplicates = 0;
  let invalid = 0;
  let suppressed = 0;
  for (const r of parseCsv(csv)) {
    const email = (r.email ?? r.email_address ?? r.work_email ?? "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalid++;
      continue;
    }
    if (await isSuppressed(email)) {
      suppressed++;
      continue;
    }
    const name = r.name || [r.first_name, r.last_name].filter(Boolean).join(" ") || null;
    const business = r.business || r.company || r.company_name || r.organisation || r.organization || null;
    const known = new Set(["email", "email_address", "work_email", "name", "first_name", "last_name", "business", "company",
      "company_name", "organisation", "organization", "company_type", "type", "website", "town", "city"]);
    const data = Object.fromEntries(Object.entries(r).filter(([k, v]) => !known.has(k) && v));
    if (r.first_name) data.first_name = r.first_name;
    const row = await one(
      `INSERT INTO prospects (product, email, name, business, company_type, website, town, data, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (product, email) DO NOTHING RETURNING id`,
      [
        product.slug,
        email,
        name,
        business,
        normaliseCompanyType(r.company_type || r.type, business ?? undefined),
        r.website || null,
        r.town || r.city || null,
        data,
        source || "import",
      ],
    );
    if (row) added++;
    else duplicates++;
  }
  await logEvent({
    type: "outreach.import",
    message: `Imported ${added} ${product.name} prospects (${duplicates} duplicates, ${invalid} invalid, ${suppressed} on the do-not-contact list)`,
    product: product.slug,
  });
  return { added, duplicates, invalid, suppressed };
}

async function draftOutreach(product: Product, p: any, step: number, total: number): Promise<EmailDraft> {
  const facts = [
    p.name && `Name: ${p.name}`,
    p.business && `Business: ${p.business}`,
    p.town && `Town: ${p.town}`,
    p.website && `Website: ${p.website}`,
    ...Object.entries(p.data ?? {}).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean);
  return draftJson<EmailDraft>({
    system:
      `You write short, honest cold emails for ${product.name}. ${product.description}\n\nVoice: ${product.voice}\n` +
      "Rules: under 120 words; one clear question or call to action; no attachments, links other than the one given, " +
      "or claims you can't support from the facts provided; never pretend to know things about them that aren't in " +
      "the facts; plain text; a specific, unhyped subject line. Do not add an unsubscribe line; it is added for you.",
    prompt:
      `Prospect facts:\n${facts.join("\n") || "(only their email address)"}\n\n` +
      (step === 0
        ? `Write the first email. ${ANGLES[product.slug] ?? ""} Link if useful: ${product.siteUrls[0]}`
        : `Write follow-up ${step} of ${total - 1}. They haven't replied. Keep it shorter than the first, add one ` +
          "new, genuinely useful point, and make it easy to say no." +
          (step === total - 1 ? " This is the last email: say you won't follow up again." : "")),
    schema: emailSchema,
    maxTokens: 6000,
  });
}

const OPT_OUT = "\n\nIf you'd rather not hear from us, reply \"stop\" and we won't email you again.";

/** Send the next emails in each enabled product's sequence, within its daily cap. */
export async function runOutreach(now = new Date()): Promise<string> {
  const t = londonParts(now);
  if (t.weekday > 5 || t.hour < 9 || t.hour >= 17) return "outside sending hours";

  const results: string[] = [];
  for (const product of products) {
    const s = await outreachSettings(product.slug);
    if (!s.enabled || (await isProductPaused(product.slug))) continue;
    if (!claudeConfigured()) {
      await createTask({
        kind: "alert",
        title: "Outreach is switched on but Claude isn't connected",
        body: "Cold emails are always written individually. Set ANTHROPIC_API_KEY, or switch outreach off.",
        dedupeKey: "alert:outreach-no-claude",
      });
      return "waiting for ANTHROPIC_API_KEY";
    }
    const sentToday = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM emails WHERE product = $1 AND kind LIKE 'outreach%'
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London'`,
      [product.slug],
    );
    const room = Math.max(0, s.dailyCap - (sentToday?.n ?? 0));
    if (!room) continue;
    const types = s.allowUnknown ? [...CORPORATE, "unknown"] : CORPORATE;
    const due = await query(
      `SELECT * FROM prospects p WHERE product = $1 AND status IN ('new','in_sequence')
         AND (next_send_at IS NULL OR next_send_at <= now()) AND company_type = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.prospect_id = p.id AND e.status = 'draft')
       ORDER BY status = 'new', next_send_at NULLS LAST, id LIMIT $3`,
      [product.slug, types, room],
    );
    let queued = 0;
    for (const p of due) {
      if (await isSuppressed(p.email)) {
        await query(`UPDATE prospects SET status = 'suppressed', next_send_at = NULL WHERE id = $1`, [p.id]);
        continue;
      }
      // Anyone who is already a lead or customer is handled there, not by cold outreach.
      const known = await one(
        `SELECT 1 FROM leads WHERE lower(email) = $1 UNION SELECT 1 FROM customers WHERE lower(email) = $1`,
        [p.email],
      );
      if (known) {
        await query(`UPDATE prospects SET status = 'skipped', next_send_at = NULL WHERE id = $1`, [p.id]);
        continue;
      }
      try {
        const draft = await draftOutreach(product, p, p.step, s.days.length);
        await queueEmail({
          product: product.slug,
          prospectId: p.id,
          kind: `outreach_${p.step + 1}`,
          to: p.email,
          subject: draft.subject,
          body: draft.body + OPT_OUT,
          autonomy: "approve",
          autonomyKey: "outreach",
        });
        const next = s.days[p.step + 1];
        await query(
          `UPDATE prospects SET step = step + 1, updated_at = now(),
             status = CASE WHEN $2::int IS NULL THEN 'finished' ELSE 'in_sequence' END,
             next_send_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + (($2::int - $3::int) * interval '1 day') END
           WHERE id = $1`,
          [p.id, next ?? null, s.days[p.step] ?? 0],
        );
        queued++;
      } catch (err) {
        await logEvent({ type: "outreach.error", level: "error", message: `${p.email}: ${errorMessage(err)}`, product: product.slug });
      }
    }
    if (queued) results.push(`${product.name}: ${queued}`);
  }
  return results.length ? `queued ${results.join(", ")}` : "nothing due";
}
