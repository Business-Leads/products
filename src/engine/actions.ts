import { one, query } from "../db/index.js";
import { logEvent } from "../lib/events.js";
import type { Task } from "../lib/tasks.js";
import type { DeliveryRow, StepRow } from "./types.js";
import { requireProduct } from "../products/index.js";
import { advanceOnboarding, completeStep, executeStep, loadCustomer, runDelivery, saveCustomerData } from "./workflow.js";

export type Decision = "approve" | "reject" | "done" | "dismiss";

export interface DecisionForm {
  subject?: string;
  body?: string;
  input?: string;
  note?: string;
}

/**
 * Apply a person's decision on an inbox task. Approving or completing a task
 * carries the work on (sends the email, saves the document, finishes the
 * onboarding step) and lets the automation continue from there.
 */
export async function decideTask(taskId: string, decision: Decision, form: DecisionForm = {}): Promise<void> {
  // Claim the task atomically so a double click can't act on it twice.
  const status = { approve: "approved", reject: "rejected", done: "done", dismiss: "dismissed" }[decision];
  const task = await one<Task>(
    `UPDATE tasks SET status = $2, resolution = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
    [taskId, status, form.note ?? null],
  );
  if (!task) return;
  const p = task.payload ?? {};

  if (decision === "dismiss") {
    return;
  }

  if (decision === "reject") {
    if (p.emailId) await query(`UPDATE emails SET status = 'cancelled' WHERE id = $1 AND status = 'draft'`, [p.emailId]);
    await markRejected(p, form.note);
    await logEvent({
      type: "task.rejected",
      message: `${task.title}${form.note ? `: ${form.note}` : ""}`,
      product: task.product,
      customerId: task.customer_id,
      leadId: task.lead_id,
    });
    return;
  }

  // approve / done
  await logEvent({
    type: decision === "approve" ? "task.approved" : "task.done",
    message: task.title,
    product: task.product,
    customerId: task.customer_id,
    leadId: task.lead_id,
  });

  switch (task.action) {
    case "send_email": {
      const email = await one<{ body_text: string; subject: string }>(`SELECT * FROM emails WHERE id = $1`, [p.emailId]);
      const editedBody = stripFooter(form.body);
      if (email) {
        const footerAt = email.body_text.indexOf("\n\n--\n");
        const footer = footerAt >= 0 ? email.body_text.slice(footerAt) : "";
        await query(
          `UPDATE emails SET status = 'queued', send_after = now(), subject = $2, body_text = $3
           WHERE id = $1 AND status = 'draft'`,
          [p.emailId, form.subject?.trim() || email.subject, editedBody?.trim() ? editedBody.trimEnd() + footer : email.body_text],
        );
      }
      await carryOn(p, { subject: form.subject, body: editedBody });
      return;
    }
    case "approve_review": {
      const customerId = await customerIdFor(p);
      if (customerId && p.saveAs) await saveCustomerData(customerId, p.saveAs, form.body || task.body);
      await carryOn(p);
      return;
    }
    case "complete_manual": {
      const customerId = await customerIdFor(p);
      if (customerId && p.saveAs && form.input) await saveCustomerData(customerId, p.saveAs, form.input);
      if (p.rerun) {
        await rerun(p, form.input);
      } else {
        await carryOn(p);
      }
      return;
    }
    default:
      // Plain alerts and manual reminders: nothing further to run.
      if (task.customer_id) await advanceOnboarding(task.customer_id);
  }
}

/** The body shown for editing excludes the automatic legal footer; it's re-added on save. */
function stripFooter(body?: string): string | undefined {
  if (!body) return body;
  const i = body.indexOf("\n\n--\n");
  return i >= 0 ? body.slice(0, i) : body;
}

async function customerIdFor(p: Record<string, any>): Promise<string | undefined> {
  if (p.stepId) return (await one<StepRow>(`SELECT * FROM onboarding_steps WHERE id = $1`, [p.stepId]))?.customer_id;
  if (p.deliveryId) return (await one<DeliveryRow>(`SELECT * FROM deliveries WHERE id = $1`, [p.deliveryId]))?.customer_id;
  return undefined;
}

async function carryOn(p: Record<string, any>, edited?: { subject?: string; body?: string }): Promise<void> {
  if (p.stepId) {
    await completeStep(p.stepId);
  } else if (p.deliveryId) {
    const extra = edited?.body ? { body: edited.body, subject: edited.subject || undefined } : {};
    await query(
      `UPDATE deliveries SET status = 'delivered', delivered_at = now(), content = content || $2::jsonb WHERE id = $1`,
      [p.deliveryId, JSON.stringify(extra)],
    );
  }
}

async function rerun(p: Record<string, any>, input?: string): Promise<void> {
  if (p.deliveryId) {
    await query(`UPDATE deliveries SET content = content || $2::jsonb, status = 'due' WHERE id = $1`, [
      p.deliveryId,
      JSON.stringify({ input: input ?? "" }),
    ]);
    const delivery = await one<DeliveryRow>(`SELECT * FROM deliveries WHERE id = $1`, [p.deliveryId]);
    if (delivery) await runDelivery(delivery, input);
    return;
  }
  if (p.stepId) {
    const step = await one<StepRow>(`SELECT * FROM onboarding_steps WHERE id = $1`, [p.stepId]);
    if (!step) return;
    const customer = await loadCustomer(step.customer_id);
    if (!customer) return;
    await query(`UPDATE onboarding_steps SET status = 'pending', task_id = NULL WHERE id = $1`, [step.id]);
    const fresh = { ...step, status: "pending", task_id: null };
    const finished = await executeStep(customer, requireProduct(customer.product), fresh, input);
    if (finished) await advanceOnboarding(customer.id);
  }
}

async function markRejected(p: Record<string, any>, note?: string): Promise<void> {
  const reason = `Rejected${note ? `: ${note}` : ""}`;
  if (p.stepId) {
    await query(`UPDATE onboarding_steps SET status = 'failed', last_error = $2, task_id = NULL, attempts = 99 WHERE id = $1`, [
      p.stepId,
      reason,
    ]);
  }
  if (p.deliveryId) {
    await query(`UPDATE deliveries SET status = 'failed', last_error = $2, attempts = 99 WHERE id = $1`, [
      p.deliveryId,
      reason,
    ]);
  }
}
