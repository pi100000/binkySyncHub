// Local API server. The UI only ever talks to this over HTTP — that's
// what lets the engine be swapped/rewritten later without touching the
// frontend. This same API is also what a FRIEND's engine calls into
// (GET /share/list, GET /share/items/:id/manifest, GET /files/:id/*)
// when browsing/downloading from you.
//
// Model: each engine holds a small catalog of "shared items" (a folder
// or a set of files, given an id and a name). Peers discover each
// other over LAN, ask each other's /share/list, and merge the results
// into one browsable catalog via /browse. Downloading an item always
// lands in an app-owned folder (~/PeerSyncDownloads/<peer>/<item>/) —
// never a folder the person picked — so a download can safely mirror
// the source exactly (including removing stale files) with no risk of
// touching anything unrelated, and no folder-picker prompt needed.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import os from "node:os";
import {
  buildManifest,
  buildManifestFromFiles,
  diffManifests,
  totalSize,
} from "../manifest/index.js";
import { safeJoin, decodeUrlPath, createTransferService } from "../transfer/index.js";
import { sanitizeForFilename } from "../util.js";
import type { DiscoveryService } from "../discovery/index.js";
import type { Manifest, SharedItem, BrowseEntry } from "../types.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DOWNLOADS_ROOT = join(os.homedir(), "PeerSyncDownloads");
const PEER_FETCH_TIMEOUT_MS = 2000;

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

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiServerDeps {
  discovery: DiscoveryService;
}

interface LocalSharedItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  manifest: Manifest;
  resolvePath: (relPath: string) => string | null;
}

type SyncJobStatus = "running" | "done" | "error";

interface SyncJob {
  id: string;
  status: SyncJobStatus;
  total: number;
  completed: number;
  currentFile: string;
  destination: string;
  error?: string;
}

export function startApiServer(port: number, deps: ApiServerDeps) {
  const transfer = createTransferService();
  const sharedItems = new Map<string, LocalSharedItem>();
  const jobs = new Map<string, SyncJob>();

  function toSummary(item: LocalSharedItem): SharedItem {
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      fileCount: item.manifest.entries.length,
      totalSize: totalSize(item.manifest),
    };
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      // --- sharing: add to the catalog (never replaces existing items) ---

      if (req.method === "POST" && req.url === "/share") {
        const { folderPath, filePaths, name } = await readJsonBody<{
          folderPath?: string;
          filePaths?: string[];
          name?: string;
        }>(req);

        const id = randomUUID();
        let item: LocalSharedItem;

        if (folderPath) {
          const manifest = await buildManifest(folderPath);
          item = {
            id,
            name: name ?? folderPath.split(/[/\\]/).filter(Boolean).pop() ?? "Shared folder",
            kind: "folder",
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
          const defaultName =
            filePaths.length === 1
              ? filePaths[0].split(/[/\\]/).filter(Boolean).pop() ?? "Shared file"
              : `${filePaths.length} files`;
          item = {
            id,
            name: name ?? defaultName,
            kind: filePaths.length === 1 ? "file" : "folder",
            manifest,
            resolvePath: (relPath) => fileMap.get(relPath) ?? null,
          };
        } else {
          return sendJson(res, 400, { error: "folderPath or filePaths is required" });
        }

        sharedItems.set(id, item);
        return sendJson(res, 200, toSummary(item));
      }

      if (req.method === "GET" && req.url === "/share/list") {
        return sendJson(res, 200, { items: [...sharedItems.values()].map(toSummary) });
      }

      if (req.method === "POST" && req.url === "/share/remove") {
        const { id } = await readJsonBody<{ id: string }>(req);
        const removed = sharedItems.delete(id);
        return sendJson(res, 200, { removed });
      }

      if (req.method === "GET" && req.url?.match(/^\/share\/items\/[^/]+\/manifest$/)) {
        const id = req.url.split("/")[3];
        const item = sharedItems.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown shared item" });
        return sendJson(res, 200, item.manifest);
      }

      // What a peer calls to fetch one file's bytes from one shared item.
      if (req.method === "GET" && req.url?.startsWith("/files/")) {
        const rest = req.url.slice("/files/".length);
        const slashIndex = rest.indexOf("/");
        if (slashIndex === -1) return sendJson(res, 400, { error: "missing file path" });

        const itemId = rest.slice(0, slashIndex);
        const relPath = decodeUrlPath(rest.slice(slashIndex + 1));

        const item = sharedItems.get(itemId);
        if (!item) return sendJson(res, 404, { error: "unknown shared item" });

        const absolutePath = item.resolvePath(relPath);
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

      // --- browsing: what's available, from everyone we can see ---

      if (req.method === "GET" && req.url === "/peers") {
        return sendJson(res, 200, { peers: deps.discovery.getKnownPeers() });
      }

      if (req.method === "GET" && req.url === "/browse") {
        const peers = deps.discovery.getKnownPeers();
        const results = await Promise.all(
          peers.map(async (peer): Promise<BrowseEntry[]> => {
            if (!peer.address) return [];
            try {
              const res = await fetchWithTimeout(`${peer.address}/share/list`, PEER_FETCH_TIMEOUT_MS);
              if (!res.ok) return [];
              const { items } = (await res.json()) as { items: SharedItem[] };
              return items.map((item) => ({
                ...item,
                peerId: peer.id,
                peerName: peer.displayName,
                peerAddress: peer.address!,
              }));
            } catch {
              return []; // peer's offline/unreachable right now — just skip it
            }
          }),
        );
        return sendJson(res, 200, { items: results.flat(), peersOnline: peers.length });
      }

      // --- downloading: one click, engine picks the destination ---

      if (req.method === "POST" && req.url === "/download") {
        const { peerAddress, peerName, itemId, itemName } = await readJsonBody<{
          peerAddress: string;
          peerName: string;
          itemId: string;
          itemName: string;
        }>(req);
        if (!peerAddress || !itemId) {
          return sendJson(res, 400, { error: "peerAddress and itemId are required" });
        }

        const manifestRes = await fetch(`${peerAddress}/share/items/${itemId}/manifest`).catch(
          () => null,
        );
        if (!manifestRes || !manifestRes.ok) {
          return sendJson(res, 502, { error: `Could not reach ${peerAddress} for that item` });
        }
        const sourceManifest = (await manifestRes.json()) as Manifest;

        const destination = join(
          DOWNLOADS_ROOT,
          sanitizeForFilename(peerName || "friend"),
          sanitizeForFilename(itemName || itemId),
        );
        await mkdir(destination, { recursive: true });

        const targetManifest = await buildManifest(destination);
        const diff = diffManifests(sourceManifest, targetManifest);

        const jobId = randomUUID();
        const job: SyncJob = {
          id: jobId,
          status: "running",
          total: diff.changes.length,
          completed: 0,
          currentFile: "",
          destination,
        };
        jobs.set(jobId, job);

        transfer
          .pullChanges(peerAddress, itemId, diff.changes, destination, (progress) => {
            job.completed = progress.completed;
            job.currentFile = progress.currentFile;
          })
          .then(() => {
            job.status = "done";
          })
          .catch((err) => {
            job.status = "error";
            job.error = (err as Error).message;
          });

        return sendJson(res, 202, { jobId, destination });
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
