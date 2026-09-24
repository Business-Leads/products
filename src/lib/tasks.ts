import { one, query } from "../db/index.js";

export interface TaskInput {
  kind: "approval" | "manual" | "alert";
  title: string;
  body?: string;
  product?: string | null;
  customerId?: number | string | null;
  leadId?: number | string | null;
  priority?: 1 | 2 | 3;
  /** Handler (engine/actions.ts) run when the task is approved or marked done. */
  action?: string;
  payload?: Record<string, unknown>;
  /** Only one open task per key; a repeat call returns the existing task. */
  dedupeKey?: string;
  dueAt?: Date;
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  body: string;
  product: string | null;
  customer_id: string | null;
  lead_id: string | null;
  priority: number;
  action: string | null;
  payload: Record<string, any>;
  status: string;
  created_at: Date;
  due_at: Date | null;
}

export async function createTask(t: TaskInput): Promise<Task> {
  if (t.dedupeKey) {
    const existing = await one<Task>(`SELECT * FROM tasks WHERE dedupe_key = $1`, [t.dedupeKey]);
    if (existing && existing.status === "open") return existing;
    if (existing) {
      // A resolved task with the same key: free the key so a fresh task can be raised.
      await query(`UPDATE tasks SET dedupe_key = NULL WHERE id = $1`, [existing.id]);
    }
  }
  const row = await one<Task>(
    `INSERT INTO tasks (kind, title, body, product, customer_id, lead_id, priority, action, payload, dedupe_key, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      t.kind,
      t.title,
      t.body ?? "",
      t.product ?? null,
      t.customerId ?? null,
      t.leadId ?? null,
      t.priority ?? 2,
      t.action ?? null,
      t.payload ?? {},
      t.dedupeKey ?? null,
      t.dueAt ?? null,
    ],
  );
  return row!;
}

export async function resolveTask(id: string | number, status: string, resolution?: string): Promise<void> {
  await query(
    `UPDATE tasks SET status = $2, resolution = $3, resolved_at = now() WHERE id = $1`,
    [id, status, resolution ?? null],
  );
}

/** Close an open alert once the underlying problem has cleared. */
export async function clearAlert(dedupeKey: string, resolution = "Cleared automatically"): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'done', resolution = $2, resolved_at = now()
     WHERE dedupe_key = $1 AND status = 'open'`,
    [dedupeKey, resolution],
  );
}
