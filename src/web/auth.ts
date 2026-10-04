import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { one, query } from "../db/index.js";
import { clearFailures, hashToken, recordFailure, tooManyFailures, verifyPassword } from "../lib/passwords.js";
import { logEvent } from "../lib/events.js";
import { html } from "./html.js";
import { publicPage } from "./layout.js";
import { HQ_COOKIE, startHqSession, teamPublicRoutes, type HqUser } from "./team.js";

const COOKIE = HQ_COOKIE;
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

/** Someone with their own login (email + password), or the main password when no email is given. */
async function signInMatches(email: string, password: string): Promise<{ ok: boolean; userId: number | null }> {
  if (!email) return { ok: passwordMatches(password), userId: null };
  const u = await one<HqUser>(`SELECT * FROM hq_users WHERE lower(email) = $1 AND NOT disabled`, [email.toLowerCase()]);
  const ok = await verifyPassword(password, u?.password_hash);
  return { ok: ok && !!u, userId: ok && u ? u.id : null };
}

export async function authRoutes(app: FastifyInstance) {
  await teamPublicRoutes(app);

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
        html`<div class="panel" style="max-width:420px;margin:72px auto;text-align:center">
          <img src="/static/logo.svg" alt="" width="96" height="96" style="display:block;margin:0 auto 12px">
          <h1>Welcome back</h1>
          <p class="muted">Sign in to ${config.brand}.</p>
          ${noPassword ? html`<p class="flash" role="alert">Sign-in isn't switched on yet. Add an ADMIN_PASSWORD secret in GitHub and redeploy.</p>` : ""}
          ${req.query.error === "locked"
            ? html`<p class="flash" role="alert">Too many wrong tries, so sign-in is paused for 15 minutes. This keeps your dashboard safe.</p>`
            : req.query.error ? html`<p class="flash" role="alert">That email or password isn't right. Please try again.</p>` : ""}
          <form method="post" action="/login" style="text-align:left">
            <input type="hidden" name="next" value="${req.query.next ?? "/"}">
            <label for="email">Your email address</label>
            <input type="email" name="email" id="email" autocomplete="username" autofocus>
            <p class="help" style="margin:4px 0 0">Using the main password? Leave this empty.</p>
            <label for="password">Your password</label>
            <input type="password" name="password" id="password" autocomplete="current-password" required>
            <p style="margin-top:18px"><button class="primary">Sign in</button></p>
          </form>
        </div>`,
        { hq: true },
      ),
    );
  });

  app.post<{ Body: { email?: string; password?: string; next?: string } }>("/login", async (req, reply) => {
    // Locked per IP address and overall, so guessing from many addresses is slowed too.
    const scope = `hq:${req.ip}`;
    if ((await tooManyFailures(scope, FAILURE_LIMIT)) || (await tooManyFailures("hq:all", FAILURE_LIMIT * 6))) {
      return reply.redirect("/login?error=locked", 303);
    }
    const result = await signInMatches((req.body?.email ?? "").trim(), req.body?.password ?? "");
    if (!result.ok) {
      await recordFailure(scope);
      await recordFailure("hq:all");
      await logEvent({ type: "hq.login_failed", level: "warn", message: `Failed HQ sign-in from ${req.ip}` });
      await new Promise((r) => setTimeout(r, 800));
      return reply.redirect("/login?error=1", 303);
    }
    await clearFailures(scope);
    await startHqSession(reply, result.userId);
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
