import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { applyAdd, findSession, load, parseSince, planAdd } from "./core.ts";
import { buildView } from "./view.ts";

/**
 * `agent-diff view`: a local web page over the same data as the CLI. It listens on 127.0.0.1 only,
 * and every API call needs the random token from the printed URL, so other sites open in the
 * browser cannot read the diffs or stage anything.
 */

export interface ServeOptions {
  root: string;
  port: number;
  days: number;
}

const PAGE = join(import.meta.dirname, "viewer.html");

function rangeOf(url: URL): { base?: string; since?: number } {
  const base = url.searchParams.get("base") || undefined;
  const since = url.searchParams.get("since");
  return { base, since: since ? parseSince(since) : undefined };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function serve(opts: ServeOptions): Promise<string> {
  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // A page on another site can point a DNS name at 127.0.0.1; only accept our own host names.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "text/plain", "Forbidden host");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE, "utf8"));
      }
      if (req.headers["x-token"] !== token) return json(res, 403, { error: "Open the URL agent-diff view printed (it carries the access token)." });

      if (req.method === "GET" && url.pathname === "/api/view") {
        return json(res, 200, buildView(load(opts.root, { days: opts.days, ...rangeOf(url) })));
      }
      if (req.method === "POST" && url.pathname === "/api/stage") {
        const b = await body(req);
        const loaded = load(opts.root, { days: opts.days, ...rangeOf(url) });
        const key = findSession(loaded.transcripts, String(b["session"] ?? ""));
        const plan = planAdd(loaded, key);
        if (b["apply"] === true) applyAdd(opts.root, plan);
        return json(res, 200, { whole: plan.whole, partial: plan.partial.map((p) => ({ path: p.rel, hunks: p.hunks })), skipped: plan.skipped, applied: b["apply"] === true });
      }
      return json(res, 404, { error: "Not found" });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve(`http://127.0.0.1:${port}/#t=${token}`);
    });
  });
}
