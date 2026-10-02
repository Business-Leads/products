import { NotConfiguredError } from "../lib/util.js";

// FeedBoss Service API (https://www.feedboss.ai/docs/api/overview), used for
// Linkn: drafting posts in each client's voice and reading back what was
// published. Auth is the x-api-key header. Generation answers with a
// Server-Sent Events stream, read to the end here.

const BASE = "https://server.feedboss.ai/api/v1/ai-conversation";

function key(): string {
  const k = process.env.FEEDBOSS_API_KEY?.trim();
  if (!k) throw new NotConfiguredError("feedboss", "FEEDBOSS_API_KEY is not set");
  return k;
}

/** Parse a finished SSE body into its named events. */
export function parseSse(body: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    const joined = data.join("\n");
    let parsed: any = joined;
    try {
      parsed = JSON.parse(joined);
    } catch {
      // plain text event
    }
    out.push({ event, data: parsed });
  }
  return out;
}

/** Draft one post in the workspace's voice. Returns the new draft's id. */
export async function generatePost(workspaceId: string, userInput: string): Promise<string> {
  const res = await fetch(`${BASE}/generate-post/${encodeURIComponent(workspaceId)}`, {
    method: "POST",
    headers: { "x-api-key": key(), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ userInput }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`FeedBoss generate-post: ${res.status} ${body.slice(0, 200)}`);
  const ids = parseSse(body).find((e) => e.event === "post_ids")?.data;
  if (!ids?.postId) throw new Error("FeedBoss didn't return a post id");
  return String(ids.postId);
}

export interface FeedBossPost {
  id: string;
  postContent: string;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  metrics?: { likes?: number; comments?: number };
  postUrl?: string | null;
}

/** Drafts, scheduled posts and the last 90 days of published posts. */
export async function recentPosts(workspaceId: string): Promise<FeedBossPost[]> {
  const res = await fetch(`${BASE}/recent-posts/${encodeURIComponent(workspaceId)}`, { headers: { "x-api-key": key() } });
  const text = await res.text();
  if (!res.ok) throw new Error(`FeedBoss recent-posts: ${res.status} ${text.slice(0, 200)}`);
  return (JSON.parse(text)?.data?.posts ?? []) as FeedBossPost[];
}
