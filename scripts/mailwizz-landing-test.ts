// End-to-end test of HQ's MailWizz landing page robot, on a throwaway page.
// Run by the "MailWizz landing page test" workflow. Prints statuses only.
import { createLandingPage, deleteLandingPage, landingPageHtml, mailwizzSession, publishLandingPage, setLandingContent } from "../src/integrations/mailwizz-pages.js";

const s = await mailwizzSession();
console.log("Signed in");
const pageId = process.env.PAGE?.trim() || (await createLandingPage(s, "HQ test - please ignore", "Created by HQ to test landing pages. Safe to delete."));
console.log("Page:", pageId);
const marker = `hq-test-${Date.now()}`;
const html = landingPageHtml({
  copy: `A test page made by HQ\n\nThis page checks that HQ can build EmailFirst landing pages in MailWizz.\n\n- It fills in the content\n- It publishes the page\n\nReference ${marker}`,
  company: "Online Business Builder",
  ctaLabel: "Visit our website",
  ctaUrl: "https://onlinebusinessbuilder.co.uk",
});
await setLandingContent(s, pageId, "HQ test - please ignore", html);
console.log("Content saved");
const url = await publishLandingPage(s, pageId);
console.log("Published at:", url);
const pub = await fetch(url);
const text = await pub.text();
console.log("Public page:", pub.status, "content shows:", text.includes(marker), "styled:", text.includes("Visit our website"));
if (process.env.DELETE === "yes") {
  console.log("Delete:", await deleteLandingPage(s, pageId));
  console.log("Public page after delete:", (await fetch(url)).status);
  for (const extra of (process.env.ALSO_DELETE ?? "").split(/[\s,]+/).filter(Boolean)) console.log("Delete", extra, await deleteLandingPage(s, extra));
}
