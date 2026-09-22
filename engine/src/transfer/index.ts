// Transfer module — whole-file HTTP transfer with path-traversal safety.

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { DiffEntry } from "../types.js";

export function safeJoin(root: string, relPath: string): string {
  const normalizedRoot = normalize(root);
  const target = normalize(join(normalizedRoot, relPath));
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(`Refusing to access path outside root: ${relPath}`);
  }
  return target;
}

export function encodePathForUrl(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export function decodeUrlPath(urlPath: string): string {
  return urlPath.split("/").map(decodeURIComponent).join("/");
}

export interface PullProgress {
  completed: number;
  total: number;
  currentFile: string;
}

export interface TransferService {
  pullChanges(
    peerUrl: string,
    itemId: string,
    changes: DiffEntry[],
    localRootPath: string,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void>;
}

export function createTransferService(): TransferService {
  return {
    async pullChanges(peerUrl, itemId, changes, localRootPath, onProgress) {
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        onProgress?.({ completed: i, total: changes.length, currentFile: change.path });

        const localPath = safeJoin(localRootPath, change.path);

        if (change.action === "remove") {
          await unlink(localPath).catch(() => {});
          continue;
        }

        const url = `${peerUrl}/files/${itemId}/${encodePathForUrl(change.path)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch "${change.path}" from ${peerUrl}: HTTP ${res.status}`);

        const bytes = Buffer.from(await res.arrayBuffer());
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, bytes);
      }

      onProgress?.({ completed: changes.length, total: changes.length, currentFile: "" });
    },
  };
}
