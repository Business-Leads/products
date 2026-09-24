import type { Product } from "./types.js";
import { AIFT, BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

export const speedToLead: Product = {
  slug: "speedtolead",
  name: "Speed to Lead",
  tagline: "Every missed call answered, booked and passed to you",
  description:
    "An automated assistant (Awaz.ai) answers the calls a local trade business misses, in the firm's " +
    "name. It says it is automated and that the call is recorded, takes name, postcode and job, checks " +
    "the area, books a slot the owner has made available, and texts and emails the owner. Urgent calls " +
    "go straight to the owner's mobile. The customer keeps their number and forwards only missed calls.",
  entity: `Speed to Lead is a trading name of ${AIFT}`,
  siteUrls: ["https://speedtolead-1rg1.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("speedtolead", "hello@business-leads.co.uk"), fromName: "Speed to Lead" },
  voice: `${HOUSE_VOICE} Speak to a busy tradesperson; be practical and brief.`,
  plans: [
    {
      id: "solo",
      name: "Solo",
      amountPence: 14900,
      interval: "month",
      setupFeePence: 19500,
      summary: "Up to 150 calls a month. The setup fee is refunded if you are unhappy in the first 30 days.",
    },
    {
      id: "team",
      name: "Team",
      amountPence: 24900,
      interval: "month",
      setupFeePence: 19500,
      summary: "Up to 300 calls a month, urgent call transfer and more than one diary.",
    },
  ],
  intake: [
    { key: "business", label: "Business name (as the assistant should say it)", type: "text", required: true },
    { key: "trade", label: "Your trade", type: "text", required: true, help: "e.g. plumbing and heating" },
    { key: "services", label: "Services you offer, and any prices the assistant may quote", type: "textarea", required: true },
    { key: "postcodes", label: "Postcodes you cover, and areas too far to cover", type: "textarea", required: true },
    { key: "hours", label: "Opening hours", type: "textarea", required: true },
    { key: "slots", label: "When can the assistant book jobs in? (days and time slots)", type: "textarea", required: true },
    { key: "urgent", label: "What counts as urgent for you?", type: "textarea", required: true },
    { key: "urgent_number", label: "Mobile for urgent call transfer", type: "tel", required: true },
    { key: "notify_mobile", label: "Mobile for booking texts", type: "tel", required: true },
    { key: "notify_email", label: "Email for booking notifications", type: "email", required: true },
    { key: "business_number", label: "The business number callers ring", type: "tel", required: true },
    { key: "phone_provider", label: "Who provides that phone line?", type: "text", required: true },
    {
      key: "retention",
      label: "How long should call recordings be kept?",
      type: "select",
      options: ["30 days", "90 days", "6 months", "12 months"],
      required: true,
    },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "dpa",
      title: "Send data processing agreement",
      kind: "auto",
      handler: "stl_send_dpa",
    },
    {
      key: "script",
      title: "Draft the call script from the intake",
      kind: "approval",
      handler: "stl_draft_script",
    },
    {
      key: "provision_agent",
      title: "Create the assistant and phone number in Awaz",
      kind: "auto",
      handler: "stl_provision_agent",
      instructions:
        "In Awaz: create an assistant from the approved script, attach a UK number, set call transfer to " +
        "the urgent mobile, SMS and email notifications, the booking calendar, and the recording retention " +
        "period. Record the assistant id and the forwarding number on the customer.",
    },
    {
      key: "forwarding",
      title: "Customer sets up call forwarding on busy/no answer",
      kind: "customer",
      handler: "stl_forwarding_instructions",
    },
    {
      key: "test_calls",
      title: "Test calls with the owner",
      kind: "manual",
      instructions:
        "Ring the business number and let it go unanswered to confirm forwarding. Make three test calls with " +
        "the owner: a normal booking, an out-of-area enquiry and an urgent call. Adjust the script if needed.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "call_review",
      title: "Weekly review of calls and script improvements",
      cadence: { every: "week", weekday: 2 },
      handler: "stl_call_review",
      approval: true,
    },
    {
      key: "usage_summary",
      title: "Monthly call summary and plan usage",
      cadence: { every: "month", dayOfMonth: "anniversary" },
      handler: "stl_usage_summary",
      approval: false,
    },
  ],
  tools: ["awaz", "anthropic", "smtp", "stripe"],
  leadFollowUpDays: [2, 7],
  pauseAfterPastDueDays: 14,
};
