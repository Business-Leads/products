import { query } from "../db/index.js";
import { logEvent } from "../lib/events.js";
import { clearAlert, createTask } from "../lib/tasks.js";
import { errorMessage } from "../lib/util.js";
import { products } from "../products/index.js";

interface Target {
  target: string;
  url: string;
  product?: string;
}

function targets(): Target[] {
  const list: Target[] = [];
  for (const p of products) for (const url of p.siteUrls) list.push({ target: p.slug, url, product: p.slug });
  // Extra URLs to watch, e.g. custom domains once they're connected: "name|url,name|url"
  for (const pair of (process.env.EXTRA_HEALTH_URLS ?? "").split(",").filter(Boolean)) {
    const [target, url] = pair.split("|");
    if (target && url) list.push({ target, url });
  }
  return list;
}

async function probe(url: string): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: errorMessage(err) };
  }
}

/** Check every product site. Two failures in a row raise an alert; recovery clears it. */
export async function checkSites(): Promise<string> {
  let down = 0;
  for (const t of targets()) {
    const r = await probe(t.url);
    await query(
      `INSERT INTO health_checks (target, url, ok, status_code, latency_ms, error) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.target, t.url, r.ok, r.status ?? null, r.ms, r.error ?? null],
    );
    const key = `alert:site-down:${t.url}`;
    if (r.ok) {
      await clearAlert(key, "Site is responding again");
      continue;
    }
    down++;
    const recent = await query<{ ok: boolean }>(
      `SELECT ok FROM health_checks WHERE url = $1 ORDER BY checked_at DESC LIMIT 2`,
      [t.url],
    );
    if (recent.length === 2 && recent.every((c) => !c.ok)) {
      await createTask({
        kind: "alert",
        priority: 1,
        title: `Site down: ${t.url}`,
        body: `Two checks in a row failed. Last result: ${r.status ? `HTTP ${r.status}` : r.error}.`,
        product: t.product,
        dedupeKey: key,
      });
      await logEvent({ type: "health.down", level: "error", message: `${t.url} is not responding`, product: t.product });
    }
  }
  return down ? `${down} site(s) failing` : "all sites up";
}
