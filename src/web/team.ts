import type { FastifyInstance, FastifyReply } from "fastify";
import { config, isProduction } from "../config.js";
import { one, query } from "../db/index.js";
import { queueEmail } from "../lib/email.js";
import { logEvent } from "../lib/events.js";
import { hashPassword, hashToken, passwordProblem } from "../lib/passwords.js";
import { ago, token } from "../lib/util.js";
import { html, type Raw } from "./html.js";
import { intro, publicPage } from "./layout.js";

// People who sign in to HQ with their own email and password. Each one is
// invited by email and chooses their own password from the link.

export const HQ_COOKIE = "hq_session";
export const HQ_SESSION_DAYS = 7;
const INVITE_DAYS = 7;

export interface HqUser {
  id: number;
  email: string;
  name: string;
  password_hash: string | null;
  invited_at: Date | null;
  last_login_at: Date | null;
  disabled: boolean;
}

/** A fresh set-password link for this person, replacing any older one. */
export async function inviteLink(userId: number): Promise<string> {
  const t = token(32);
  await query(`UPDATE hq_users SET invite_token = $2, invite_expires_at = now() + ($3 * interval '1 day'), invited_at = now() WHERE id = $1`, [
    userId,
    hashToken(t),
    INVITE_DAYS,
  ]);
  return `${config.baseUrl}/hq-invite/${t}`;
}

export async function sendInvite(user: HqUser): Promise<string> {
  const link = await inviteLink(user.id);
  const first = user.name.split(/\s+/)[0];
  await queueEmail({
    kind: "hq_invite",
    to: user.email,
    subject: user.password_hash ? `Choose a new password for ${config.brand}` : `Your login for ${config.brand}`,
    body:
      `Hello ${first},\n\n` +
      (user.password_hash
        ? `Here's a link to choose a new password for ${config.brand}, your control room:\n\n${link}\n\n`
        : `You now have your own login for ${config.brand}, the control room for all the products.\n\nClick this link to choose your password:\n\n${link}\n\n`) +
      `The link works for ${INVITE_DAYS} days. After that, sign in at ${config.baseUrl}/login with this email address (${user.email}) and your password.\n\n` +
      `There's a "Learn HQ" lesson in the menu that shows you round.`,
  });
  await logEvent({ type: "hq.invite_sent", message: `HQ login link emailed to ${user.email}` });
  return link;
}

/** Anyone added who hasn't been sent their link yet (for example by a migration) gets it now. */
export async function sendPendingInvites(): Promise<number> {
  // Also anyone whose last link never got out (for example while sending was broken).
  const rows = await query<HqUser>(
    `SELECT u.* FROM hq_users u WHERE u.password_hash IS NULL AND NOT u.disabled AND (u.invited_at IS NULL OR
       (SELECT e.status FROM emails e WHERE e.kind = 'hq_invite' AND lower(e.to_address) = lower(u.email) ORDER BY e.created_at DESC LIMIT 1) = 'failed')`,
  );
  for (const u of rows) await sendInvite(u);
  return rows.length;
}

async function userForInvite(t: string): Promise<HqUser | undefined> {
  return one<HqUser>(`SELECT * FROM hq_users WHERE invite_token = $1 AND invite_expires_at > now() AND NOT disabled`, [hashToken(t)]);
}

export async function startHqSession(reply: FastifyReply, userId: number | null): Promise<void> {
  const t = token(32);
  await query(`INSERT INTO sessions (token, expires_at, hq_user_id) VALUES ($1, now() + ($2 * interval '1 day'), $3)`, [hashToken(t), HQ_SESSION_DAYS, userId]);
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
  if (userId) await query(`UPDATE hq_users SET last_login_at = now() WHERE id = $1`, [userId]);
  reply.setCookie(HQ_COOKIE, t, { path: "/", httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: HQ_SESSION_DAYS * 86400 });
}

function invitePage(body: Raw): string {
  return publicPage(`Choose your password · ${config.brand}`, html`<div class="panel" style="max-width:480px;margin:72px auto">
    <img src="/static/logo.svg" alt="" width="96" height="96" style="display:block;margin:0 auto 12px">${body}</div>`, { hq: true });
}

