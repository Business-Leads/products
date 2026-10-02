import type { Product } from "./types.js";
import { BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

// Sold like Business Leads: the customer pays first, then books an onboarding
// call with Felix. The welcome page and welcome email both lead with the
// booking link; the intake form collects the details ahead of the call.

export const onlineBusinessBuilder: Product = {
  slug: "onlinebusinessbuilder",
  name: "Online Business Builder",
  tagline: "Get found by local customers",
  description:
    "For any business that serves local customers: a fast, professional website built for Google and AI " +
    "search, with hosting and updates included, plus a Google Business Profile run for them (posts every " +
    "week, reviews answered) and a monthly ranking report. £99 a month, no setup fee.",
  entity: "Online Business Builder, onlinebusinessbuilder.co.uk",
  siteUrls: ["https://onlinebusinessbuilder.netlify.app"],
  bookingUrl: BOOKING_URL,
  bookingAfterPurchase: true,
  email: { from: fromAddress("onlinebusinessbuilder", "hello@business-leads.co.uk"), fromName: "Online Business Builder" },
  voice: `${HOUSE_VOICE} Speak to a busy local business owner. Never promise rankings or outcomes.`,
  plans: [
    {
      id: "monthly",
      name: "Website and Google profile",
      amountPence: 9900,
      interval: "month",
      summary: "No setup fee and nothing extra to buy. Website, Google profile, weekly posts, reviews answered, monthly report.",
    },
  ],
  intake: [
    { key: "business", label: "Business name", type: "text", required: true },
    { key: "business_type", label: "What kind of business is it?", type: "text", required: true },
    { key: "area", label: "Town or area you serve", type: "text", required: true },
    { key: "phone", label: "Business phone number", type: "tel", required: true },
    { key: "website", label: "Current website, if you have one", type: "url" },
    { key: "gbp_name", label: "Your business name as it appears on Google Maps (if you have a profile)", type: "text" },
    { key: "services", label: "Your main services, and anything you want customers to know", type: "textarea", required: true },
    { key: "hours", label: "Opening hours", type: "textarea" },
    { key: "brand", label: "Logo, colours or photos we should use (a link to a folder is fine)", type: "textarea" },
    { key: "notes", label: "Anything else for the onboarding call", type: "textarea" },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "onboarding_call",
      title: "Onboarding call with Felix booked and held",
      kind: "manual",
      instructions:
        "The customer was sent the booking link straight after paying. Hold the onboarding call: confirm " +
        "services, area and the look they want, and agree how to get manager access to their Google " +
        "Business Profile (or create one). Mark done after the call.",
    },
    {
      key: "gbp_access",
      title: "Manager access to the Google Business Profile",
      kind: "manual",
      instructions:
        "Request or accept manager access to the customer's Google Business Profile (or create and verify a new " +
        "profile). Record the profile name on the customer. Start weekly posting once access is in place.",
    },
    {
      key: "website_design",
      title: "Build the website design and send it for approval",
      kind: "manual",
      instructions:
        "Build the site from the intake answers and the call notes, set it up for Google and AI search, and send " +
        "the customer the preview link to approve.",
    },
    {
      key: "design_approved",
      title: "Customer approves the design; site goes live",
      kind: "manual",
      instructions: "When the customer approves (or after their changes are made), publish the site and mark this done.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "weekly_post",
      title: "Weekly Google Business Profile post",
      cadence: { every: "week", weekday: 2 },
      handler: "obb_weekly_post",
      approval: true,
    },
    {
      key: "reviews",
      title: "Answer new Google reviews",
      cadence: { every: "week", weekday: 4 },
      handler: "obb_reviews",
      approval: true,
      instructions: "Open the customer's Google Business Profile and reply to any new reviews in their voice.",
    },
    {
      key: "monthly_report",
      title: "Monthly ranking report",
      cadence: { every: "month", dayOfMonth: "anniversary" },
      handler: "obb_monthly_report",
      approval: true,
    },
  ],
  tools: ["anthropic", "smtp", "stripe"],
  leadBrief:
    "Thank them, answer what they asked using only the facts given, and invite them to start: it's £99 a " +
    "month with no setup fee, and straight after signing up they book an onboarding call with Felix.",
  leadFollowUpDays: [2, 7],
  pauseAfterPastDueDays: 14,
};
