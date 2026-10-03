import { createPost, replyToReviews } from "../integrations/localfalcon.js";
import { importEngagers, launch, replyAndResolve, sourceLeads } from "../integrations/sbl.js";
import { query } from "../db/index.js";
import type { CustomerRow } from "./types.js";

// Things HQ publishes into outside services on a client's behalf. A handler
// returns a "publish" outcome; with approval it waits in the inbox (where the
// text can be edited) and is published when approved, otherwise straight away.
// Each publisher returns a short note for the activity log.

export type Publisher = (customer: CustomerRow, data: Record<string, any>, editedBody?: string) => Promise<string>;

export const publishers: Record<string, Publisher> = {
  /** A post on the client's Google Business Profile, via Local Falcon. */
  async gbp_post(customer, data, editedBody) {
    const placeId = customer.data.gbp_place_id;
    if (!placeId) throw new Error("This client's Google profile isn't connected yet");
    const text = (editedBody ?? data.body ?? "").trim();
    if (!text) throw new Error("The post is empty");
    await createPost(placeId, text, data.link);
    return "Posted on their Google profile";
  },

  /**
   * Replies to Google reviews. The approval text lists each reply as
   * "#<n> ... reply text" blocks; edits to those blocks are what gets posted.
   */
  async gbp_review_replies(customer, data, editedBody) {
    const placeId = customer.data.gbp_place_id;
    if (!placeId) throw new Error("This client's Google profile isn't connected yet");
    const drafts: { reviewId: string; reply: string }[] = data.replies ?? [];
    const edited = editedBody ? parseReplyBlocks(editedBody) : new Map<number, string>();
    const replies = drafts
      .map((r, i) => ({ reviewId: r.reviewId, reply: (edited.get(i + 1) ?? r.reply).trim() }))
      .filter((r) => r.reply);
    await replyToReviews(placeId, replies);
    return `Replied to ${replies.length} review${replies.length === 1 ? "" : "s"}`;
  },

  /** Replies to LinkedIn conversations through Sbl.so (reply and resolve the human-intervention item). */
  async sbl_replies(customer, data, editedBody) {
    const edited = editedBody ? parseReplyBlocks(editedBody) : new Map<number, string>();
    let sent = 0;
    for (const [i, r] of (data.replies as { campaignId: string; userId: string; reply: string }[]).entries()) {
      const text = (edited.get(i + 1) ?? r.reply).trim();
      if (!text) continue;
      await replyAndResolve(r.campaignId, r.userId, text, `lnk-${customer.id}-reply-${r.campaignId}-${r.userId}-${Date.now().toString(36)}`);
      sent++;
    }
    return `Sent ${sent} LinkedIn repl${sent === 1 ? "y" : "ies"}`;
  },

  /** Find the first 25 matching leads (billable) and start the cold campaign. */
  async sbl_launch(_customer, data) {
    await sourceLeads(data.cold, data.prompt || "People matching the campaign's ideal customer", 25, data.key);
    await launch(data.cold, `${data.key}-run`);
    return "Found 25 leads and started the LinkedIn campaign";
  },

  /** Import scored post engagers into the week's warm campaign and start it. */
  async sbl_harvest(customer, data) {
    for (const [i, previewId] of (data.previewIds as string[]).entries()) {
      await importEngagers(data.campaignId, previewId, `lnk-${customer.id}-import-${data.campaignId}-${i}`);
    }
    await launch(data.campaignId, `lnk-${customer.id}-harvest-${data.campaignId}`);
    await query(
      `UPDATE customers SET data = data || jsonb_build_object('sbl_campaign_ids', COALESCE(data->'sbl_campaign_ids', '[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1`,
      [customer.id, String(data.campaignId)],
    );
    return "Engagers imported and warm campaign started";
  },
};

/** Reply text blocks start with a line "Reply #n:". */
export function parseReplyBlocks(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = text.split(/^Reply #(\d+):[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(Number(parts[i]), parts[i + 1]!.split(/^(?:Review|Conversation) #\d+/m)[0]!.trim());
  return out;
}

export async function runPublisher(name: string, customer: CustomerRow, data: Record<string, any>, editedBody?: string): Promise<string> {
  const p = publishers[name];
  if (!p) throw new Error(`Unknown publisher ${name}`);
  return p(customer, data, editedBody);
}
