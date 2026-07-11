// Local API server.
//
// The UI (Tauri webview) never touches the engine's internals directly —
// it only ever calls this HTTP API on localhost. That's what lets the
// engine be rewritten later (Node -> Bun -> Rust/Go binary) without
// touching a single line of frontend code, as long as the new engine
// answers these same routes.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildManifest, diffManifests } from "../manifest/index.js";

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startApiServer(port: number) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (req.method === "POST" && req.url === "/manifest/build") {
        const { folderPath } = await readJsonBody<{ folderPath: string }>(req);
        if (!folderPath) return sendJson(res, 400, { error: "folderPath is required" });
        const manifest = await buildManifest(folderPath);
        return sendJson(res, 200, manifest);
      }

      if (req.method === "POST" && req.url === "/manifest/diff") {
        const { source, target } = await readJsonBody<{ source: unknown; target: unknown }>(req);
        if (!source || !target) {
          return sendJson(res, 400, { error: "source and target manifests are required" });
        }
        const diff = diffManifests(source as never, target as never);
        return sendJson(res, 200, diff);
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[api] request failed:", err);
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[api] engine listening on http://127.0.0.1:${port}`);
  });

  return server;
}
