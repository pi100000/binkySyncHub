// Transfer module — real implementation, whole-file only (per our v1
// decision — no chunking/resuming, that's a deliberate later upgrade).
//
// The source side (serving files) lives in api/server.ts as a plain
// GET /files/<path> route, since it needs to share the same HTTP server
// and "what am I sharing" state as the rest of the API. This file owns
// the parts that are genuinely transfer-specific: safely resolving a
// relative path against a root, and the target side — pulling a diff's
// worth of changes from a peer and applying them to a local folder,
// reporting progress as it goes so the UI can show something better
// than a frozen screen.

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { DiffEntry } from "../types.js";

/**
 * Resolve a relative path against a root, refusing to leave that root
 * (blocks "../../etc/passwd"-style traversal from either a malicious
 * peer or a buggy manifest entry).
 */
export function safeJoin(root: string, relPath: string): string {
  const normalizedRoot = normalize(root);
  const target = normalize(join(normalizedRoot, relPath));
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(`Refusing to access path outside root: ${relPath}`);
  }
  return target;
}

/** Encode a relative path for use in a URL, preserving directory separators. */
export function encodePathForUrl(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/** Decode a URL path segment back into a relative file path. */
export function decodeUrlPath(urlPath: string): string {
  return urlPath.split("/").map(decodeURIComponent).join("/");
}

export interface PullProgress {
  completed: number;
  total: number;
  currentFile: string;
}

export interface TransferService {
  /**
   * Pull every changed file in `changes` from a peer's engine, into
   * localRootPath. Changes are applied one at a time (not in parallel)
   * — deliberately simple, and it means onProgress fires in a clean,
   * predictable sequence the UI can just display as-is.
   */
  pullChanges(
    peerUrl: string,
    changes: DiffEntry[],
    localRootPath: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void>;
}

export function createTransferService(): TransferService {
  return {
    async pullChanges(peerUrl, changes, localRootPath, onProgress) {
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        onProgress?.({ completed: i, total: changes.length, currentFile: change.path });

        const localPath = safeJoin(localRootPath, change.path);

        if (change.action === "remove") {
          await unlink(localPath).catch(() => {
            // Already gone, or never existed locally — fine either way.
          });
          continue;
        }

        // "add" or "update" — both mean "fetch the current version".
        const url = `${peerUrl}/files/${encodePathForUrl(change.path)}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch "${change.path}" from ${peerUrl}: HTTP ${res.status}`);
        }

        const bytes = Buffer.from(await res.arrayBuffer());
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, bytes);
      }

      onProgress?.({ completed: changes.length, total: changes.length, currentFile: "" });
    },
  };
}
