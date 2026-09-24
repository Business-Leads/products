import { query } from "../db/index.js";

export interface EventInput {
  type: string;
  message: string;
  level?: "info" | "warn" | "error";
  product?: string | null;
  customerId?: number | string | null;
  leadId?: number | string | null;
  data?: Record<string, unknown>;
}

/** Append to the activity log. Never throws: logging must not break the work it records. */
export async function logEvent(e: EventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO events (type, message, level, product, customer_id, lead_id, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.type, e.message, e.level ?? "info", e.product ?? null, e.customerId ?? null, e.leadId ?? null, e.data ?? {}],
    );
  } catch (err) {
    console.error("logEvent failed", err);
  }
}
