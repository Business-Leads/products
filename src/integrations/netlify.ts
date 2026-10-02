import { createHash } from "node:crypto";
import { NotConfiguredError } from "../lib/util.js";

// Netlify's REST API: create a site and deploy files to it (the file-digest
// method: send the list of files with their SHA1, then upload the ones Netlify
// doesn't already have).

const API = "https://api.netlify.com/api/v1";

function token(): string {
  const t = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!t) throw new NotConfiguredError("netlify", "NETLIFY_AUTH_TOKEN is not set");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": raw ? "application/octet-stream" : "application/json",
    },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Netlify ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface NetlifySite {
  id: string;
  name: string;
  url: string;
  ssl_url: string;
}

export async function createSite(name: string): Promise<NetlifySite> {
  return call<NetlifySite>("POST", "/sites", { name });
}

export async function getSite(id: string): Promise<NetlifySite> {
  return call<NetlifySite>("GET", `/sites/${id}`);
}

/** Publish a complete set of files (path -> contents) as the site's new production deploy. */
export async function deployFiles(siteId: string, files: Record<string, string | Buffer>): Promise<{ id: string; url: string }> {
  const bodies = new Map<string, Buffer>();
  const digest: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const p = path.startsWith("/") ? path : `/${path}`;
    bodies.set(p, buf);
    digest[p] = createHash("sha1").update(buf).digest("hex");
  }
  const deploy = await call<{ id: string; required?: string[]; ssl_url?: string; deploy_ssl_url?: string }>(
    "POST",
    `/sites/${siteId}/deploys`,
    { files: digest },
  );
  const needed = new Set(deploy.required ?? []);
  for (const [p, buf] of bodies) {
    if (!needed.has(digest[p]!)) continue;
    await call("PUT", `/deploys/${deploy.id}/files${encodeURI(p)}`, undefined, buf);
  }
  return { id: deploy.id, url: deploy.ssl_url ?? deploy.deploy_ssl_url ?? "" };
}

/** Attach a custom domain (and its www alias) to a site; Netlify then issues the certificate. */
export async function setCustomDomain(siteId: string, domain: string): Promise<void> {
  await call("PATCH", `/sites/${siteId}`, { custom_domain: domain, domain_aliases: [`www.${domain}`] });
}
