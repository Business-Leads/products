import type { Guide } from "../engine/types.js";

export type Interval = "month" | "week";

export interface Plan {
  id: string;
  name: string;
  amountPence: number;
  interval: Interval;
  /** One-off charge taken with the first payment. */
  setupFeePence?: number;
  trialDays?: number;
  summary: string;
}

export interface AddOn {
  id: string;
  name: string;
  amountPence: number;
  /** Recurring on the plan's interval, or a one-off charge. */
  recurring: boolean;
}

export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "email" | "tel" | "url" | "select";
  required?: boolean;
  help?: string;
  options?: string[];
}

/**
 * auto     – the system does it (may fall back to a manual task if a tool isn't connected)
 * customer – waiting on the customer (e.g. filling in the intake form)
 * approval – the system drafts it, a person approves it in the inbox
 * manual   – a person has to do it; it appears in the inbox with instructions
 */
export type StepKind = "auto" | "customer" | "approval" | "manual";

export interface StepDef {
  key: string;
  title: string;
  kind: StepKind;
  /** Name of a handler in engine/handlers.ts. */
  handler?: string;
  /** Shown on manual tasks and in the dashboard. */
  instructions?: string;
  /** Only run for these plans. */
  plans?: string[];
  /** For manual steps: why it needs a person, and the steps to follow. */
  guide?: Guide;
}

export type Cadence =
  | { every: "day"; weekdaysOnly?: boolean }
  | { every: "week"; weekday: number } // 1 = Monday
  | { every: "month"; dayOfMonth: number | "anniversary" };

export interface RoutineDef {
  key: string;
  title: string;
  cadence: Cadence;
  handler: string;
  /** Default: whether the output needs a person's approval before it goes to the customer. */
  approval: boolean;
  plans?: string[];
  instructions?: string;
  /** If this routine falls back to a person: why, and the steps to follow. */
  guide?: Guide;
}

export interface Product {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  /** Legal entity the product trades under. */
  entity: string;
  siteUrls: string[];
  bookingUrl: string;
  /** Set to false to keep a product defined but switch off all its automation. */
  launched?: boolean;
  /** Sold like Business Leads: after paying, the customer books an onboarding call first. */
  bookingAfterPurchase?: boolean;
  email: { from: string; fromName: string; replyTo?: string };
  /** Tone guidance for anything Claude drafts in this product's name. */
  voice: string;
  plans: Plan[];
  addOns?: AddOn[];
  /** Priced per engagement; no self-serve checkout. */
  quoted?: boolean;
  intake: Field[];
  onboarding: StepDef[];
  routines: RoutineDef[];
  /** Integration ids from integrations/index.ts that this product depends on. */
  tools: string[];
  /** What the first reply to a new enquiry should do, beyond the default. */
  leadBrief?: string;
  /** Days after first contact on which un-converted leads get a follow-up. */
  leadFollowUpDays: number[];
  /** Pause service this many days after a failed payment. */
  pauseAfterPastDueDays: number;
  /** The client's account area on the product's own site. */
  portal: PortalDef;
}

/**
 * What a client sees in their account. Clients never see which tools are used
 * behind the scenes, so every onboarding step and routine is listed here with
 * a client-facing label, or null to keep it internal.
 */
export interface PortalDef {
  /** e.g. account.linkn.co.uk, pointed at this app. */
  host: string;
  /** Brand colour for buttons and highlights. */
  accent: string;
  /** Heading for the results section. */
  resultsTitle: string;
  /** One line under the heading explaining what the results show. */
  resultsIntro: string;
  steps: Record<string, string | null>;
  routines: Record<string, string | null>;
  /** Headline figures shown on the dashboard, filled from reports. */
  metrics: { key: string; label: string }[];
}
