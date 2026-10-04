import type { FastifyInstance, FastifyReply } from "fastify";
import { one } from "../db/index.js";
import { databaseSize } from "../engine/prospectdb.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { html, raw, type Raw } from "./html.js";
import { icon, intro } from "./layout.js";

// "Learn HQ": a hands-on training for Felix and family, inside HQ itself. One
// lesson at a time; each points at the real page (the menu item glows), has a
// few things to try, and one quick question. Progress is kept on the server so
// it carries on from any computer.

const KEY = "training:progress";

interface Progress {
  ticks: Record<string, boolean>;
  quiz: Record<string, boolean>;
}

interface Live {
  tasks: number;
  support: number;
  customers: number;
  firstCustomer?: string;
  leads: number;
  prospects: number;
}

interface Lesson {
  id: string;
  title: string;
  minutes: number;
  /** The menu item that glows while this lesson is open. */
  spot?: string;
  body: (live: Live) => Raw;
  show?: (live: Live) => { href: string; label: string } | undefined;
  tries: string[];
  quiz: { q: string; options: string[]; answer: number; why: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const LESSONS: Lesson[] = [
  {
    id: "idea",
    title: "The big idea",
    minutes: 5,
    body: () => html`
      <p>HQ runs all six products by itself, day and night. It sends the emails, sets up new clients, writes the reports and keeps everything ticking.</p>
      <p>It only stops and asks a person in three cases:</p>
      <ul class="lt-points">
        <li><strong>Something needs a yes or no.</strong> A Google post, a reply to a review, a LinkedIn campaign about to start.</li>
        <li><strong>Something truly needs hands.</strong> A few jobs can't be automated. Each one comes with a short guide.</li>
        <li><strong>A call is booked.</strong> Sales chats and onboarding calls are Dad's, on Zoom.</li>
      </ul>
      <p class="lt-key">The daily habit: <strong>open HQ, clear the to-do list, take your calls.</strong></p>`,
    tries: ["Say the daily habit out loud to each other"],
    quiz: {
      q: "When does HQ need one of you?",
      options: ["To send every email by hand", "Only for a yes or no, a guided job, or a call", "Every morning to start it up"],
      answer: 1,
      why: "Everything else runs by itself, even overnight.",
    },
  },
  {
    id: "menu",
    title: "Signing in and the menu",
    minutes: 10,
    spot: "/",
    body: () => html`
      <p>The dark menu on the left is how you get around. Each area has its own colour and smiley icon.</p>
      <p>A <span class="lt-badge">3</span> next to <strong>To-do list</strong> or <strong>Messages</strong> means that many things are waiting for you.</p>
      <dl class="lt-menu">
        <div><dt>Home</dt><dd>Today at a glance</dd></div>
        <div><dt>To-do list</dt><dd>Everything that needs a person</dd></div>
        <div><dt>Messages</dt><dd>Questions clients send from their account</dd></div>
        <div><dt>Customers</dt><dd>Everyone who has paid</dd></div>
        <div><dt>Enquiries</dt><dd>People interested but not bought yet</dd></div>
        <div><dt>Client logins</dt><dd>Every client's account sign-in</dd></div>
        <div><dt>Cold emails</dt><dd>Emails to new businesses</dd></div>
        <div><dt>Products</dt><dd>One page each: prices, links, settings</dd></div>
        <div><dt>What's happened</dt><dd>The diary of everything HQ did</dd></div>
        <div><dt>Settings</dt><dd>Connections and the emergency stop</dd></div>
      </dl>
      <p>When you finish, use <strong>Sign out</strong> at the bottom of the menu.</p>`,
    show: () => ({ href: "/", label: "Open Home" }),
    tries: ["Click every menu item once, top to bottom", "Come back here with Learn HQ in the menu"],
    quiz: {
      q: "Where do you go to see everything HQ has done?",
      options: ["What's happened", "Client logins", "Cold emails"],
      answer: 0,
      why: "It's the diary, newest first. Handy for “did that email go out?”",
    },
  },
  {
    id: "todo",
    title: "The to-do list",
    minutes: 20,
    spot: "/inbox",
    body: (l) => html`
      <p class="lt-live">${l.tasks ? `Right now there ${l.tasks === 1 ? "is 1 card" : `are ${l.tasks} cards`} waiting.` : "Right now the to-do list is empty. Well done!"}</p>
      <p>This is the most important page. Every card is one thing HQ needs, and each says exactly what to press.</p>
      <div class="lt-cards">
        <div class="lt-card"><strong>An email to send</strong><span>Read it, change any words, then <em>Looks good, send it</em> or <em>Don't send</em>.</span></div>
        <div class="lt-card"><strong>Something to publish</strong><span>A Google post, review replies or a LinkedIn step. <em>Looks good, publish it</em> sends it straight out.</span></div>
        <div class="lt-card"><strong>A draft to approve</strong><span>A report or plan. <em>Looks good, approve it</em> or <em>Not right</em>.</span></div>
        <div class="lt-card"><strong>A job for you</strong><span>A why, the minutes it takes, numbered steps. Do them, then <em>I've done this</em>.</span></div>
      </div>
      <p>Saying no? Type a few words in the box next to the button. HQ uses your note to do better next time.</p>`,
    show: () => ({ href: "/inbox", label: "Open the to-do list" }),
    tries: ["Count the cards on the to-do list", "Pick one card and decide together: yes, no, or change the words", "If there's a job card, read its steps aloud"],
    quiz: {
      q: "You don't like the wording of an email on a card. What do you do?",
      options: ["Press Don't send and write it yourself in Gmail", "Change the words in the box, then press Looks good, send it", "Leave it and it will send anyway"],
      answer: 1,
      why: "Every card can be edited before you approve it. Nothing waiting for you is sent until you say so.",
    },
  },
  {
    id: "customers",
    title: "Customers and what clients see",
    minutes: 15,
    spot: "/customers",
    body: (l) => html`
      <p class="lt-live">${l.customers ? `You have ${plural(l.customers, "customer")} in HQ.` : "No customers yet. When the first one pays, they appear here by themselves."}</p>
      <p>When someone buys, it all happens without you:</p>
      <ol class="lt-flow">
        <li>They pay on a page in our product's colours</li>
        <li>They create their own password</li>
        <li>They book their onboarding call with Dad (Online Business Builder)</li>
        <li>They fill in a short details form</li>
        <li>They see their own dashboard: progress, figures, reports, calls, billing and support</li>
      </ol>
      <p>On a customer's page in HQ you'll find their <strong>onboarding checklist</strong> (<em>Try again</em> re-runs a stuck step), <strong>See their dashboard</strong> (exactly what they see) and <strong>Post an update</strong> to send them a note.</p>`,
    show: (l) => (l.firstCustomer ? { href: `/customers/${l.firstCustomer}`, label: "Open a customer" } : { href: "/customers", label: "Open Customers" }),
    tries: ["Open a customer and read their checklist", "Press See their dashboard", "Find the same person in Client logins"],
    quiz: {
      q: "Can clients see the names of the tools we use behind the scenes?",
      options: ["Yes, on their dashboard", "Only in their invoices", "No, they only ever see our product"],
      answer: 2,
      why: "Every step a client sees is written in our product's own words.",
    },
  },
  {
    id: "calls",
    title: "Enquiries, calls and messages",
    minutes: 10,
    spot: "/leads",
    body: (l) => html`
      <p class="lt-live">${plural(l.leads, "enquiry", "enquiries")} in the last 7 days · ${l.support ? `${plural(l.support, "message")} to answer` : "no messages waiting"}.</p>
      <p>Each product has two kinds of call, so Dad always knows what a call is for: a <strong>chat</strong> (someone thinking of buying) and an <strong>onboarding</strong> (a paying client getting set up).</p>
      <p>When someone books:</p>
      <ol class="lt-flow">
        <li>They get a friendly email from us with the Zoom link</li>
        <li>Dad gets an email: who, which product, when</li>
        <li>It shows in the client's account under “Your calls”</li>
        <li>A chat becomes an enquiry, and the chasing emails stop</li>
        <li>An onboarding booking ticks that step on their checklist</li>
      </ol>
      <p>Questions clients send from their account land in <strong>Messages</strong>. Your reply is emailed to them.</p>`,
    show: () => ({ href: "/leads", label: "Open Enquiries" }),
    tries: ["Open the newest enquiry and read what happened", "Open Messages and check nothing is waiting"],
    quiz: {
      q: "Someone books a Linkn chat. What happens to their follow-up emails?",
      options: ["They stop, so we don't chase someone who's already booked", "They carry on as normal", "Dad has to stop them by hand"],
      answer: 0,
      why: "The booking turns them into an enquiry and stops the chasing automatically.",
    },
  },
  {
    id: "products",
    title: "Product pages",
    minutes: 10,
    spot: "/products/onlinebusinessbuilder",
    body: () => html`
      <p>Each product has its own page. On it:</p>
      <ul class="lt-points">
        <li><strong>Prices and sign-up links.</strong> Each goes straight to payment, so you can paste one into an email to someone ready to buy.</li>
        <li><strong>Booking links.</strong> The chat and onboarding links for that product.</li>
        <li><strong>How much runs by itself.</strong> Each kind of work is <em>Ask me first</em> or <em>Just do it</em>. Start with Ask me first; switch once you trust what it writes.</li>
        <li><strong>Pause this product.</strong> Stops all its work until you switch it back on.</li>
      </ul>`,
    show: () => ({ href: "/products/onlinebusinessbuilder", label: "Open Online Business Builder" }),
    tries: ["Copy a sign-up link and open it in a new tab (don't pay)", "Open the onboarding booking link and see Dad's calendar", "Read “How much runs by itself” without changing anything"],
    quiz: {
      q: "A customer on the phone says “send me the link to pay”. Where do you find it?",
      options: ["Settings", "The product's page, under Prices and sign-up links", "The to-do list"],
      answer: 1,
      why: "Each plan has its own link that goes straight to payment.",
    },
  },
  {
    id: "system",
    title: "Behind the scenes",
    minutes: 10,
    spot: "/system",
    body: (l) => html`
      <p class="lt-live">The prospect database has ${l.prospects.toLocaleString("en-GB")} contacts.</p>
      <ul class="lt-points">
        <li><strong>Settings</strong> shows every connection and the regular jobs, each with a button to run it now.</li>
        <li><strong>Prospect database</strong> (in Settings) holds the people EmailFirst and Good Questions email. It updates itself every night from Business Leads.</li>
        <li><strong>Pause everything</strong> is the emergency stop. Nothing goes out for any product until you switch it back on.</li>
      </ul>`,
    show: () => ({ href: "/system/prospects", label: "Open the prospect database" }),
    tries: ["Press “Bring in Business Leads contacts from Mailpulse now”", "Find the Pause everything button in Settings (don't press it)"],
    quiz: {
      q: "Something looks wrong and you want time to think. What's the safest thing to press?",
      options: ["Sign out everywhere", "Pause everything, in Settings", "Delete the customer"],
      answer: 1,
      why: "It stops everything going out, and you can switch it back on whenever you're ready.",
    },
  },
  {
    id: "dad",
    title: "Dad's jobs",
    minutes: 10,
    body: () => html`
      <p>Everything else runs by itself. These are the only things that need Dad, and each also arrives as a card on the to-do list.</p>
      <div class="lt-cards">
        <div class="lt-card"><strong>Online Business Builder</strong><span>Take the onboarding call. Accept the client's Google profile invite and import it into Local Falcon. Approve the weekly post and review replies.</span></div>
        <div class="lt-card"><strong>Linkn</strong><span>Take the kickoff call. Make the client's FeedBoss workspace. Approve the launch, replies and new leads. Press schedule on their posts.</span></div>
        <div class="lt-card"><strong>Speed to Lead</strong><span>Copy the template phone assistant for each new client, following the guide card. HQ does the rest.</span></div>
        <div class="lt-card"><strong>EmailFirst and Good Questions</strong><span>Nothing day to day. Clients approve the words in their own account; HQ does the lists, sending and reports.</span></div>
      </div>`,
    tries: ["Dad: say which product needs a Local Falcon import", "Dad: say which product needs a FeedBoss workspace"],
    quiz: {
      q: "A new EmailFirst client signs up. What does Dad need to do day to day?",
      options: ["Write the emails every morning", "Upload the lists each day", "Nothing: the client approves the words and HQ does the rest"],
      answer: 2,
      why: "HQ builds the lists, schedules the sends and writes the reports.",
    },
  },
];

async function live(): Promise<Live> {
  const n = async (sql: string) => (await one<{ n: number }>(sql))?.n ?? 0;
  const first = await one<{ id: string }>(`SELECT id FROM customers ORDER BY created_at DESC LIMIT 1`);
  return {
    tasks: await n(`SELECT count(*)::int AS n FROM tasks WHERE status = 'open'`),
    support: await n(`SELECT count(*)::int AS n FROM support_requests WHERE status = 'open'`),
    customers: await n(`SELECT count(*)::int AS n FROM customers`),
    firstCustomer: first?.id,
    leads: await n(`SELECT count(*)::int AS n FROM leads WHERE created_at > now() - interval '7 days'`),
    prospects: await databaseSize().catch(() => 0),
  };
}

function lessonDone(l: Lesson, p: Progress): boolean {
  return !!p.quiz[l.id] && l.tries.every((_, i) => p.ticks[`${l.id}:${i}`]);
}

export async function trainingRoutes(app: FastifyInstance, send: (reply: FastifyReply, req: any, title: string, body: Raw, active: string) => Promise<unknown>) {
  app.get("/training", async (req, reply) => {
    const p = await getSetting<Progress>(KEY, { ticks: {}, quiz: {} });
    const l = await live();
    const doneCount = LESSONS.filter((x) => lessonDone(x, p)).length;
    const total = LESSONS.reduce((s, x) => s + x.minutes, 0);
    const state = { ticks: p.ticks ?? {}, quiz: p.quiz ?? {}, lessons: LESSONS.map((x) => ({ id: x.id, spot: x.spot ?? "", tries: x.tries.length })) };

    return send(reply, req, "Learn HQ", html`
      <h1>Learn HQ</h1>
      ${intro(`A hands-on lesson for the two of you, about ${total} minutes. Do one lesson at a time: the menu item for each lesson glows, so you know where to click. Your progress is saved, so you can stop and carry on later.`)}
      <div class="lt" id="lt">
        <div class="lt-top panel">
          <div class="lt-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${LESSONS.length}" aria-valuenow="${doneCount}" aria-label="Lessons finished"><span id="lt-bar" style="width:${Math.round((doneCount / LESSONS.length) * 100)}%"></span></div>
          <p class="lt-count" id="lt-count" aria-live="polite">${doneCount} of ${LESSONS.length} lessons finished</p>
          <ol class="lt-steps" id="lt-steps">
            ${LESSONS.map((x, i) => html`<li><button type="button" class="lt-step ${lessonDone(x, p) ? "done" : ""}" data-go="${i}" aria-label="Lesson ${i + 1}: ${x.title}"><span class="lt-dot" aria-hidden="true">${lessonDone(x, p) ? "✓" : String(i + 1)}</span><span class="lt-name">${x.title}</span></button></li>`)}
          </ol>
        </div>

        ${LESSONS.map((x, i) => {
          const show = x.show?.(l);
          return html`<section class="panel lt-lesson" data-lesson="${i}" ${i === 0 ? "" : raw("hidden")} aria-labelledby="lt-h-${x.id}">
            <p class="lt-when">Lesson ${i + 1} of ${LESSONS.length} · about ${x.minutes} minutes</p>
            <h2 id="lt-h-${x.id}">${x.title}</h2>
            <div class="lt-body">${x.body(l)}</div>
            ${show ? html`<p><a class="btn primary" href="${show.href}" target="_blank" rel="noopener">${show.label} ↗</a> <span class="help">Opens in a new tab, so this lesson stays here.</span></p>` : ""}

            <div class="lt-try">
              <h3>Try it</h3>
              ${x.tries.map((t, j) => html`<label class="lt-tick"><input type="checkbox" data-tick="${x.id}:${j}" ${p.ticks[`${x.id}:${j}`] ? raw("checked") : ""}><span>${t}</span></label>`)}
            </div>

            <fieldset class="lt-quiz" data-quiz="${x.id}" data-answer="${x.quiz.answer}">
              <legend>Quick question</legend>
              <p class="lt-q">${x.quiz.q}</p>
              <div class="lt-opts">
                ${x.quiz.options.map((o, j) => html`<button type="button" class="lt-opt ${p.quiz[x.id] && j === x.quiz.answer ? "right" : ""}" data-opt="${j}">${o}</button>`)}
              </div>
              <p class="lt-fb" role="status" aria-live="polite" data-why="${x.quiz.why}">${p.quiz[x.id] ? html`<strong>That's right.</strong> ${x.quiz.why}` : ""}</p>
            </fieldset>

            <div class="lt-nav">
              ${i > 0 ? html`<button type="button" data-go="${i - 1}">← Back</button>` : html`<span></span>`}
              ${i < LESSONS.length - 1 ? html`<button type="button" class="primary" data-go="${i + 1}">Next lesson →</button>` : html`<button type="button" class="primary" data-go="${LESSONS.length}">Finish</button>`}
            </div>
          </section>`;
        })}

        <section class="panel lt-lesson lt-finish" data-lesson="${LESSONS.length}" hidden aria-labelledby="lt-h-finish">
          <span class="ti big area-learn" aria-hidden="true">${icon("learn")}</span>
          <h2 id="lt-h-finish">You've learnt HQ!</h2>
          <p id="lt-finish-text">${doneCount === LESSONS.length ? "Every lesson is finished. Well done, both of you." : `${LESSONS.length - doneCount} lessons still have something to tick or a question to answer. They're the ones without a tick at the top.`}</p>
          <div class="lt-habit">
            <h3>Every day from now on</h3>
            <ol><li>Open HQ</li><li>Clear the to-do list</li><li>Answer any messages</li><li>Take your booked calls</li></ol>
          </div>
          <div class="lt-nav">
            <button type="button" data-go="0">Start again from lesson 1</button>
            <form method="post" action="/training/reset"><button type="submit" class="small">Clear our progress</button></form>
          </div>
        </section>
      </div>
      <script>${raw(`
(function () {
  var state = ${JSON.stringify(state).replace(/</g, "\\u003c")};
  var root = document.getElementById("lt");
  var lessons = root.querySelectorAll(".lt-lesson");
  var current = 0;

  function save(key, value) {
    fetch("/training/progress", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ key: key, value: value }) }).catch(function () {});
  }
  function lessonDone(i) {
    var l = state.lessons[i];
    if (!state.quiz[l.id]) return false;
    for (var j = 0; j < l.tries; j++) if (!state.ticks[l.id + ":" + j]) return false;
    return true;
  }
  function refresh() {
    var done = 0;
    root.querySelectorAll(".lt-step").forEach(function (b, i) {
      var d = lessonDone(i);
      if (d) done++;
      b.classList.toggle("done", d);
      b.querySelector(".lt-dot").textContent = d ? "\\u2713" : String(i + 1);
      b.classList.toggle("here", i === current);
      if (i === current) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    });
    var n = state.lessons.length;
    document.getElementById("lt-bar").style.width = Math.round(done / n * 100) + "%";
    root.querySelector(".lt-meter").setAttribute("aria-valuenow", done);
    document.getElementById("lt-count").textContent = done + " of " + n + " lessons finished" + (done === n ? ". Brilliant!" : "");
    document.getElementById("lt-finish-text").textContent = done === n
      ? "Every lesson is finished. Well done, both of you."
      : (n - done) + (n - done === 1 ? " lesson still has" : " lessons still have") + " something to tick or a question to answer. They're the ones without a tick at the top.";
  }
  function spotlight() {
    document.querySelectorAll(".nav a.lt-spot").forEach(function (a) { a.classList.remove("lt-spot"); });
    var l = state.lessons[current];
    if (l && l.spot) {
      var a = document.querySelector('.nav a[href="' + l.spot + '"]');
      if (a) a.classList.add("lt-spot");
    }
  }
  function go(i) {
    current = i;
    lessons.forEach(function (s) { s.hidden = Number(s.getAttribute("data-lesson")) !== i; });
    try { localStorage.setItem("hq-training-at", String(i)); } catch (e) {}
    refresh();
    spotlight();
    var h = lessons[i] && lessons[i].querySelector("h2");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    root.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  root.addEventListener("click", function (e) {
    var g = e.target.closest("[data-go]");
    if (g) { go(Number(g.getAttribute("data-go"))); return; }
    var o = e.target.closest(".lt-opt");
    if (o) {
      var box = o.closest(".lt-quiz");
      var id = box.getAttribute("data-quiz");
      var right = Number(box.getAttribute("data-answer"));
      var pick = Number(o.getAttribute("data-opt"));
      var fb = box.querySelector(".lt-fb");
      box.querySelectorAll(".lt-opt").forEach(function (b) { b.classList.remove("wrong", "right"); });
      if (pick === right) {
        o.classList.add("right");
        fb.innerHTML = "<strong>That's right.</strong> ";
        fb.appendChild(document.createTextNode(fb.getAttribute("data-why")));
        if (!state.quiz[id]) { state.quiz[id] = true; save("quiz:" + id, true); }
      } else {
        o.classList.add("wrong");
        fb.textContent = "Not quite. Have another go.";
      }
      refresh();
    }
  });
  root.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.matches("[data-tick]")) return;
    var k = t.getAttribute("data-tick");
    state.ticks[k] = t.checked;
    save("tick:" + k, t.checked);
    refresh();
  });

  var start = 0;
  try { start = Number(localStorage.getItem("hq-training-at")) || 0; } catch (e) {}
  if (start > state.lessons.length) start = 0;
  go(start);
  window.scrollTo(0, 0);
})();
`)}</script>`, "/training");
  });

  app.post<{ Body: { key?: string; value?: unknown } }>("/training/progress", async (req, reply) => {
    const m = /^(tick|quiz):([a-z]+(?::\d+)?)$/.exec(String(req.body?.key ?? ""));
    if (!m) return reply.code(400).send({ ok: false });
    const p = await getSetting<Progress>(KEY, { ticks: {}, quiz: {} });
    p.ticks ??= {};
    p.quiz ??= {};
    const bucket = m[1] === "tick" ? p.ticks : p.quiz;
    if (req.body?.value) bucket[m[2]!] = true;
    else delete bucket[m[2]!];
    await setSetting(KEY, p);
    return { ok: true };
  });

  app.post("/training/reset", async (_req, reply) => {
    await setSetting(KEY, { ticks: {}, quiz: {} });
    return reply.redirect("/training?flash=" + encodeURIComponent("Progress cleared. Start again whenever you like."), 303);
  });
}
