import { logEvent } from "../lib/events.js";
import { createTask } from "../lib/tasks.js";
import { errorMessage } from "../lib/util.js";

// "Call me" requests from the Online Business Builder site. The phone
// assistant runs in Awaz; a Make scenario (custom webhook -> Awaz "Create/
// Schedule a Call") places the call. MAKE_CALL_WEBHOOK_URL is that webhook.
// Without it, the request becomes a to-do so nobody is left waiting.

export interface CallRequest {
  leadId: string;
  product: string;
  name?: string;
  phone: string;
  email?: string;
  business?: string;
  callTime?: string;
}

/** UK numbers in the +44 form the phone assistant expects. */
export function ukNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  if (/^0\d{9,10}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^44\d{9,10}$/.test(digits)) return `+${digits}`;
  return null;
}

export async function requestCall(r: CallRequest): Promise<"sent" | "task"> {
  const phone = ukNumber(r.phone);
  const url = process.env.MAKE_CALL_WEBHOOK_URL?.trim();
  if (phone && url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          name: r.name ?? "",
          first_name: (r.name ?? "").split(/\s+/)[0] ?? "",
          email: r.email ?? "",
          business: r.business ?? "",
          call_time: r.callTime ?? "As soon as possible",
          lead_id: r.leadId,
          product: r.product,
        }),
      });
      if (!res.ok) throw new Error(`Make answered ${res.status}`);
      await logEvent({ type: "callback.requested", message: `Assistant asked to call ${r.name ?? phone}`, product: r.product, leadId: r.leadId });
      return "sent";
    } catch (err) {
      await logEvent({ type: "callback.failed", level: "error", message: `Couldn't start the call: ${errorMessage(err)}`, product: r.product, leadId: r.leadId });
    }
  }
  await createTask({
    kind: "manual",
    priority: 1,
    title: `Call ${r.name || r.business || r.phone} back (asked for a call)`,
    body:
      `They asked for a call on the website${r.callTime ? ` (${r.callTime})` : ""}.\n\nPhone: ${r.phone}` +
      `${r.email ? `\nEmail: ${r.email}` : ""}${r.business ? `\nBusiness: ${r.business}` : ""}` +
      (phone ? "" : "\n\nThe number doesn't look like a UK number, so the assistant couldn't call it."),
    product: r.product,
    leadId: r.leadId,
    dedupeKey: `callback:${r.leadId}`,
  });
  return "task";
}
