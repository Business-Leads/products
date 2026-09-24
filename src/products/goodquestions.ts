import type { Product } from "./types.js";
import { AIFT, BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

export const goodQuestions: Product = {
  slug: "goodquestions",
  name: "Good Questions",
  tagline: "Research for organisations, built on good questions",
  description:
    "Business research service. Decision-makers are invited to a free 15-question AI readiness " +
    "assessment (ScoreApp) and get a score and report; the answers become publishable research, and " +
    "opt-ins join the Good Questions Panel. Clients buy sponsored assessments, bespoke research or a " +
    "scorecard on their own account. Priced per engagement.",
  entity: `Good Questions is a trading name of ${AIFT}`,
  siteUrls: ["https://good-questions.netlify.app"],
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
      title: "Agree the questions with the sponsor",
      kind: "manual",
      instructions: "Design the 15 questions and bands with the sponsor and get written sign-off.",
    },
    {
      key: "compliance",
      title: "Compliance sign-off (legitimate interests, privacy, retention)",
      kind: "manual",
      instructions: "Complete the legitimate interests assessment and privacy wording for this campaign.",
    },
    {
      key: "scorecard",
      title: "Build the scorecard in ScoreApp",
      kind: "auto",
      handler: "gq_build_scorecard",
      instructions: "Clone the scorecard template in ScoreApp, apply the agreed questions and branding, and test it end to end.",
    },
    {
      key: "sends",
      title: "Schedule the invitation sends",
      kind: "manual",
      instructions: "Create the invitation campaigns in Mailpulse with rest periods between lists.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "findings",
      title: "Weekly findings summary for the sponsor",
      cadence: { every: "week", weekday: 4 },
      handler: "gq_findings",
      approval: true,
    },
  ],
  tools: ["scoreapp", "anthropic", "smtp"],
  leadBrief:
    "Enquiries come from organisations thinking about sponsored or bespoke research. Ask what they want " +
    "to learn and offer a short call to scope it; do not quote prices.",
  leadFollowUpDays: [4, 12],
  pauseAfterPastDueDays: 30,
};
