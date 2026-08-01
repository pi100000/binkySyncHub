// Local API server.
//
// The UI (Tauri webview) never touches the engine's internals directly —
// it only ever calls this HTTP API on localhost. That's what lets the
// engine be rewritten later (Node -> Bun -> Rust/Go binary) without
// touching a single line of frontend code, as long as the new engine
// answers these same routes. This same API is also what a FRIEND's
// engine calls into (GET /share/manifest, GET /files/*) when they sync
// from you — one HTTP surface serves both the local UI and other peers.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { buildManifest, diffManifests } from "../manifest/index.js";
import { safeJoin, decodeUrlPath, createTransferService } from "../transfer/index.js";
import type { DiscoveryService } from "../discovery/index.js";
import type { Manifest } from "../types.js";

// The UI runs in a Tauri webview on http://localhost:1420 (Vite's dev
// server), while the engine listens on a different port (127.0.0.1:4021)
// — different port means different origin, so the browser enforces CORS
// even though both are "localhost". This is a local, single-user API
// with no cookies/credentials involved, so a permissive wildcard is fine
// here (this isn't a public-facing server).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
    ...CORS_HEADERS,
  });
  res.end(payload);
}

export interface ApiServerDeps {
  discovery: DiscoveryService;
}

export function startApiServer(port: number, deps: ApiServerDeps) {
  const transfer = createTransferService();

  // The one piece of state this server holds: which folder (if any)
  // this instance is currently sharing, and a cached manifest of it so
  // peers hitting GET /share/manifest repeatedly don't force a full
  // re-hash every time. /share rebuilds this cache; nothing else does.
  let sharedRoot: string | null = null;
  let sharedManifest: Manifest | null = null;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

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
        const diff = diffManifests(source as Manifest, target as Manifest);
        return sendJson(res, 200, diff);
      }

      // Start sharing a folder: hash it now, cache the manifest, and
      // start answering GET /files/* out of it. This is the "one-way
      // source of truth" role from our architecture discussion — one
      // friend shares, others pull.
      if (req.method === "POST" && req.url === "/share") {
        const { folderPath } = await readJsonBody<{ folderPath: string }>(req);
        if (!folderPath) return sendJson(res, 400, { error: "folderPath is required" });
        sharedRoot = folderPath;
        sharedManifest = await buildManifest(folderPath);
        return sendJson(res, 200, { sharing: sharedRoot, manifest: sharedManifest });
      }

      // What a peer calls to find out what you're sharing right now.
      if (req.method === "GET" && req.url === "/share/manifest") {
        if (!sharedRoot || !sharedManifest) {
          return sendJson(res, 404, { error: "not currently sharing a folder" });
        }
        return sendJson(res, 200, sharedManifest);
      }

      // What a peer calls to actually fetch one file's bytes.
      if (req.method === "GET" && req.url?.startsWith("/files/")) {
        if (!sharedRoot) return sendJson(res, 404, { error: "not currently sharing a folder" });

        const relPath = decodeUrlPath(req.url.slice("/files/".length));
        let absolutePath: string;
        try {
          absolutePath = safeJoin(sharedRoot, relPath);
        } catch {
          return sendJson(res, 400, { error: "invalid path" });
        }

        try {
          const fileStat = await stat(absolutePath);
          if (!fileStat.isFile()) throw new Error("not a file");
        } catch {
          return sendJson(res, 404, { error: "file not found" });
        }

        res.writeHead(200, { "Content-Type": "application/octet-stream", ...CORS_HEADERS });
        const stream = createReadStream(absolutePath);
        stream.pipe(res);
        stream.on("error", () => res.end());
        return;
      }

      // Friends currently visible on the LAN.
      if (req.method === "GET" && req.url === "/peers") {
        return sendJson(res, 200, { peers: deps.discovery.getKnownPeers() });
      }

      // The actual sync: pull whatever's changed from a peer into a
      // local folder. One-way, per our v1 decision — the peer's copy
      // is the truth, localFolderPath ends up matching it exactly.
      if (req.method === "POST" && req.url === "/sync/pull") {
        const { peerUrl, localFolderPath } = await readJsonBody<{
          peerUrl: string;
          localFolderPath: string;
        }>(req);
        if (!peerUrl || !localFolderPath) {
          return sendJson(res, 400, { error: "peerUrl and localFolderPath are required" });
        }

        const manifestRes = await fetch(`${peerUrl}/share/manifest`).catch(() => null);
        if (!manifestRes || !manifestRes.ok) {
          return sendJson(res, 502, {
            error: `Could not reach ${peerUrl}/share/manifest (is your friend sharing?)`,
          });
        }
        const sourceManifest = (await manifestRes.json()) as Manifest;
        const targetManifest = await buildManifest(localFolderPath);
        const diff = diffManifests(sourceManifest, targetManifest);

        await transfer.pullChanges(peerUrl, diff.changes, localFolderPath);

        return sendJson(res, 200, {
          applied: diff.changes.length,
          unchanged: diff.unchangedCount,
          changes: diff.changes,
        });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[api] request failed:", err);
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[api] engine listening on http://0.0.0.0:${port}`);
  });

  return server;
}
