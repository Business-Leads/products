import type { Product } from "./types.js";
import { BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps, sharedPortalSteps } from "./shared.js";

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
  siteUrls: ["https://onlinebusinessbuilder.co.uk", "https://www.onlinebusinessbuilder.co.uk", "https://onlinebusinessbuilder.netlify.app"],
  bookingUrl: BOOKING_URL,
  bookingAfterPurchase: true,
  email: { from: fromAddress("onlinebusinessbuilder", "hello@onlinebusinessbuilder.co.uk"), fromName: "Online Business Builder" },
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
      handler: "obb_call_notes",
      instructions:
        "The customer was sent the booking link straight after paying. Hold the onboarding call: confirm " +
        "services, area and the look they want, and agree how to get manager access to their Google " +
        "Business Profile (or create one).",
      guide: {
        why: "It's your call with the client.",
        minutes: 30,
        steps: [
          "The client books the call straight after paying. It appears in your calendar.",
          "On the call, confirm their services, the area they cover, the look they want and anything to avoid.",
          "Ask them to add you as a manager on their Google Business Profile, or tell them you'll create one.",
          "Type your notes below and save. Their website is written and sent to them for approval straight away.",
        ],
      },
    },
    {
      key: "gbp_access",
      title: "Manager access to the Google Business Profile",
      kind: "manual",
      instructions:
        "Request or accept manager access to the customer's Google Business Profile (or create and verify a new " +
        "profile). Record the profile name on the customer. Start weekly posting once access is in place.",
      guide: {
        why: "Google only lets the business owner give access to their profile.",
        minutes: 10,
        steps: [
          "Look for the Google email inviting you to manage their profile and accept it (or go to business.google.com).",
          "If they have no profile, create one at business.google.com and request verification.",
          "Mark this done. Weekly Google posts start by themselves.",
        ],
      },
    },
    {
      key: "website_design",
      title: "Website written and published for the client to see",
      kind: "auto",
      handler: "obb_build_site",
      instructions: "Build the site from the intake answers and call notes, publish it, and send the client the preview.",
    },
    {
      key: "design_approved",
      title: "Client approves the website",
      kind: "customer",
      handler: "await_client_approval",
    },
    {
      key: "domain",
      title: "Web address connected",
      kind: "auto",
      handler: "obb_domain",
      instructions: "Connect the client's web address to their site (theirs, or one bought with your approval).",
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
      guide: {
        why: "Google doesn't let other systems post to Business Profiles yet.",
        minutes: 5,
        steps: [
          "Read the post below.",
          "Open the client's profile at business.google.com and choose Add update.",
          "Paste the post, add a photo if you have one, and publish.",
          "Mark this done.",
        ],
      },
    },
    {
      key: "reviews",
      title: "Answer new Google reviews",
      cadence: { every: "week", weekday: 4 },
      handler: "obb_reviews",
      approval: true,
      instructions: "Open the customer's Google Business Profile and reply to any new reviews in their voice.",
      guide: {
        why: "Google doesn't let other systems answer reviews yet.",
        minutes: 10,
        steps: [
          "Open the client's profile at business.google.com and go to Reviews.",
          "Reply to each new review: thank them by name, keep it short, and never argue.",
          "Mark this done.",
        ],
      },
    },
    {
      key: "monthly_report",
      title: "Monthly ranking report",
      cadence: { every: "month", dayOfMonth: "anniversary" },
      handler: "obb_monthly_report",
      approval: true,
    },
  ],
  tools: ["anthropic", "smtp", "stripe", "netlify", "godaddy"],
  leadBrief:
    "Thank them, answer what they asked using only the facts given, and invite them to start: it's £99 a " +
    "month with no setup fee, and straight after signing up they book an onboarding call with Felix.",
  leadFollowUpDays: [2, 7],
  pauseAfterPastDueDays: 14,
  portal: {
    host: "account.onlinebusinessbuilder.co.uk",
    accent: "#D42A19",
    resultsTitle: "Your website and Google profile",
    resultsIntro: "Your site, your Google profile and how local customers are finding you.",
    steps: { ...sharedPortalSteps, onboarding_call: "Onboarding call", gbp_access: "Access to your Google Business Profile", website_design: "Your website built", design_approved: "You approve your website", domain: "Your web address connected" },
    routines: { weekly_post: "Weekly Google post", reviews: "Google reviews answered", monthly_report: "Monthly report" },
    metrics: [
      { key: "profile_views", label: "Google profile views" },
      { key: "calls", label: "Calls from Google" },
      { key: "direction_requests", label: "Direction requests" },
      { key: "website_visits", label: "Website visits" },
      { key: "new_reviews", label: "New reviews" },
    ],
  },
};
