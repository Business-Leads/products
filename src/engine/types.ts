import type { Product } from "../products/index.js";

export interface CustomerRow {
  id: string;
  product: string;
  plan: string;
  status: string;
  name: string | null;
  business: string | null;
  email: string;
  phone: string | null;
  data: Record<string, any>;
  intake_token: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  amount_pence: number;
  interval: string;
  lead_id: string | null;
  past_due_since: Date | null;
  created_at: Date;
  activated_at: Date | null;
  cancelled_at: Date | null;
}

export interface StepRow {
  id: string;
  customer_id: string;
  position: number;
  key: string;
  title: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  task_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface DeliveryRow {
  id: string;
  customer_id: string;
  product: string;
  routine: string;
  period: string;
  status: string;
  content: Record<string, any>;
  attempts: number;
}

export interface HandlerContext {
  product: Product;
  customer: CustomerRow;
  step?: StepRow;
  delivery?: DeliveryRow;
  /** Text a person supplied through a manual task (e.g. pasted scan results). */
  input?: string;
}

/**
 * What a step or routine handler wants to happen next. The engine turns each
 * outcome into database state, emails and inbox tasks, so handlers stay small.
 */
export type Outcome =
  | { type: "done"; note?: string }
  | { type: "waiting"; note?: string }
  /** An email to the customer. With approval it waits in the inbox first. */
  | { type: "email"; subject: string; body: string; to?: string; approval: boolean }
  /** An internal document a person reviews; on approval it is saved to customer.data[saveAs]. */
  | { type: "review"; title: string; body: string; saveAs: string }
  /**
   * Work a person has to do. With inputLabel the task asks for text; with rerun
   * the handler runs again with that text, otherwise completing the task
   * completes the step.
   */
  | { type: "manual"; title: string; instructions: string; inputLabel?: string; saveAs?: string; rerun?: boolean };

export type Handler = (ctx: HandlerContext) => Promise<Outcome>;
