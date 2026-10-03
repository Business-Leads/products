import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { databaseSize, importProspectFile, recordImportStatus } from "../engine/prospectdb.js";
import { getSetting } from "../lib/settings.js";
import { errorMessage } from "../lib/util.js";
import { html, raw, type Raw } from "./html.js";
import { intro } from "./layout.js";

// "Prospect database": the one-off upload of the master prospect file. The
// browser sends the file in 5 MB pieces (so a large file works on an ordinary
// connection); once it's all here it's loaded into the database in the background.

const dir = path.join(tmpdir(), "prospect-uploads");
const CHUNK = 5 * 1024 * 1024;

export async function dataAdminRoutes(app: FastifyInstance, send: (reply: FastifyReply, req: any, title: string, body: Raw, active: string) => Promise<unknown>) {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: CHUNK + 1024 }, (_req, body, done) => done(null, body));

  app.get("/system/prospects", async (req, reply) => {
    const size = await databaseSize();
    const status = await getSetting<Record<string, any> | null>("prospect_db:import", null);
    return send(reply, req, "Prospect database", html`
      <h1>Prospect database</h1>
      ${intro("This is where EmailFirst and Good Questions find the people to email. Upload the master prospect file (a CSV) and it's loaded in by itself. Upload it again whenever it's updated: nobody's send history is lost.")}
      <div class="panel">
        <p><strong>${size.toLocaleString("en-GB")}</strong> contacts in the database.</p>
        ${status ? html`<p class="muted">Last upload: ${status.state === "done" ? `finished, ${Number(status.imported ?? 0).toLocaleString("en-GB")} contacts loaded` : status.state === "failed" ? `failed: ${status.error}` : `loading… ${Number(status.imported ?? 0).toLocaleString("en-GB")} so far`}</p>` : ""}
        <label for="file">Master prospect file (.csv)</label>
        <input type="file" id="file" accept=".csv,text/csv">
        <p><button class="primary" id="go" type="button">Upload</button></p>
        <p id="progress" role="status" aria-live="polite" class="muted"></p>
      </div>
      <script>${raw(`
        document.getElementById("go").addEventListener("click", async function () {
          var f = document.getElementById("file").files[0];
          var out = document.getElementById("progress");
          if (!f) { out.textContent = "Choose the file first."; return; }
          var id = Date.now().toString(36);
          var size = ${CHUNK};
          for (var off = 0; off < f.size; off += size) {
            out.textContent = "Uploading… " + Math.round(off / f.size * 100) + "%";
            var r = await fetch("/system/prospects/chunk?id=" + id + "&offset=" + off, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f.slice(off, off + size), credentials: "same-origin" });
            if (!r.ok) { out.textContent = "That didn't work (" + r.status + "). Please try again."; return; }
          }
          var done = await fetch("/system/prospects/complete?id=" + id, { method: "POST", credentials: "same-origin" });
          out.textContent = done.ok ? "Uploaded. It's loading in now: this page shows progress when you refresh it." : "Upload finished but loading didn't start. Please try again.";
        });
      `)}</script>`, "/system");
  });

  app.post<{ Querystring: { id?: string; offset?: string } }>("/system/prospects/chunk", async (req, reply) => {
    const id = String(req.query.id ?? "").replace(/[^a-z0-9]/gi, "");
    const offset = Number(req.query.offset);
    if (!id || !Number.isFinite(offset) || !Buffer.isBuffer(req.body)) return reply.code(400).send({ ok: false });
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.csv`);
    const have = offset === 0 ? 0 : await stat(file).then((s) => s.size).catch(() => 0);
    if (offset === 0) await rm(file, { force: true });
    else if (have !== offset) return reply.code(409).send({ ok: false, have });
    await appendFile(file, req.body);
    return { ok: true };
  });

  app.post<{ Querystring: { id?: string } }>("/system/prospects/complete", async (req, reply) => {
    const id = String(req.query.id ?? "").replace(/[^a-z0-9]/gi, "");
    const file = path.join(dir, `${id}.csv`);
    if (!id || !(await stat(file).catch(() => null))) return reply.code(404).send({ ok: false });
    await recordImportStatus({ state: "loading", imported: 0 });
    // Load in the background; the page shows progress.
    void importProspectFile(file, (n) => recordImportStatus({ state: "loading", imported: n }))
      .then((r) => recordImportStatus({ state: "done", imported: r.imported, skipped: r.skipped, columns: r.columns }))
      .catch((err) => recordImportStatus({ state: "failed", error: errorMessage(err) }))
      .finally(() => rm(file, { force: true }));
    return { ok: true };
  });
}
