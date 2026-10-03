import type { Product } from "./types.js";
import { AIFT, BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps, sharedPortalSteps } from "./shared.js";

export const goodQuestions: Product = {
  slug: "goodquestions",
  name: "Good Questions",
  tagline: "Research for organisations, built on good questions",
  description:
    "Business research service. Decision-makers are invited to a free 15-question AI readiness " +
    "assessment and get a score and report; the answers become publishable research, and " +
    "opt-ins join the Good Questions Panel. Clients buy sponsored assessments, bespoke research or a " +
    "scorecard on their own account. Priced per engagement.",
  entity: `Good Questions is a trading name of ${AIFT}`,
  siteUrls: ["https://goodquestions.co.uk", "https://www.goodquestions.co.uk", "https://good-questions.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("goodquestions", "felix@goodquestions.co.uk"), fromName: "Felix at Good Questions" },
  voice: `${HOUSE_VOICE} Thoughtful and research-led; never salesy.`,
  plans: [
    {
      id: "engagement",
      name: "Research engagement",
      amountPence: 0,
      interval: "month",
      summary: "Quoted individually. A 4–6 week campaign.",
    },
  ],
  quoted: true,
  intake: [
    { key: "organisation", label: "Organisation", type: "text", required: true },
    { key: "objective", label: "What do you want to learn, and who will use the findings?", type: "textarea", required: true },
    { key: "audience", label: "Who should answer? (roles, sectors, size, region)", type: "textarea", required: true },
    { key: "timing", label: "When do you need results?", type: "text" },
    { key: "branding", label: "Sponsored, co-branded or on your own account?", type: "select", options: ["Sponsored", "Co-branded", "Own account"] },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "question_design",
      title: "Sponsor approves the research questions",
      kind: "customer",
      handler: "gq_questions",
      revisable: true,
      instructions: "AI drafts fifteen questions in five areas from the brief; the sponsor approves them, or asks for changes and gets a new draft.",
    },
    {
      key: "compliance",
      title: "Sponsor approves the privacy and invitation wording",
      kind: "customer",
      handler: "gq_compliance",
      revisable: true,
      instructions: "AI drafts the legitimate interests note, privacy wording, invitation email and retention period for the sponsor to approve.",
    },
    {
      key: "scorecard",
      title: "Survey page built",
      kind: "auto",
      handler: "gq_build_survey",
      instructions: "HQ builds the survey page from the approved questions; respondents get their scores and a short report.",
    },
    {
      key: "sends",
      title: "Invitations scheduled",
      kind: "auto",
      handler: "gq_send_invites",
      instructions: "Invitations go to the agreed audience from our prospect database through Mailpulse, with rest periods between sends.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "daily_invites",
      title: "Today's invitations (up to 300)",
      cadence: { every: "day", weekdaysOnly: true },
      handler: "gq_daily_invites",
      approval: false,
    },
    {
      key: "findings",
      title: "Weekly findings summary for the sponsor",
      cadence: { every: "week", weekday: 4 },
      handler: "gq_findings",
      approval: false,
    },
  ],
  tools: ["mailwizz", "anthropic", "smtp"],
  leadBrief:
    "Enquiries come from organisations thinking about sponsored or bespoke research. Ask what they want " +
    "to learn and offer a short call to scope it; do not quote prices.",
  leadFollowUpDays: [4, 12],
  pauseAfterPastDueDays: 30,
  portal: {
    host: "account.goodquestions.co.uk",
    accent: "#D42A19",
    resultsTitle: "Your research",
    resultsIntro: "Responses collected and what they show.",
    steps: { ...sharedPortalSteps, question_design: "Questions agreed", compliance: "Compliance checks", scorecard: "Your scorecard built", sends: "Invitations scheduled" },
    routines: { daily_invites: null, findings: "Weekly findings" },
    metrics: [
      { key: "completions", label: "Completed responses" },
      { key: "average_score", label: "Average score" },
    ],
  },
};
