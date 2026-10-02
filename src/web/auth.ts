import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, isProduction } from "../config.js";
import { one, query } from "../db/index.js";
import { clearFailures, hashToken, recordFailure, tooManyFailures } from "../lib/passwords.js";
import { logEvent } from "../lib/events.js";
import { token } from "../lib/util.js";
import { html } from "./html.js";
import { publicPage } from "./layout.js";

const COOKIE = "hq_session";
const SESSION_DAYS = 7;
const FAILURE_LIMIT = 5;

function passwordMatches(given: string): boolean {
  if (!config.admin.password) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(config.admin.password).digest();
  return timingSafeEqual(a, b);
}

export async function isAuthed(req: FastifyRequest): Promise<boolean> {
  const t = req.cookies[COOKIE];
  if (!t) return false;
  const row = await one(`SELECT 1 FROM sessions WHERE token = $1 AND expires_at > now()`, [hashToken(t)]);
  return Boolean(row);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!(await isAuthed(req))) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/logout-everywhere", async (req, reply) => {
    if (!(await isAuthed(req))) return reply.redirect("/login", 303);
    await query(`DELETE FROM sessions`);
    reply.clearCookie(COOKIE, { path: "/" });
    return reply.redirect("/login", 303);
  });

  app.get<{ Querystring: { next?: string; error?: string } }>("/login", async (req, reply) => {
    const noPassword = !config.admin.password;
    return reply.type("text/html").send(
      publicPage(
        `Sign in · ${config.brand}`,
        html`<div class="panel" style="max-width:380px;margin:80px auto">
          <h1>${config.brand}</h1>
          ${noPassword ? html`<p class="flash">Set ADMIN_PASSWORD in the app settings to enable sign-in.</p>` : ""}
          ${req.query.error === "locked"
            ? html`<p class="flash">Too many attempts. Sign-in is locked for 15 minutes.</p>`
            : req.query.error ? html`<p class="flash">That password isn't right.</p>` : ""}
          <form method="post" action="/login">
            <input type="hidden" name="next" value="${req.query.next ?? "/"}">
            <label for="password">Password</label>
            <input type="password" name="password" id="password" autofocus required>
            <p style="margin-top:16px"><button class="primary">Sign in</button></p>
          </form>
        </div>`,
      ),
    );
  });

  app.post<{ Body: { password?: string; next?: string } }>("/login", async (req, reply) => {
    // Locked per IP address and overall, so guessing from many addresses is slowed too.
    const scope = `hq:${req.ip}`;
    if ((await tooManyFailures(scope, FAILURE_LIMIT)) || (await tooManyFailures("hq:all", FAILURE_LIMIT * 6))) {
      return reply.redirect("/login?error=locked", 303);
    }
    if (!passwordMatches(req.body?.password ?? "")) {
      await recordFailure(scope);
      await recordFailure("hq:all");
      await logEvent({ type: "hq.login_failed", level: "warn", message: `Failed HQ sign-in from ${req.ip}` });
      await new Promise((r) => setTimeout(r, 800));
      return reply.redirect("/login?error=1", 303);
    }
    await clearFailures(scope);
    const t = token(32);
    await query(`INSERT INTO sessions (token, expires_at) VALUES ($1, now() + ($2 * interval '1 day'))`, [hashToken(t), SESSION_DAYS]);
    await query(`DELETE FROM sessions WHERE expires_at < now()`);
    reply.setCookie(COOKIE, t, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: SESSION_DAYS * 86400,
    });
    const next = req.body?.next?.startsWith("/") && !req.body.next.startsWith("//") ? req.body.next : "/";
    return reply.redirect(next, 303);
  });

  app.post("/logout", async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await query(`DELETE FROM sessions WHERE token = $1`, [hashToken(t)]);
    reply.clearCookie(COOKIE, { path: "/" });
    return reply.redirect("/login", 303);
  });
}