/** Public: the set-password page the invite email links to. */
export async function teamPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string }; Querystring: { error?: string } }>("/hq-invite/:token", async (req, reply) => {
    const u = await userForInvite(req.params.token);
    reply.type("text/html").header("Cache-Control", "no-store");
    if (!u) {
      return reply.send(invitePage(html`<h1 style="text-align:center">This link has run out</h1>
        <p>Links work for ${INVITE_DAYS} days and only once. Ask for a new one, or <a href="/login">sign in</a> if you've already chosen a password.</p>`));
    }
    return reply.send(invitePage(html`<h1 style="text-align:center">Hello ${u.name.split(/\s+/)[0]}</h1>
      <p>Choose a password for ${config.brand}. You'll sign in with <strong>${u.email}</strong> and this password.</p>
      ${req.query.error ? html`<p class="flash" role="alert">${req.query.error}</p>` : ""}
      <form method="post" action="/hq-invite/${req.params.token}">
        <label for="password">New password <span class="muted">(at least 10 characters)</span></label>
        <input type="password" name="password" id="password" autocomplete="new-password" required minlength="10" autofocus>
        <label for="confirm">The same password again</label>
        <input type="password" name="confirm" id="confirm" autocomplete="new-password" required minlength="10">
        <p style="margin-top:18px"><button class="primary">Save and sign in</button></p>
      </form>`));
  });

  app.post<{ Params: { token: string }; Body: { password?: string; confirm?: string } }>("/hq-invite/:token", async (req, reply) => {
    const u = await userForInvite(req.params.token);
    if (!u) return reply.redirect(`/hq-invite/${req.params.token}`, 303);
    const password = req.body?.password ?? "";
    const problem = passwordProblem(password, req.body?.confirm ?? "");
    if (problem) return reply.redirect(`/hq-invite/${req.params.token}?error=${encodeURIComponent(problem)}`, 303);
    await query(`UPDATE hq_users SET password_hash = $2, invite_token = NULL, invite_expires_at = NULL WHERE id = $1`, [u.id, await hashPassword(password)]);
    // A new password signs them out everywhere else.
    await query(`DELETE FROM sessions WHERE hq_user_id = $1`, [u.id]);
    await logEvent({ type: "hq.password_set", message: `${u.name} chose their HQ password` });
    await startHqSession(reply, u.id);
    return reply.redirect("/training", 303);
  });
}

