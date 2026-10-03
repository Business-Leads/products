import { randomBytes } from "node:crypto";
import { one, query } from "../db/index.js";
import { emailOperator, queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import type { CustomerRow } from "./types.js";

// Good Questions research surveys, hosted by HQ (in place of ScoreApp). The
// sponsor approves the questions in their account; HQ builds the survey page,
// scores each response, emails the respondent their report, and the weekly
// findings for the sponsor are worked out from the stored answers.

export interface SurveyAnswer {
  text: string;
  points: number;
}
export interface SurveyQuestion {
  q: string;
  answers: SurveyAnswer[];
}
export interface SurveyArea {
  name: string;
  questions: SurveyQuestion[];
}
export interface SurveyBand {
  min: number;
  label: string;
  advice: string;
}
export interface Survey {
  title: string;
  intro: string;
  areas: SurveyArea[];
  bands: SurveyBand[];
}

export const surveySchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    intro: { type: "string" },
    areas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                q: { type: "string" },
                answers: {
                  type: "array",
                  items: { type: "object", properties: { text: { type: "string" }, points: { type: "integer" } }, required: ["text", "points"], additionalProperties: false },
                },
              },
              required: ["q", "answers"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "questions"],
        additionalProperties: false,
      },
    },
    bands: {
      type: "array",
      items: { type: "object", properties: { min: { type: "integer" }, label: { type: "string" }, advice: { type: "string" } }, required: ["min", "label", "advice"], additionalProperties: false },
    },
  },
  required: ["title", "intro", "areas", "bands"],
  additionalProperties: false,
} as const;

/** The survey as plain text, for the sponsor to read and approve. */
export function surveyText(s: Survey): string {
  const qs = s.areas
    .map((a) => `${a.name}\n${a.questions.map((q, i) => `  ${i + 1}. ${q.q}\n${q.answers.map((x) => `     - ${x.text}`).join("\n")}`).join("\n")}`)
    .join("\n\n");
  const bands = [...s.bands].sort((a, b) => b.min - a.min).map((b) => `- ${b.label} (${b.min}% and above): ${b.advice}`).join("\n");
  return `${s.title}\n\n${s.intro}\n\n${qs}\n\nResult bands:\n${bands}`;
}

export async function createSurvey(customer: CustomerRow, survey: Survey): Promise<string> {
  const token = randomBytes(9).toString("base64url");
  await query(`INSERT INTO gq_surveys (token, customer_id, questions) VALUES ($1, $2, $3)`, [token, customer.id, JSON.stringify(survey)]);
  return token;
}

export async function loadSurvey(token: string): Promise<{ survey: Survey; customer_id: string } | undefined> {
  const row = await one<{ questions: Survey; customer_id: string }>(`SELECT questions, customer_id FROM gq_surveys WHERE token = $1`, [token]);
  return row ? { survey: row.questions, customer_id: row.customer_id } : undefined;
}

export interface Scored {
  areas: Record<string, number>;
  total: number;
  band?: SurveyBand;
}

/** Each area as a percentage of its maximum points; the total is their average. */
export function scoreSurvey(survey: Survey, answers: Record<string, string>): Scored {
  const areas: Record<string, number> = {};
  survey.areas.forEach((a, ai) => {
    let got = 0;
    let max = 0;
    a.questions.forEach((q, qi) => {
      const top = Math.max(...q.answers.map((x) => x.points), 0);
      max += top;
      const chosen = Number(answers[`q${ai}_${qi}`]);
      if (Number.isInteger(chosen) && q.answers[chosen]) got += q.answers[chosen]!.points;
    });
    areas[a.name] = max ? Math.round((got / max) * 100) : 0;
  });
  const values = Object.values(areas);
  const total = values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : 0;
  const band = [...survey.bands].sort((a, b) => b.min - a.min).find((b) => total >= b.min);
  return { areas, total, band };
}

export async function saveResponse(
  token: string,
  survey: Survey,
  answers: Record<string, string>,
  who: { name?: string; email?: string; organisation?: string; role?: string; optIn: boolean },
): Promise<Scored> {
  const scored = scoreSurvey(survey, answers);
  await query(
    `INSERT INTO gq_responses (token, answers, scores, total, name, email, organisation, role, opt_in) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [token, JSON.stringify(answers), JSON.stringify(scored.areas), scored.total, who.name || null, who.email || null, who.organisation || null, who.role || null, who.optIn],
  );
  if (who.email) {
    const lines = Object.entries(scored.areas).map(([k, v]) => `- ${k}: ${v}%`).join("\n");
    await queueEmail({
      product: "goodquestions",
      kind: "survey_report",
      to: who.email,
      subject: `Your results: ${survey.title}`,
      body:
        `Hello${who.name ? ` ${who.name.split(/\s+/)[0]}` : ""},\n\nThank you for taking part. Your overall score is ${scored.total}%` +
        `${scored.band ? ` (${scored.band.label})` : ""}.\n\n${lines}\n\n${scored.band?.advice ?? ""}\n\n` +
        "Your answers are used, without your name, in published research. You can ask us to delete them at any time by replying to this email.\n\nFelix\nGood Questions",
    });
  }
  await logEvent({ type: "survey.response", message: `New response to "${survey.title}" (${scored.total}%)`, product: "goodquestions" });
  return scored;
}

/** Everything the weekly findings need, worked out from the stored answers. */
export async function surveyFindings(customer: CustomerRow): Promise<string | undefined> {
  const token: string | undefined = customer.data.gq_survey_token;
  if (!token) return undefined;
  const loaded = await loadSurvey(token);
  if (!loaded) return undefined;
  const all = await query<{ scores: Record<string, number>; total: number; created_at: string; role: string | null }>(
    `SELECT scores, total, created_at, role FROM gq_responses WHERE token = $1`,
    [token],
  );
  const week = all.filter((r) => new Date(r.created_at).getTime() > Date.now() - 7 * 864e5);
  if (!all.length) return `No responses yet (the survey has been sent; ${customer.data.gq_invites_sent ?? 0} invitations so far).`;
  const avg = (rows: typeof all, f: (r: (typeof all)[number]) => number) => (rows.length ? Math.round(rows.reduce((s, r) => s + f(r), 0) / rows.length) : 0);
  const areas = loaded.survey.areas.map((a) => `${a.name}: ${avg(all, (r) => r.scores[a.name] ?? 0)}%`).join(", ");
  const bands = [...loaded.survey.bands]
    .sort((a, b) => b.min - a.min)
    .map((b, i, arr) => {
      const upper = i === 0 ? 101 : arr[i - 1]!.min;
      return `${b.label}: ${all.filter((r) => r.total >= b.min && r.total < upper).length}`;
    })
    .join(", ");
  return (
    `Survey: ${loaded.survey.title}\nCompleted responses: ${all.length} in total, ${week.length} this week.\n` +
    `Average overall score: ${avg(all, (r) => r.total)}%.\nAverage by area: ${areas}.\nHow people fall into the bands: ${bands}.\n` +
    `Invitations sent so far: ${customer.data.gq_invites_sent ?? "not recorded"}.`
  );
}

export async function notifySponsorOfFirst(customer: CustomerRow): Promise<void> {
  await emailOperator(`Good Questions: first responses for ${customer.business ?? customer.name}`, "The survey is live and answers are coming in.", "client_activity");
}
