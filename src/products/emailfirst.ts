import type { Product } from "./types.js";
import { BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps, sharedPortalSteps } from "./shared.js";

export const emailFirst: Product = {
  slug: "emailfirst",
  name: "EmailFirst",
  tagline: "We email 3,000 UK decision makers a week for you",
  description:
    "Done-for-you UK B2B cold email, openly run by AI. A free pitch check, then three emails and a " +
    "landing page written for the client, sends to 3,000 UK decision makers a week from the Mailpulse " +
    "platform, and a report each weekday of verified human clicks with a follow-up already drafted.",
  entity: "EmailFirst is a trading name of Emailfirst Limited (company 14162647)",
  siteUrls: ["https://emailfirst.co.uk", "https://www.emailfirst.co.uk", "https://emailfirst.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("emailfirst", "hello@emailfirst.co.uk"), fromName: "EmailFirst" },
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
      title: "Client approves their 3 emails and landing page copy",
      kind: "customer",
      handler: "ef_draft_copy",
      revisable: true,
      instructions: "AI writes the three emails and landing page copy from their answers; the client approves them in their account or asks for changes.",
    },
    {
      key: "landing_page",
      title: "Landing page built and published in Mailpulse",
      kind: "auto",
      handler: "ef_landing_page",
      instructions: "HQ builds the approved landing page copy into a MailWizz landing page in the client's colours, publishes it, and links the emails to it.",
    },
    {
      key: "provision_sending",
      title: "Audience matched in our database and templates created in Mailpulse",
      kind: "auto",
      handler: "ef_provision_sending",
      instructions: "HQ turns their audience into search filters on our prospect database, checks there are enough people, and creates the email templates.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "daily_send",
      title: "Today's sends (about 600 new contacts, plus follow-ups)",
      cadence: { every: "day", weekdaysOnly: true },
      handler: "ef_daily_send",
      approval: false,
    },
    {
      key: "daily_report",
      title: "Morning report of who clicked",
      cadence: { every: "day", weekdaysOnly: true },
      handler: "ef_daily_report",
      approval: false,
    },
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
  portal: {
    host: "account.emailfirst.co.uk",
    accent: "#D42A19",
    resultsTitle: "Your campaign results",
    resultsIntro: "Emails sent to your audience and the people who responded.",
    steps: { ...sharedPortalSteps, copy: "You approve your emails and landing page", landing_page: "Your landing page goes live", provision_sending: "Sending set up" },
    routines: { daily_send: null, daily_report: "Daily clicks report", weekly_summary: "Weekly results" },
    metrics: [
      { key: "emails_sent", label: "Emails sent" },
      { key: "human_clicks", label: "Verified clicks" },
      { key: "replies", label: "Replies" },
    ],
  },
};