/** Signed in: Settings, "People who can sign in". */
export async function teamRoutes(app: FastifyInstance, send: (reply: FastifyReply, req: any, title: string, body: Raw, active: string) => Promise<unknown>) {
  const back = (reply: FastifyReply, flash: string) => reply.redirect(`/system/team?flash=${encodeURIComponent(flash)}`, 303);

  async function teamPage(req: any, reply: FastifyReply, shown?: { userId: number; link: string }) {
    const users = await query<HqUser>(`SELECT * FROM hq_users ORDER BY disabled, name`);
    // What happened to each person's latest login email, so a missing one can be explained.
    const mails = await query<{ to_address: string; status: string; error: string | null; sent_at: Date | null; created_at: Date }>(
      `SELECT DISTINCT ON (lower(to_address)) to_address, status, error, sent_at, created_at FROM emails
       WHERE kind = 'hq_invite' ORDER BY lower(to_address), created_at DESC`,
    );
    const mailFor = (email: string) => mails.find((m) => m.to_address.toLowerCase() === email.toLowerCase());
    const sentTo = shown ? users.find((u) => u.id === shown.userId) : undefined;
    const shownLink = sentTo ? shown!.link : undefined;
    return send(reply, req, "People who can sign in", html`
      <h1>People who can sign in</h1>
      ${intro("Everyone here has their own login: their email address and a password they chose. The main password still works too.")}
      ${shownLink ? html`<div class="panel lt-try"><h2>A new link for ${sentTo!.name} is on its way</h2>
        <p>It's been emailed to ${sentTo!.email}. If it doesn't arrive, copy this link and send it to them another way (a text message is fine). It works once, for ${INVITE_DAYS} days.</p>
        <p><input id="invite-link" value="${shownLink}" readonly onclick="this.select()" style="width:100%"></p>
        <p><button type="button" class="primary" onclick="var i=document.getElementById('invite-link');i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).then(function(){this.textContent='Copied'}.bind(this)).catch(function(){document.execCommand('copy')})">Copy the link</button></p></div>` : ""}
      <div class="panel">
        ${users.length ? html`<table><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr>
          ${users.map((u) => html`<tr><td><strong>${u.name}</strong></td><td>${u.email}</td>
            <td>${u.disabled ? html`<span class="chip bad">Switched off</span>`
              : u.password_hash ? html`<span class="chip ok">Can sign in</span><div class="small muted">${u.last_login_at ? `Last signed in ${ago(u.last_login_at)}` : "Not signed in yet"}</div>`
              : html`<span class="chip warn">Waiting to choose a password</span><div class="small muted">${u.invited_at ? `Link sent ${ago(u.invited_at)}` : "Link not sent yet"}</div>`}
              ${(() => {
                const m = mailFor(u.email);
                if (!m || u.disabled) return "";
                if (m.status === "sent") return html`<div class="small muted">Last email delivered to the mail server ${ago(m.sent_at ?? m.created_at)}</div>`;
                if (m.status === "failed") return html`<div class="small"><span class="chip bad">Email failed</span> ${m.error ?? ""}</div>`;
                return html`<div class="small"><span class="chip warn">Email not sent yet</span> ${m.error ? html`Last try: ${m.error}` : "It goes out within a minute or two."}</div>`;
              })()}</td>
            <td><div class="row">
              ${u.disabled ? "" : html`<form method="post" action="/system/team/${u.id}/invite"><button class="small">${u.password_hash ? "New password link" : "Send a fresh link"}</button></form>`}
              <form method="post" action="/system/team/${u.id}/${u.disabled ? "enable" : "disable"}"><button class="small ${u.disabled ? "" : "danger"}">${u.disabled ? "Switch back on" : "Switch off"}</button></form>
            </div></td></tr>`)}
        </table>` : html`<p class="empty">Nobody yet.</p>`}
      </div>
      <div class="panel"><h2>Add someone</h2>
        <form method="post" action="/system/team">
          <label for="tname">Their name</label><input name="name" id="tname" required>
          <label for="temail">Their email address</label><input name="email" id="temail" type="email" required>
          <p style="margin-top:14px"><button class="primary">Add them and email their link</button></p>
        </form>
      </div>`, "/system");
  }

  app.get("/system/team", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return teamPage(req, reply);
  });

  app.post<{ Body: { name?: string; email?: string } }>("/system/team", async (req, reply) => {
    const name = (req.body?.name ?? "").trim().slice(0, 100);
    const email = (req.body?.email ?? "").trim().toLowerCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back(reply, "Please give a name and a proper email address.");
    const u = await one<HqUser>(
      `INSERT INTO hq_users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, disabled = false RETURNING *`,
      [email, name],
    );
    const link = await sendInvite(u!);
    reply.header("Cache-Control", "no-store");
    return teamPage(req, reply, { userId: u!.id, link });
  });

  app.post<{ Params: { id: string } }>("/system/team/:id/invite", async (req, reply) => {
    const u = await one<HqUser>(`SELECT * FROM hq_users WHERE id = $1 AND NOT disabled`, [req.params.id]);
    if (!u) return back(reply, "That person isn't here any more.");
    const link = await sendInvite(u);
    // Shown once on this page (not put in the address bar), so it can be passed on another way.
    reply.header("Cache-Control", "no-store");
    return teamPage(req, reply, { userId: u.id, link });
  });

  app.post<{ Params: { id: string; action: string } }>("/system/team/:id/:action", async (req, reply) => {
    const off = req.params.action === "disable";
    if (!off && req.params.action !== "enable") return reply.code(404).send("Not found");
    const u = await one<HqUser>(`UPDATE hq_users SET disabled = $2 WHERE id = $1 RETURNING *`, [req.params.id, off]);
    if (!u) return back(reply, "That person isn't here any more.");
    if (off) await query(`DELETE FROM sessions WHERE hq_user_id = $1`, [u.id]);
    await logEvent({ type: off ? "hq.user_disabled" : "hq.user_enabled", message: `${u.name}'s HQ login switched ${off ? "off" : "back on"}` });
    return back(reply, `${u.name}'s login is switched ${off ? "off" : "back on"}.`);
  });
}
