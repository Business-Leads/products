import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { emailOperator } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { getProduct, type CallKind } from "../products/index.js";
import { customerLabel, markCallBooked } from "./clients.js";
import { createLead } from "./leads.js";
import type { CustomerRow } from "./types.js";

// Cal.com tells us about bookings at /webhooks/calcom/<CALCOM_WEBHOOK_TOKEN>.
// Each call type's slug is "<product>-chat" (a sales chat) or
// "<product>-onboarding", so every booking is matched to a product and a kind
// of call. Onboarding bookings tick the customer's checklist; sales chats are
// recorded as enquiries (and stop any follow-up emails to that person).

export function calTokenMatches(given: string): boolean {
  const expected = config.calcom.webhookToken;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Payload = Record<string, any>;

function londonTime(iso: unknown): string | undefined {
  if (typeof iso !== "string" || !iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export interface CalResult {
  handled: boolean;
  product?: string;
  kind?: CallKind;
  matched?: boolean;
}

export async function handleCalEvent(body: Payload): Promise<CalResult> {
  const trigger = String(body.triggerEvent ?? "");
  if (trigger === "PING" || !trigger) return { handled: true };
  const p: Payload = body.payload && typeof body.payload === "object" ? body.payload : body;

  const slug = String(p.type ?? p.eventType?.slug ?? "");
  const m = /^([a-z]+)-(chat|onboarding)$/.exec(slug);
  const product = m ? getProduct(m[1]!) : undefined;
  const kind = m?.[2] as CallKind | undefined;
  const attendee: Payload = Array.isArray(p.attendees) && p.attendees[0] ? p.attendees[0] : {};
  const name: string | undefined = attendee.name ?? p.responses?.name?.value ?? undefined;
  const email = String(attendee.email ?? p.responses?.email?.value ?? "").trim().toLowerCase();
  const notes: string = p.additionalNotes ?? p.responses?.notes?.value ?? "";
  const when = londonTime(p.startTime);
  const who = name || email || "Someone";
  const callName = kind === "onboarding" ? "onboarding call" : "sales chat";
  const verb = trigger === "BOOKING_CANCELLED" ? "cancelled" : trigger === "BOOKING_RESCHEDULED" ? "moved" : "booked";

  if (!product || !kind) {
    await emailOperator(
      `Call ${verb}: ${p.title ?? slug}`,
      `${who}${email ? ` (${email})` : ""} ${verb} "${p.title ?? slug}"${when ? ` for ${when}` : ""}.\n\n` +
        `This call type isn't one HQ knows, so it isn't linked to a product.`,
      "client_activity",
    );
    await logEvent({ type: "calcom.unknown", message: `Cal.com ${trigger} for unknown call type ${slug || "(none)"}` });
    return { handled: false };
  }

  // Which customer is it? The onboarding link carries their id; otherwise match by email.
  const customerId = p.metadata?.customer_id ?? p.responses?.customer_id?.value;
  let customer: CustomerRow | undefined;
  if (customerId) customer = await one<CustomerRow>(`SELECT * FROM customers WHERE id::text = $1 AND product = $2`, [String(customerId), product.slug]);
  if (!customer && email) {
    customer = await one<CustomerRow>(
      `SELECT * FROM customers WHERE product = $1 AND lower(email) = $2 ORDER BY created_at DESC LIMIT 1`,
      [product.slug, email],
    );
  }

  const details =
    `${who}${email ? ` (${email})` : ""}${when ? `\nWhen: ${when} (UK time)` : ""}` +
    `${notes ? `\nTheir note: ${notes}` : ""}\n\nIt's in your calendar.`;

  if (kind === "onboarding" && customer) {
    if (trigger === "BOOKING_CREATED") {
      await markCallBooked(customer, when); // emails the operator
    } else if (trigger === "BOOKING_RESCHEDULED") {
      await query(`UPDATE customers SET data = data || jsonb_build_object('call_time', $2::text), updated_at = now() WHERE id = $1`, [customer.id, when ?? null]);
      await emailOperator(`${product.name}: onboarding call moved by ${customerLabel(customer)}`, details, "client_activity");
    } else if (trigger === "BOOKING_CANCELLED") {
      // Their account will ask them to book again.
      await query(`UPDATE customers SET data = data - 'call_booked_at' - 'call_time', updated_at = now() WHERE id = $1`, [customer.id]);
      await emailOperator(`${product.name}: onboarding call cancelled by ${customerLabel(customer)}`, `${details.replace("\n\nIt's in your calendar.", "")}\n\nTheir account will ask them to book a new time.`, "client_activity");
    }
    await logEvent({ type: `calcom.${verb}`, message: `${customerLabel(customer)} ${verb} their ${product.name} onboarding call`, product: product.slug, customerId: customer.id });
    return { handled: true, product: product.slug, kind, matched: true };
  }

  if (kind === "chat" && trigger === "BOOKING_CREATED") {
    // Record the person as an enquiry, and stop any automatic follow-up emails: they've booked.
    const existing = email
      ? await one<{ id: string }>(`SELECT id FROM leads WHERE product = $1 AND lower(email) = $2 ORDER BY created_at DESC LIMIT 1`, [product.slug, email])
      : undefined;
    const leadId = existing?.id ?? (await createLead({ product: product.slug, name, email, message: notes || undefined, source: "Booked a call" })).id;
    await query(
      `UPDATE leads SET next_touch_at = NULL, data = data || jsonb_build_object('call_booked_at', to_jsonb(now()), 'call_time', $2::text), updated_at = now() WHERE id = $1`,
      [leadId, when ?? null],
    );
    await emailOperator(`${product.name}: sales chat booked by ${who}`, details, "client_activity");
    await logEvent({ type: "calcom.booked", message: `${who} booked a ${product.name} sales chat`, product: product.slug, leadId });
    return { handled: true, product: product.slug, kind, matched: Boolean(existing) };
  }

  await emailOperator(`${product.name}: ${callName} ${verb} by ${who}`, details, "client_activity");
  await logEvent({ type: `calcom.${verb}`, message: `${who} ${verb} a ${product.name} ${callName}`, product: product.slug });
  return { handled: true, product: product.slug, kind, matched: Boolean(customer) };
}
