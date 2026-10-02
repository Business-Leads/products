import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProduction } from "../config.js";
import { portalRoutes, rewritePortalUrl } from "../portal/routes.js";
import { adminRoutes } from "./admin.js";
import { authRoutes } from "./auth.js";
import { publicRoutes } from "./public.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
    bodyLimit: 1_000_000,
    // Each product's account domain (e.g. account.linkn.co.uk) serves that product's client area.
    rewriteUrl: (req) => {
      const forwarded = req.headers["x-forwarded-host"];
      return rewritePortalUrl((Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host, req.url ?? "/");
    },
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    if (isProduction) reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  // Keep the raw bytes for the Stripe webhook (needed to verify its signature);
  // parse JSON normally everywhere else.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (req.url.startsWith("/webhooks/stripe")) return done(null, body);
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(formbody);
  await app.register(cookie);

  const css = await readFile(path.join(here, "static", "app.css"), "utf8");
  app.get("/static/app.css", async (_req, reply) => reply.type("text/css").header("Cache-Control", "public, max-age=300").send(css));

  await app.register(publicRoutes);
  await app.register(authRoutes);
  await app.register(portalRoutes);
  await app.register(adminRoutes);
  return app;
}
