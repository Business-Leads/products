import type { Product } from "./types.js";
import { BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps, sharedPortalSteps } from "./shared.js";

export const emailFirst: Product = {
  slug: "emailfirst",
  name: "EmailFirst",
  tagline: "More conversations with qualified buyers",
  // Matches the live site (emailfirst.co.uk, updated Oct 2026): a monthly email
  // campaign, with LinkedIn management available at three levels on top.
  description:
    "B2B email campaigns and LinkedIn management for UK businesses that sell to other businesses. " +
    "Offer development, a prospect list matched to the client's ideal customer (data supplied), a custom " +
    "email sequence and landing page, sending on our platform and a daily report of the decision makers " +
    "who engaged. LinkedIn follow-up from the client's own profile can be added at three levels.",
  entity: "EmailFirst is a trading name of Emailfirst Limited (company 14162647)",
  siteUrls: ["https://emailfirst.co.uk", "https://www.emailfirst.co.uk", "https://emailfirst.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("emailfirst", "hello@emailfirst.co.uk"), fromName: "EmailFirst" },
  voice: `${HOUSE_VOICE} Professional and plain. Felix stays involved with every client; never claim a person wrote or checked something they did not.`,
  plans: [
    {
      id: "campaign",
      name: "The email campaign",
      amountPence: 49900,
      interval: "month",
      summary: "Billed monthly, no minimum term. Offer development, prospect list, email sequence, landing page and a daily engagement report.",
    },
  ],
  // LinkedIn management on top of the campaign, as sold on the site.
  addOns: [
    { id: "linkedin_starter", name: "LinkedIn Starter", amountPence: 19900, recurring: true },
    { id: "linkedin_business", name: "LinkedIn Business", amountPence: 34900, recurring: true },
    { id: "linkedin_growth", name: "LinkedIn Growth", amountPence: 64900, recurring: true },
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
    "From what they told us, say plainly what is strong about their offer and what a UK decision maker " +
    "would want to know before replying, then invite them to book a short chat with Felix to agree their " +
    "ideal customer and develop the offer before anything is launched. The campaign is £499 a month with " +
    "no minimum term; LinkedIn management can be added from £199 a month.",
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
