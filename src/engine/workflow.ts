import { one, query } from "../db/index.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { isProductPaused } from "../lib/settings.js";
import { createTask } from "../lib/tasks.js";
import { NotConfiguredError, daysInMonth, errorMessage, londonParts } from "../lib/util.js";
import { requireProduct, type Product } from "../products/index.js";
import type { Cadence, RoutineDef } from "../products/types.js";
import { getHandler } from "./handlers.js";
import type { CustomerRow, DeliveryRow, HandlerContext, Outcome, StepRow } from "./types.js";

const MAX_ATTEMPTS = 3;

export async function loadCustomer(id: string | number): Promise<CustomerRow | undefined> {
  return one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [id]);
}

/** Where customer-facing reports and notices go. */
export function recipientFor(customer: CustomerRow): string {
  const intake = customer.data.intake ?? {};
  return intake.report_email || intake.notify_email || customer.email;
}

export async function saveCustomerData(customerId: string, key: string, value: unknown): Promise<void> {
  await query(`UPDATE customers SET data = jsonb_set(data, $2, $3::jsonb, true), updated_at = now() WHERE id = $1`, [
    customerId,
    `{${key}}`,
    JSON.stringify(value),
  ]);
}

// ------------------------------------------------------------------ steps

/** Create the onboarding checklist for a new customer from the product definition. */
export async function instantiateSteps(customer: CustomerRow): Promise<void> {
  const product = requireProduct(customer.product);
  let position = 0;
  for (const step of product.onboarding) {
    const applies = !step.plans || step.plans.includes(customer.plan);
    await query(
      `INSERT INTO onboarding_steps (customer_id, position, key, title, kind, status)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (customer_id, key) DO NOTHING`,
      [customer.id, position++, step.key, step.title, step.kind, applies ? "pending" : "skipped"],
    );
  }
}

