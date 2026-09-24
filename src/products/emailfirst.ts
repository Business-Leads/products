import type { Product } from "./types.js";
import { BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

export const emailFirst: Product = {
  slug: "emailfirst",
  name: "EmailFirst",
  tagline: "We email 3,000 UK decision makers a week for you",
  description:
    "Done-for-you UK B2B cold email, openly run by AI. A free pitch check, then three emails and a " +
    "landing page written for the client, sends to 3,000 UK decision makers a week from the Mailpulse " +
    "platform, and a report each weekday of verified human clicks with a follow-up already drafted.",
  entity: "EmailFirst is a trading name of Emailfirst Limited (company 14162647)",
  siteUrls: ["https://emailfirst.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("emailfirst", "hello@business-leads.co.uk"), fromName: "EmailFirst" },
  voice: `${HOUSE_VOICE} Be open that the service is run by AI with a person checking it.`,
  plans: [
    {
      id: "weekly",
      name: "EmailFirst",
      amountPence: 1900,
      interval: "week",
      summary: "No contract. 3,000 sends a week and a report every weekday.",
    },
  ],
  addOns: [
    { id: "phones", name: "Direct phone numbers", amountPence: 1000, recurring: true },
    { id: "voice", name: "Morning AI voice call", amountPence: 1000, recurring: true },
    { id: "audience2", name: "Second audience", amountPence: 1500, recurring: true },
    { id: "video", name: "Video sales page", amountPence: 9500, recurring: false },
  ],
  intake: [
    { key: "company", label: "Company", type: "text", required: true },
    { key: "website", label: "Website", type: "url", required: true },
    { key: "offer", label: "What you sell and why buyers choose you", type: "textarea", required: true },
    { key: "audience", label: "Who should we email? (job titles, sectors, company size, region)", type: "textarea", required: true },
    { key: "proof", label: "Proof we can use (results, clients, numbers)", type: "textarea" },
    { key: "sender_name", label: "Name the emails come from", type: "text", required: true },
    { key: "reply_to", label: "Reply-to address", type: "email", required: true },
    { key: "cta", label: "What should interested people do? (book a call, visit a page...)", type: "text", required: true },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "copy",
      title: "Write 3 emails and landing page copy",
      kind: "approval",
      handler: "ef_draft_copy",
    },
    {
      key: "customer_approves_copy",
      title: "Customer approves the copy",
      kind: "customer",
      handler: "ef_customer_copy_approval",
    },
    {
      key: "provision_sending",
      title: "Create list, template and campaigns in MailWizz",
      kind: "auto",
      handler: "ef_provision_sending",
      instructions:
        "In the Mailpulse/MailWizz customer area: create the client's list and custom fields, upload the three " +
        "approved emails as templates, create the campaigns with the sender name and reply-to from the intake, " +
        "and add the client to the daily sending matrix and Hot Prospects report.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "weekly_summary",
      title: "Weekly results summary",
      cadence: { every: "week", weekday: 5 },
      handler: "ef_weekly_summary",
      approval: false,
    },
  ],
  tools: ["mailwizz", "anthropic", "smtp", "stripe"],
  leadBrief:
    "This reply is the free pitch check. From what they told us, say plainly what is strong about their " +
    "offer, what a UK decision maker would doubt, and one or two changes that would make a cold email land. " +
    "If there is too little to judge, ask the three questions that would let us check it. Nothing is charged " +
    "until the pitch has passed the check and they choose to go ahead.",
  leadFollowUpDays: [2, 6],
  pauseAfterPastDueDays: 7,
};
