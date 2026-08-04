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
import { randomUUID } from "node:crypto";
import { buildManifest, buildManifestFromFiles, diffManifests } from "../manifest/index.js";
import { safeJoin, decodeUrlPath, createTransferService } from "../transfer/index.js";
import type { DiscoveryService } from "../discovery/index.js";
import type { Manifest, DiffEntry } from "../types.js";

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

interface SharedState {
  manifest: Manifest;
  /** relPath -> absolute path on disk, or null if not shared/not found. */
  resolvePath: (relPath: string) => string | null;
}

type SyncJobStatus = "running" | "done" | "error";

interface SyncJob {
  id: string;
  status: SyncJobStatus;
  total: number;
  completed: number;
  currentFile: string;
  applied: number;
  unchanged: number;
  error?: string;
}

export function startApiServer(port: number, deps: ApiServerDeps) {
  const transfer = createTransferService();

  let shared: SharedState | null = null;
  const jobs = new Map<string, SyncJob>();

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

      // Start sharing either a whole folder or an explicit list of
      // individual files. Either way, `shared` ends up with a manifest
      // plus a way to resolve a relative path back to a real file.
      if (req.method === "POST" && req.url === "/share") {
        const { folderPath, filePaths } = await readJsonBody<{
          folderPath?: string;
          filePaths?: string[];
        }>(req);

        if (folderPath) {
          const manifest = await buildManifest(folderPath);
          shared = {
            manifest,
            resolvePath: (relPath) => {
              try {
                return safeJoin(folderPath, relPath);
              } catch {
                return null;
              }
            },
          };
        } else if (filePaths && filePaths.length > 0) {
          const { manifest, fileMap } = await buildManifestFromFiles(filePaths);
          shared = { manifest, resolvePath: (relPath) => fileMap.get(relPath) ?? null };
        } else {
          return sendJson(res, 400, { error: "folderPath or filePaths is required" });
        }

        return sendJson(res, 200, { manifest: shared.manifest });
      }

      // What a peer calls to find out what you're sharing right now.
      if (req.method === "GET" && req.url === "/share/manifest") {
        if (!shared) return sendJson(res, 404, { error: "not currently sharing anything" });
        return sendJson(res, 200, shared.manifest);
      }

      // What a peer calls to actually fetch one file's bytes.
      if (req.method === "GET" && req.url?.startsWith("/files/")) {
        if (!shared) return sendJson(res, 404, { error: "not currently sharing anything" });

        const relPath = decodeUrlPath(req.url.slice("/files/".length));
        const absolutePath = shared.resolvePath(relPath);
        if (!absolutePath) return sendJson(res, 404, { error: "file not shared" });

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

      // Step 1 of syncing: show what WOULD change, without touching
      // anything yet. The UI uses this to render a checklist so people
      // can see (and deselect) individual files before anything moves.
      if (req.method === "POST" && req.url === "/sync/preview") {
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

        return sendJson(res, 200, diff);
      }

      // Step 2: actually apply a (possibly filtered-down) list of
      // changes. Runs as a background job so the request returns
      // immediately — the UI polls /sync/jobs/:id for progress instead
      // of blocking on one long request, which is also what lets a big
      // sync show real progress instead of a frozen screen.
      if (req.method === "POST" && req.url === "/sync/apply") {
        const { peerUrl, localFolderPath, changes } = await readJsonBody<{
          peerUrl: string;
          localFolderPath: string;
          changes: DiffEntry[];
        }>(req);
        if (!peerUrl || !localFolderPath || !changes) {
          return sendJson(res, 400, {
            error: "peerUrl, localFolderPath, and changes are required",
          });
        }

        const jobId = randomUUID();
        const job: SyncJob = {
          id: jobId,
          status: "running",
          total: changes.length,
          completed: 0,
          currentFile: "",
          applied: 0,
          unchanged: 0,
        };
        jobs.set(jobId, job);

        // Deliberately not awaited — this runs in the background while
        // we respond with the job id right away.
        transfer
          .pullChanges(peerUrl, changes, localFolderPath, (progress) => {
            job.completed = progress.completed;
            job.currentFile = progress.currentFile;
          })
          .then(() => {
            job.status = "done";
            job.applied = changes.length;
          })
          .catch((err) => {
            job.status = "error";
            job.error = (err as Error).message;
          });

        return sendJson(res, 202, { jobId });
      }

      if (req.method === "GET" && req.url?.startsWith("/sync/jobs/")) {
        const jobId = req.url.slice("/sync/jobs/".length);
        const job = jobs.get(jobId);
        if (!job) return sendJson(res, 404, { error: "unknown job id" });
        return sendJson(res, 200, job);
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