async function setStep(stepId: string, fields: Partial<Record<"status" | "last_error" | "task_id", string | null>>) {
  const done = fields.status === "done" || fields.status === "skipped";
  await query(
    `UPDATE onboarding_steps SET
       status = COALESCE($2, status),
       last_error = $3,
       task_id = COALESCE($4, task_id),
       started_at = COALESCE(started_at, now()),
       completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [stepId, fields.status ?? null, fields.last_error ?? null, fields.task_id ?? null, done],
  );
}

export async function completeStep(stepId: string, note?: string): Promise<void> {
  const step = await one<StepRow>(`SELECT * FROM onboarding_steps WHERE id = $1`, [stepId]);
  if (!step) return;
  await setStep(stepId, { status: "done" });
  const customer = await loadCustomer(step.customer_id);
  await logEvent({
    type: "onboarding.step_done",
    message: `${step.title}${note ? `: ${note}` : ""}`,
    product: customer?.product,
    customerId: step.customer_id,
  });
  await advanceOnboarding(step.customer_id);
}

/**
 * Run the customer's onboarding forward as far as it can go without a person:
 * each step either completes, or leaves the customer waiting on themselves or
 * on a task in the inbox.
 */
export async function advanceOnboarding(customerId: string | number): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const customer = await loadCustomer(customerId);
    if (!customer || customer.status === "cancelled") return;
    if (await isProductPaused(customer.product)) return;
    const product = requireProduct(customer.product);

    const step = await one<StepRow>(
      `SELECT * FROM onboarding_steps WHERE customer_id = $1 AND status NOT IN ('done','skipped')
       ORDER BY position LIMIT 1`,
      [customer.id],
    );
    if (!step) return;
    // Waiting on a task in the inbox: nothing to do until it's resolved.
    if (step.status === "waiting" && step.task_id) return;
    if (step.status === "failed" && step.attempts >= MAX_ATTEMPTS) return;

    const progressed = await executeStep(customer, product, step);
    if (!progressed) return;
  }
}

/** Run one step's handler (optionally with text a person supplied) and apply the outcome. */
export async function executeStep(customer: CustomerRow, product: Product, step: StepRow, input?: string): Promise<boolean> {
  const def = product.onboarding.find((s) => s.key === step.key);
  const ctx: HandlerContext = { product, customer, step, input };
  let outcome: Outcome;
  try {
    outcome = def?.handler
      ? await getHandler(def.handler)(ctx)
      : { type: "manual", title: `${step.title} (${customerLabel(customer)})`, instructions: def?.instructions ?? step.title };
  } catch (err) {
    if (!(err instanceof NotConfiguredError)) {
      await failStep(step, customer, product, err);
      return false;
    }
    outcome = {
      type: "manual",
      title: `${step.title} (${customerLabel(customer)})`,
      instructions: `${def?.instructions ?? "Do this step by hand."}\n\nThis is manual because ${err.message}.`,
    };
  }
  return applyOutcome(outcome, ctx);
}

async function failStep(step: StepRow, customer: CustomerRow, product: Product, err: unknown) {
  const message = errorMessage(err);
  await setStep(step.id, { status: "failed", last_error: message });
  await query(`UPDATE onboarding_steps SET attempts = attempts + 1 WHERE id = $1`, [step.id]);
  await logEvent({
    type: "onboarding.step_failed",
    level: "error",
    message: `${step.title}: ${message}`,
    product: product.slug,
    customerId: customer.id,
  });
  if (step.attempts + 1 >= MAX_ATTEMPTS) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: `Onboarding stuck: ${step.title} (${customerLabel(customer)})`,
      body: `Failed ${MAX_ATTEMPTS} times. Last error: ${message}\n\nFix the cause, then press Retry on the customer page.`,
      product: product.slug,
      customerId: customer.id,
      dedupeKey: `alert:step-failed:${step.id}`,
    });
  }
}

export async function retryStep(stepId: string): Promise<void> {
  const step = await one<StepRow>(`SELECT * FROM onboarding_steps WHERE id = $1`, [stepId]);
  if (!step) return;
  await query(`UPDATE onboarding_steps SET status = 'pending', attempts = 0, last_error = NULL, task_id = NULL WHERE id = $1`, [
    stepId,
  ]);
  await advanceOnboarding(step.customer_id);
}

function customerLabel(c: CustomerRow): string {
  return c.business || c.name || c.email;
}

// -------------------------------------------------------------- outcomes

/**
 * Turn a handler's outcome into state. Returns true when the step or delivery
 * finished, so the caller can move on to the next one.
 */
export async function applyOutcome(outcome: Outcome, ctx: HandlerContext): Promise<boolean> {
  const { product, customer, step, delivery } = ctx;
  const ref = step ? { stepId: step.id } : { deliveryId: delivery!.id };
  const routine = delivery ? product.routines.find((r) => r.key === delivery.routine) : undefined;
  const label = step?.title ?? routine?.title ?? "Work";

  const finish = async (note?: string) => {
    if (step) await setStep(step.id, { status: "done" });
    if (delivery) {
      await query(`UPDATE deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`, [
        delivery.id,
      ]);
    }
    await logEvent({
      type: step ? "onboarding.step_done" : "routine.delivered",
      message: `${label}: ${customerLabel(customer)}${note ? ` (${note})` : ""}`,
      product: product.slug,
      customerId: customer.id,
    });
    return true;
  };
  const wait = async (taskId?: string, status = "waiting") => {
    if (step) await setStep(step.id, { status: "waiting", task_id: taskId ?? null });
    if (delivery) {
      await query(`UPDATE deliveries SET status = $2 WHERE id = $1`, [delivery.id, status === "waiting" ? "blocked" : status]);
    }
    return false;
  };

  switch (outcome.type) {
    case "done":
      return finish(outcome.note);

    case "waiting":
      return wait();

    case "email": {
      const autonomyKey = step ? `step:${step.key}` : `routine:${delivery!.routine}`;
      const queued = await queueEmail({
        product: product.slug,
        customerId: customer.id,
        kind: step ? `onboarding:${step.key}` : `routine:${delivery!.routine}`,
        to: outcome.to ?? recipientFor(customer),
        subject: outcome.subject,
        body: outcome.body,
        autonomy: outcome.approval ? "approve" : "auto",
        autonomyKey,
        taskPayload: ref,
      });
      if (delivery) {
        await query(`UPDATE deliveries SET content = content || $2::jsonb WHERE id = $1`, [
          delivery.id,
          JSON.stringify({ emailId: queued.id, subject: outcome.subject, body: outcome.body }),
        ]);
      }
      if (queued.held) return wait(queued.taskId, "awaiting_approval");
      return finish("sent");
    }

    case "review": {
      const task = await createTask({
        kind: "approval",
        title: outcome.title,
        body: outcome.body,
        product: product.slug,
        customerId: customer.id,
        action: "approve_review",
        payload: { ...ref, saveAs: outcome.saveAs },
        dedupeKey: `review:${step ? `step:${step.id}` : `delivery:${delivery!.id}`}`,
      });
      return wait(task.id, "awaiting_approval");
    }

    case "manual": {
      const task = await createTask({
        kind: "manual",
        title: outcome.title,
        body: outcome.instructions,
        product: product.slug,
        customerId: customer.id,
        action: "complete_manual",
        payload: { ...ref, inputLabel: outcome.inputLabel, saveAs: outcome.saveAs, rerun: outcome.rerun ?? false },
        dedupeKey: `manual:${step ? `step:${step.id}` : `delivery:${delivery!.id}`}:${outcome.title}`,
      });
      return wait(task.id);
    }
  }
}

// -------------------------------------------------------------- routines

/**
 * The period a routine is due for today (UK time), or null if it isn't due.
 * Monthly routines catch up later in the month if a day was missed.
 */
export function duePeriod(cadence: Cadence, activatedAt: Date, now = new Date()): string | null {
  const t = londonParts(now);
  if (t.hour < 8) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  const activated = londonParts(activatedAt);
  const activatedDay = `${activated.year}-${pad(activated.month)}-${pad(activated.day)}`;

  if (cadence.every === "day") {
    if (cadence.weekdaysOnly && t.weekday > 5) return null;
    return activatedDay < today ? today : null;
  }
  if (cadence.every === "week") {
    if (t.weekday !== cadence.weekday) return null;
    return activatedDay < today ? today : null;
  }
  const targetDay = cadence.dayOfMonth === "anniversary" ? activated.day : cadence.dayOfMonth;
  const dueDay = Math.min(targetDay, daysInMonth(t.year, t.month));
  if (t.day < dueDay) return null;
  const dueDate = `${t.year}-${pad(t.month)}-${pad(dueDay)}`;
  // Nothing is due for a period that started before the customer was live.
  if (activatedDay >= dueDate) return null;
  return `${t.year}-${pad(t.month)}`;
}

export async function runRoutines(now = new Date()): Promise<{ created: number; ran: number }> {
  const customers = await query<CustomerRow>(`SELECT * FROM customers WHERE status = 'active' AND activated_at IS NOT NULL`);
  let created = 0;
  for (const customer of customers) {
    const product = requireProduct(customer.product);
    for (const routine of product.routines) {
      if (routine.plans && !routine.plans.includes(customer.plan)) continue;
      const period = duePeriod(routine.cadence, new Date(customer.activated_at!), now);
      if (!period) continue;
      const inserted = await one(
        `INSERT INTO deliveries (customer_id, product, routine, period) VALUES ($1,$2,$3,$4)
         ON CONFLICT (customer_id, routine, period) DO NOTHING RETURNING id`,
        [customer.id, product.slug, routine.key, period],
      );
      if (inserted) created++;
    }
  }

  // Run everything due (new, or failed and still retryable).
  const due = await query<DeliveryRow>(
    `SELECT d.* FROM deliveries d JOIN customers c ON c.id = d.customer_id
     WHERE c.status = 'active' AND (d.status = 'due' OR (d.status = 'failed' AND d.attempts < $1))
     ORDER BY d.created_at LIMIT 100`,
    [MAX_ATTEMPTS],
  );
  let ran = 0;
  for (const delivery of due) {
    await runDelivery(delivery);
    ran++;
  }
  return { created, ran };
}

export async function runDelivery(delivery: DeliveryRow, input?: string): Promise<void> {
  const customer = await loadCustomer(delivery.customer_id);
  if (!customer) return;
  if (await isProductPaused(customer.product)) return;
  const product = requireProduct(customer.product);
  const routine = product.routines.find((r) => r.key === delivery.routine);
  if (!routine) return;

  await query(`UPDATE deliveries SET status = 'working', attempts = attempts + 1 WHERE id = $1`, [delivery.id]);
  const ctx: HandlerContext = { product, customer, delivery, input: input ?? delivery.content.input };
  let outcome: Outcome;
  try {
    outcome = await getHandler(routine.handler)(ctx);
    if (outcome.type === "email") outcome = { ...outcome, approval: outcome.approval && routine.approval };
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      outcome = manualRoutine(routine, customer, err);
    } else {
      await failDelivery(delivery, customer, routine, err);
      return;
    }
  }
  await applyOutcome(outcome, ctx);
}

function manualRoutine(routine: RoutineDef, customer: CustomerRow, err: NotConfiguredError): Outcome {
  return {
    type: "manual",
    title: `${routine.title} (${customerLabel(customer)})`,
    instructions:
      `${routine.instructions ?? `Do "${routine.title}" for this customer by hand.`}\n\n` +
      `This is manual because ${err.message}. Mark it done when finished.`,
  };
}

async function failDelivery(delivery: DeliveryRow, customer: CustomerRow, routine: RoutineDef, err: unknown) {
  const message = errorMessage(err);
  await query(`UPDATE deliveries SET status = 'failed', last_error = $2 WHERE id = $1`, [delivery.id, message]);
  await logEvent({
    type: "routine.failed",
    level: "error",
    message: `${routine.title} for ${customerLabel(customer)}: ${message}`,
    product: customer.product,
    customerId: customer.id,
  });
  if (delivery.attempts + 1 >= MAX_ATTEMPTS) {
    await createTask({
      kind: "alert",
      priority: 1,
      title: `${routine.title} failed for ${customerLabel(customer)}`,
      body: `Failed ${MAX_ATTEMPTS} times. Last error: ${message}`,
      product: customer.product,
      customerId: customer.id,
      dedupeKey: `alert:delivery-failed:${delivery.id}`,
    });
  }
}

export async function retryDelivery(deliveryId: string): Promise<void> {
  await query(`UPDATE deliveries SET status = 'due', attempts = 0, last_error = NULL WHERE id = $1`, [deliveryId]);
  const delivery = await one<DeliveryRow>(`SELECT * FROM deliveries WHERE id = $1`, [deliveryId]);
  if (delivery) await runDelivery(delivery);
}
