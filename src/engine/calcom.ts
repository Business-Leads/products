import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { emailOperator, queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { portalUrl } from "../portal/accounts.js";
import { getProduct, type CallKind, type Product } from "../products/index.js";
import { customerLabel, markCallBooked } from "./clients.js";
import { createLead } from "./leads.js";
import type { CustomerRow } from "./types.js";

// Cal.com tells us about bookings at /webhooks/calcom/<CALCOM_WEBHOOK_TOKEN>.
// Each call type's slug is "<product>-chat" (a sales chat) or
// "<product>-onboarding", so every booking is matched to a product and a kind
// of call. The person who booked gets a friendly email from us; customers see
// the call in their account; onboarding bookings tick the checklist; sales
// chats are recorded as enquiries (with follow-up emails stopped). Felix is
// emailed about every booking, change and cancellation.

export function calTokenMatches(given: string): boolean {
  const expected = config.calcom.webhookToken;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Payload = Record<string, any>;

/** A call as kept on the customer (data.calls) and shown in their account. */
export interface ClientCall {
  uid: string;
  kind: CallKind;
  start: string;
  status: "booked" | "cancelled";
  joinUrl?: string;
}

export function londonTime(iso: unknown): string | undefined {
  if (typeof iso !== "string" || !iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });
}

/** Where the person can change or cancel their booking. */
export function manageUrl(uid: string): string {
  return `https://cal.com/booking/${encodeURIComponent(uid)}`;
}

function joinUrlOf(p: Payload): string | undefined {
  const candidates = [p.metadata?.videoCallUrl, p.videoCallData?.url, p.location];
  return candidates.find((u) => typeof u === "string" && /^https:\/\//.test(u));
}

const callWord = (kind: CallKind) => (kind === "onboarding" ? "onboarding call" : "chat");

async function recordCall(customer: CustomerRow, call: ClientCall, replaces?: string): Promise<void> {
  const calls: ClientCall[] = Array.isArray(customer.data.calls) ? customer.data.calls : [];
  const next = calls
    .map((c) => (c.uid === replaces ? { ...c, status: "cancelled" as const } : c))
    .filter((c) => c.uid !== call.uid);
  next.push(call);
  next.sort((a, b) => a.start.localeCompare(b.start));
  await query(`UPDATE customers SET data = data || jsonb_build_object('calls', $2::jsonb), updated_at = now() WHERE id = $1`, [
    customer.id,
    JSON.stringify(next.slice(-12)),
  ]);
}

async function cancelCall(customer: CustomerRow, uid: string): Promise<void> {
  const calls: ClientCall[] = Array.isArray(customer.data.calls) ? customer.data.calls : [];
  if (!calls.some((c) => c.uid === uid)) return;
  const next = calls.map((c) => (c.uid === uid ? { ...c, status: "cancelled" as const } : c));
  await query(`UPDATE customers SET data = data || jsonb_build_object('calls', $2::jsonb), updated_at = now() WHERE id = $1`, [customer.id, JSON.stringify(next)]);
}

/** The friendly note from us to the person who booked (Cal.com also sends the calendar invite). */
function bookerEmail(product: Product, kind: CallKind, trigger: string, opts: { first?: string; when?: string; uid?: string; joinUrl?: string; customer?: CustomerRow }) {
  const hello = opts.first ? `Hello ${opts.first},` : "Hello,";
  const account = portalUrl(product);
  const join = opts.joinUrl ? `\n\nJoin the call here: ${opts.joinUrl}` : `\n\nThe joining link is in your calendar invite.`;
  const change = opts.uid ? `\n\nNeed to change the time? ${manageUrl(opts.uid)}` : "";

  if (trigger === "BOOKING_CANCELLED") {
    return {
      subject: `Your ${callWord(kind)} with Felix is cancelled`,
      body:
        `${hello}\n\nNo problem, your ${callWord(kind)} ${opts.when ? `on ${opts.when} ` : ""}is cancelled.\n\n` +
        `Whenever you're ready, you can book another time here: ${account}/${kind === "onboarding" && opts.customer ? "book" : "chat"}\n\nFelix`,
    };
  }
  const moved = trigger === "BOOKING_RESCHEDULED";
  if (kind === "onboarding") {
    const intakeDone = Boolean(opts.customer?.data.intake_completed_at);
    return {
      subject: moved ? `Your ${product.name} onboarding call has moved` : `Your ${product.name} onboarding call is booked`,
      body:
        `${hello}\n\n${moved ? "Thanks, your onboarding call is now" : "Thank you for booking your onboarding call. It's"} on ${opts.when ?? "the time you chose"} (UK time).` +
        `${join}\n\nOn the call we'll go through everything so your ${product.name} is set up just right. ` +
        `You can see the call in your account any time: ${account}/` +
        `${intakeDone ? "" : `\n\nIf you haven't yet, please fill in a few details before we speak, so we can make the most of the time: ${account}/details`}` +
        `${change}\n\nSpeak soon,\nFelix`,
    };
  }
  return {
    subject: moved ? `Your chat about ${product.name} has moved` : `Thanks for booking a chat about ${product.name}`,
    body:
      `${hello}\n\n${moved ? "Thanks, our chat is now" : `Thanks for booking a chat about ${product.name}. It's`} on ${opts.when ?? "the time you chose"} (UK time).` +
      `${join}\n\nIt's a relaxed conversation: tell me a bit about your business and I'll explain how ${product.name} could help. ` +
      `No preparation needed.${change}\n\nLooking forward to it,\nFelix`,
  };
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

  // Handle each booking change once, however many times Cal.com delivers it.
  if (typeof p.uid === "string") {
    const key = `cal:${trigger}:${p.uid}:${p.startTime ?? ""}`;
    const fresh = await one(`INSERT INTO webhook_seen (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key`, [key]);
    if (!fresh) return { handled: true };
  }

  const slug = String(p.type ?? p.eventType?.slug ?? "");
  const m = /^([a-z]+)-(chat|onboarding)$/.exec(slug);
  const product = m ? getProduct(m[1]!) : undefined;
  const kind = m?.[2] as CallKind | undefined;
  const attendee: Payload = Array.isArray(p.attendees) && p.attendees[0] ? p.attendees[0] : {};
  const name: string | undefined = attendee.name ?? p.responses?.name?.value ?? undefined;
  const email = String(attendee.email ?? p.responses?.email?.value ?? "").trim().toLowerCase();
  const notes: string = p.additionalNotes ?? p.responses?.notes?.value ?? "";
  const uid: string | undefined = typeof p.uid === "string" ? p.uid : undefined;
  const when = londonTime(p.startTime);
  const joinUrl = joinUrlOf(p);
  const who = name || email || "Someone";
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

  // Keep the call on the customer's account so they can see it.
  if (customer && uid) {
    if (trigger === "BOOKING_CANCELLED") await cancelCall(customer, uid);
    else if (p.startTime) await recordCall(customer, { uid, kind, start: String(p.startTime), status: "booked", joinUrl }, p.rescheduleUid ?? p.fromReschedule);
  }

  // A friendly note from us to the person who booked.
  if (email) {
    const first = (name ?? customer?.name ?? "").split(/\s+/)[0] || undefined;
    const note = bookerEmail(product, kind, trigger, { first, when, uid, joinUrl, customer });
    await queueEmail({ product: product.slug, customerId: customer?.id ?? null, kind: "call_booked", to: email, ...note });
  }

  const details =
    `${who}${email ? ` (${email})` : ""}${when ? `\nWhen: ${when} (UK time)` : ""}` +
    `${notes ? `\nTheir note: ${notes}` : ""}${trigger === "BOOKING_CANCELLED" ? "" : "\n\nIt's in your calendar."}`;

  if (kind === "onboarding" && customer) {
    if (trigger === "BOOKING_CREATED") {
      await markCallBooked(customer, when); // emails Felix
    } else if (trigger === "BOOKING_RESCHEDULED") {
      await query(`UPDATE customers SET data = data || jsonb_build_object('call_time', $2::text), updated_at = now() WHERE id = $1`, [customer.id, when ?? null]);
      await emailOperator(`${product.name}: onboarding call moved by ${customerLabel(customer)}`, details, "client_activity");
    } else if (trigger === "BOOKING_CANCELLED") {
      // Their account will ask them to book again.
      await query(`UPDATE customers SET data = data - 'call_booked_at' - 'call_time', updated_at = now() WHERE id = $1`, [customer.id]);
      await emailOperator(`${product.name}: onboarding call cancelled by ${customerLabel(customer)}`, `${details}\n\nTheir account will ask them to book a new time.`, "client_activity");
    }
    await logEvent({ type: `calcom.${verb}`, message: `${customerLabel(customer)} ${verb} their ${product.name} onboarding call`, product: product.slug, customerId: customer.id });
    return { handled: true, product: product.slug, kind, matched: true };
  }

  if (kind === "chat" && trigger === "BOOKING_CREATED" && !customer) {
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

  const label = customer ? customerLabel(customer) : who;
  await emailOperator(`${product.name}: ${kind === "onboarding" ? "onboarding call" : "chat"} ${verb} by ${label}`, details, "client_activity");
  await logEvent({ type: `calcom.${verb}`, message: `${label} ${verb} a ${product.name} ${callWord(kind)}`, product: product.slug, customerId: customer?.id });
  return { handled: true, product: product.slug, kind, matched: Boolean(customer) };
}
