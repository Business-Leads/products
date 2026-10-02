import { one, query } from "../db/index.js";
import { emailOperator, queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { createTask } from "../lib/tasks.js";

// The Good Questions AI readiness assessment (goodquestions.co.uk/ai-readiness).
// The page scores the answers on screen; this stores each result for the
// research, emails the written report when asked, and only treats someone as
// an enquiry if they tick "I'd like help". Taking part is not an enquiry.

export const AREAS = ["strategy", "leadership", "people", "data", "implementation"] as const;
type AreaKey = (typeof AREAS)[number];

const AREA_NAMES: Record<AreaKey, string> = {
  strategy: "Strategy",
  leadership: "Leadership",
  people: "People",
  data: "Data",
  implementation: "Implementation",
};

const ADVICE: Record<AreaKey, string> = {
  strategy: "Write down three tasks where AI would save real time, and put them in order.",
  leadership: "Name one person who decides how AI is used in the business, and tell everyone who it is.",
  people: "Give your team a one-page guide to what they can and cannot use AI for.",
  data: "Agree which company information must never go into a public AI tool, and write it down.",
  implementation: "Turn one AI experiment into a written, repeatable process, and measure the time it saves.",
};

export interface AssessmentInput {
  ref?: string;
  scores?: Record<string, unknown>;
  answers?: unknown;
  name?: string;
  email?: string;
  business?: string;
  wants_help?: unknown;
}

function clean(scores: Record<string, unknown> | undefined): Record<AreaKey, number> | null {
  const out = {} as Record<AreaKey, number>;
  for (const a of AREAS) {
    const v = Number(scores?.[a]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    out[a] = Math.round(v);
  }
  return out;
}

export function overall(scores: Record<AreaKey, number>): number {
  return Math.round(AREAS.reduce((s, a) => s + scores[a], 0) / AREAS.length);
}

export function nextSteps(scores: Record<AreaKey, number>): string[] {
  return [...AREAS].sort((a, b) => scores[a] - scores[b]).slice(0, 3).map((a) => ADVICE[a]);
}

export async function handleAssessment(input: AssessmentInput): Promise<{ ok: boolean; error?: string }> {
  const scores = clean(input.scores);
  if (!scores) return { ok: false, error: "Scores are missing" };
  const ref = String(input.ref ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const email = String(input.email ?? "").trim().toLowerCase().slice(0, 320) || null;
  const wantsHelp = input.wants_help === true || input.wants_help === "yes" || input.wants_help === "on";
  const total = overall(scores);
  const data = { ref, scores, overall: total, answers: input.answers ?? null, wants_help: wantsHelp };

  // The anonymous result is saved when they finish; contact details, if given, are added to the same record.
  const existing = ref
    ? await one<{ id: string; email: string | null }>(`SELECT id, email FROM leads WHERE product = 'goodquestions' AND data->>'ref' = $1`, [ref])
    : undefined;
  let id: string;
  if (existing) {
    if (existing.email && existing.email !== email) return { ok: true }; // already completed; ignore changes
    await query(
      `UPDATE leads SET name = COALESCE($2, name), email = COALESCE($3, email), business = COALESCE($4, business),
         data = data || $5::jsonb, updated_at = now() WHERE id = $1`,
      [existing.id, input.name?.trim() || null, email, input.business?.trim() || null, JSON.stringify(data)],
    );
    id = existing.id;
  } else {
    const row = await one<{ id: string }>(
      `INSERT INTO leads (product, name, email, business, data, source, status)
       VALUES ('goodquestions', $1, $2, $3, $4, 'AI readiness assessment', 'assessment') RETURNING id`,
      [input.name?.trim() || null, email, input.business?.trim() || null, data],
    );
    id = row!.id;
    await logEvent({ type: "assessment.completed", message: `AI readiness assessment completed (${total}/100)`, product: "goodquestions", leadId: id });
  }

  if (email && !existing?.email) {
    const lines = AREAS.map((a) => `  ${AREA_NAMES[a]}: ${scores[a]}`).join("\n");
    await queueEmail({
      product: "goodquestions",
      leadId: id,
      kind: "assessment_report",
      to: email,
      subject: `Your AI readiness score: ${total} out of 100`,
      body:
        `Hello${input.name ? ` ${input.name.trim().split(/\s+/)[0]}` : ""},\n\nThank you for taking the AI readiness assessment. ` +
        `Here is your written report.\n\nYour score: ${total} out of 100\n\n${lines}\n\n` +
        `What to do next, in order:\n\n${nextSteps(scores).map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
        `A low score is not a verdict. It is a short list of the things worth doing first.\n\n` +
        (wantsHelp
          ? "You asked for help improving your score, so we will be in touch within two working days.\n\n"
          : "You told us you don't need help, so you won't hear from us again about this.\n\n") +
        `Good Questions`,
    });
    if (wantsHelp) {
      await query(`UPDATE leads SET status = 'new', next_touch_at = NULL WHERE id = $1`, [id]);
      await createTask({
        kind: "manual",
        priority: 1,
        title: `${input.business || input.name || email} would like help with their AI readiness (${total}/100)`,
        body: `They took the assessment and asked for help improving their score.\n\nEmail: ${email}\n\nScores:\n${lines}\n\nGet in touch within two working days.`,
        product: "goodquestions",
        leadId: id,
        dedupeKey: `assessment-help:${id}`,
      });
      await emailOperator(
        `Good Questions: ${input.business || input.name || email} would like help (${total}/100)`,
        `They took the AI readiness assessment and asked for help.\n\nEmail: ${email}\n\nScores:\n${lines}`,
        "client_activity",
      );
    }
  }
  return { ok: true };
}
