import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, isProduction } from "../config.js";
import { one, query } from "../db/index.js";
import { token } from "../lib/util.js";
import { html } from "./html.js";
import { publicPage } from "./layout.js";

const COOKIE = "hq_session";

function passwordMatches(given: string): boolean {
  if (!config.admin.password) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(config.admin.password).digest();
  return timingSafeEqual(a, b);
}

export async function isAuthed(req: FastifyRequest): Promise<boolean> {
  const t = req.cookies[COOKIE];
  if (!t) return false;
  const row = await one(`SELECT 1 FROM sessions WHERE token = $1 AND expires_at > now()`, [t]);
  return Boolean(row);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!(await isAuthed(req))) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
}

export async function authRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { next?: string; error?: string } }>("/login", async (req, reply) => {
    const noPassword = !config.admin.password;
    return reply.type("text/html").send(
      publicPage(
        "Sign in · Products HQ",
        html`<div class="panel" style="max-width:380px;margin:80px auto">
          <h1>Products HQ</h1>
          ${noPassword ? html`<p class="flash">Set ADMIN_PASSWORD in the app settings to enable sign-in.</p>` : ""}
          ${req.query.error ? html`<p class="flash">That password isn't right.</p>` : ""}
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
    if (!passwordMatches(req.body?.password ?? "")) {
      await new Promise((r) => setTimeout(r, 800));
      return reply.redirect("/login?error=1", 303);
    }
    const t = token(32);
    await query(`INSERT INTO sessions (token, expires_at) VALUES ($1, now() + interval '30 days')`, [t]);
    reply.setCookie(COOKIE, t, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 30 * 86400,
    });
    const next = req.body?.next?.startsWith("/") && !req.body.next.startsWith("//") ? req.body.next : "/";
    return reply.redirect(next, 303);
  });

  app.post("/logout", async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await query(`DELETE FROM sessions WHERE token = $1`, [t]);
    reply.clearCookie(COOKIE, { path: "/" });
    return reply.redirect("/login", 303);
  });
}
