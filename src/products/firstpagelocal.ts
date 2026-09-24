import type { Product } from "./types.js";
import { AIFT, BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

export const firstPageLocal: Product = {
  slug: "firstpagelocal",
  name: "FirstPageLocal",
  tagline: "AI recommends three local businesses. Are you one of them?",
  description:
    "Monthly email report for UK local businesses: whether ChatGPT, Gemini and Google's AI recommend " +
    "them for their own searches, who is recommended instead, their Google Maps position across a grid " +
    "of their area, what changed since last month, and a prioritised list of fixes. Needs no access to " +
    "any of the customer's accounts. Every report is read by a person before it is sent.",
  entity: `FirstPageLocal is a trading name of ${AIFT}`,
  siteUrls: ["https://firstpagelocal.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: {
    from: fromAddress("firstpagelocal", "hello@firstpagelocal.com"),
    fromName: "FirstPageLocal",
  },
  voice: `${HOUSE_VOICE} Speak to a busy local business owner. Never promise rankings or outcomes.`,
  plans: [
    {
      id: "monthly",
      name: "Monthly report",
      amountPence: 2900,
      interval: "month",
      summary: "No contract. One report a month by email.",
    },
  ],
  intake: [
    { key: "business", label: "Business name", type: "text", required: true },
    { key: "town", label: "Town or city you serve", type: "text", required: true },
    { key: "website", label: "Website", type: "url" },
    { key: "gbp_name", label: "Name exactly as it appears on Google Maps", type: "text", required: true },
    {
      key: "searches",
      label: "What do customers search for? (one per line, up to 5)",
      type: "textarea",
      required: true,
      help: "For example: electrician stockport, emergency electrician near me",
    },
    { key: "service_radius", label: "Roughly how far do you travel for work? (miles)", type: "text" },
    { key: "report_email", label: "Email for the monthly report", type: "email", required: true },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "provision_scans",
      title: "Set up location, searches and grid in the scan tool",
      kind: "auto",
      handler: "fpl_provision_scans",
      instructions:
        "In Local Falcon: add the business location (search by the Google Maps name and town), add each " +
        "search from the intake as a keyword, set the grid radius from the service radius, and add the AI " +
        "visibility checks (ChatGPT, Gemini, AI Overviews, AI Mode). Record the location id on the customer.",
    },
    {
      key: "baseline_report",
      title: "Run baseline scan and send first report",
      kind: "approval",
      handler: "fpl_first_report",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "monthly_report",
      title: "Monthly AI visibility report",
      cadence: { every: "month", dayOfMonth: "anniversary" },
      handler: "fpl_monthly_report",
      approval: true,
    },
  ],
  tools: ["localfalcon", "anthropic", "smtp", "stripe"],
  leadFollowUpDays: [3, 10],
  pauseAfterPastDueDays: 14,
};
