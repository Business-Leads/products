import { one, query } from "../db/index.js";

export type Autonomy = "auto" | "approve";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await one<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/**
 * Whether a kind of outward action for a product runs by itself or waits for approval.
 * Kinds: "lead_replies" and "routine:<key>".
 */
export async function autonomyFor(product: string, kind: string, fallback: Autonomy): Promise<Autonomy> {
  return getSetting<Autonomy>(`autonomy:${product}:${kind}`, fallback);
}

/** Pausing a product stops all automated outbound email and routines for it. */
export async function isProductPaused(product: string): Promise<boolean> {
  return (await getSetting<boolean>("paused:all", false)) || (await getSetting<boolean>(`paused:${product}`, false));
}
