import type { Product } from "./types.js";
import { AIFT, BOOKING_URL, HOUSE_VOICE, fromAddress, goLiveStep, welcomeSteps } from "./shared.js";

// Hard rules carried over from the Linkn operating guide and skill:
// every outward action on LinkedIn (launching a campaign, sending a reply,
// importing billable leads, publishing a post) needs a person's approval, and
// each action is identity-checked against the client's own FeedBoss workspace
// and Sbl.so sender. The routines below therefore draft and queue; they never
// post or send on LinkedIn by themselves.

export const linkn: Product = {
  slug: "linkn",
  name: "Linkn",
  tagline: "Done-for-you LinkedIn lead generation from your own profile",
  description:
    "For small UK B2B firms that rely on referrals. Three posts a week written in the client's voice " +
    "(FeedBoss), outreach to the people they want to meet starting with those who engaged with their " +
    "posts (Sbl.so), replies handled, and on Growth a monthly telephone follow-up day.",
  entity: `Linkn is a trading name of ${AIFT}`,
  siteUrls: ["https://linkn-co-uk.netlify.app"],
  bookingUrl: BOOKING_URL,
  email: { from: fromAddress("linkn", "felix@linkn.co.uk"), fromName: "Felix at Linkn" },
  voice: `${HOUSE_VOICE} Collegiate and personal; Felix runs the service himself.`,
  plans: [
    {
      id: "starter",
      name: "Starter",
      amountPence: 19900,
      interval: "month",
      summary: "Three posts a week in your voice. No minimum term.",
    },
    {
      id: "business",
      name: "Business",
      amountPence: 34900,
      interval: "month",
      summary: "Posts plus outreach to up to 400 people a month, replies handled.",
    },
    {
      id: "growth",
      name: "Growth",
      amountPence: 64900,
      interval: "month",
      summary: "Everything in Business plus a monthly telephone follow-up day.",
    },
  ],
  intake: [
    { key: "linkedin_url", label: "Your LinkedIn profile URL", type: "url", required: true },
    { key: "company", label: "Company", type: "text", required: true },
    { key: "offer", label: "What you sell, the outcomes you deliver and your proof", type: "textarea", required: true },
    { key: "icp", label: "Who you want to meet (job titles, sectors, company size, region)", type: "textarea", required: true },
    { key: "exclusions", label: "Who we must never approach (existing clients, competitors)", type: "textarea" },
    { key: "price_questions", label: "How should we handle price questions?", type: "textarea" },
    { key: "never_say", label: "Anything that must never be said publicly", type: "textarea" },
    { key: "booking_link", label: "Your booking link for prospects", type: "url" },
    { key: "approver", label: "Who approves posts and messages (name and email)", type: "text", required: true },
    { key: "premium", label: "Do you have LinkedIn Premium?", type: "select", options: ["Yes", "No", "Not sure"] },
  ],
  onboarding: [
    ...welcomeSteps,
    {
      key: "kickoff",
      title: "45-minute kickoff call booked and held",
      kind: "manual",
      instructions:
        "Hold the kickoff call. Agree the ICP and exclusions with the approver. During the call the client " +
        "signs in to their own LinkedIn inside Sbl.so (as a sender) and inside FeedBoss. Never collect " +
        "passwords. Record the Sbl.so channel id and FeedBoss workspace id on the customer, and check the " +
        "FeedBoss voice profile matches the client.",
    },
    {
      key: "profile_rewrite",
      title: "Draft rewritten headline, About and Featured sections",
      kind: "approval",
      handler: "linkn_profile_rewrite",
    },
    {
      key: "content_pillars",
      title: "Agree 3–4 content pillars and schedule the first 4 posts",
      kind: "manual",
      instructions:
        "Check the voice profile with the client, ask them to upload case studies and FAQs to the FeedBoss " +
        "knowledge base, agree 3–4 pillars, then schedule the first four posts. Outreach starts only once " +
        "four posts are live.",
    },
    {
      key: "campaign_drafts",
      title: "Draft Sbl.so campaigns (cold ICP and warm engagers)",
      kind: "manual",
      plans: ["business", "growth"],
      instructions:
        "Create 'LNK <slug> / cold-icp / <yyyy-mm>' and 'LNK <slug> / warm-engagers' in Sbl.so, bind the " +
        "client's sender, and get the approver's sign-off on the wording.",
    },
    {
      key: "launch",
      title: "LAUNCH: one-recipient proof, then at most 25 leads",
      kind: "manual",
      plans: ["business", "growth"],
      instructions:
        "Send a one-recipient proof, then launch to at most 25 leads. Watch for 48 hours before widening.",
    },
    {
      key: "call_guide",
      title: "Write the call guide and agree calling data arrangements",
      kind: "manual",
      plans: ["growth"],
      instructions:
        "Write the seven-part call guide in the client's voice and get sign-off. Confirm the data-processing " +
        "agreement with the calling team and TPS/CTPS screening. First calling day 3–4 weeks after outreach starts.",
    },
    goLiveStep,
  ],
  routines: [
    {
      key: "reply_triage",
      title: "Reply triage: draft replies to new LinkedIn conversations",
      cadence: { every: "day", weekdaysOnly: true },
      handler: "linkn_reply_triage",
      approval: true,
      plans: ["business", "growth"],
    },
    {
      key: "weekly_harvest",
      title: "Harvest post engagers into the warm campaign",
      cadence: { every: "week", weekday: 1 },
      handler: "linkn_weekly_harvest",
      approval: true,
      plans: ["business", "growth"],
    },
    {
      key: "content_plan",
      title: "Plan next month's posts",
      cadence: { every: "month", dayOfMonth: 22 },
      handler: "linkn_content_plan",
      approval: true,
    },
    {
      key: "calling_day",
      title: "Build the monthly call sheet",
      cadence: { every: "month", dayOfMonth: 15 },
      handler: "linkn_call_sheet",
      approval: true,
      plans: ["growth"],
    },
    {
      key: "monthly_report",
      title: "Monthly client report",
      cadence: { every: "month", dayOfMonth: 3 },
      handler: "linkn_monthly_report",
      approval: true,
    },
  ],
  tools: ["feedboss", "sblso", "anthropic", "smtp", "stripe"],
  leadBrief:
    "Most enquiries ask for a free profile review. Give two or three specific, honest observations if " +
    "they shared enough to judge; otherwise say Felix will look at their profile personally and reply " +
    "within two working days, and offer the booking link.",
  leadFollowUpDays: [3, 10],
  pauseAfterPastDueDays: 14,
};
