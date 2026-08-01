// Manifest module — the core of "diffing" as we discussed:
// walk a folder -> hash every file -> compare two such lists.

import { readdir, stat, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashFile } from "../hashing/index.js";
import type { Manifest, ManifestEntry, DiffResult, DiffEntry } from "../types.js";

/** Recursively list every file under a root folder (relative paths). */
async function walk(root: string, dir: string = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip the usual junk you never want synced or hashed.
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Build a manifest for a folder: hash every file inside it.
 * Creates the folder if it doesn't exist yet (so a fresh sync
 * destination that hasn't been created starts as a valid, empty manifest
 * instead of throwing).
 */
export async function buildManifest(rootPath: string): Promise<Manifest> {
  await mkdir(rootPath, { recursive: true });
  const filePaths = await walk(rootPath);

  const entries: ManifestEntry[] = await Promise.all(
    filePaths.map(async (absolutePath) => {
      const [hash, fileStat] = await Promise.all([hashFile(absolutePath), stat(absolutePath)]);
      return {
        path: relative(rootPath, absolutePath).split("\\").join("/"), // normalize Windows separators
        hash,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    }),
  );

  return { rootPath, builtAt: Date.now(), entries };
}

/**
 * Compare a source manifest (the "truth") against a target manifest
 * (what you currently have). Returns exactly what the target needs to
 * pull to match the source — this is a one-way diff, matching our v1
 * one-way sync decision.
 */
export function diffManifests(source: Manifest, target: Manifest): DiffResult {
  const targetByPath = new Map(target.entries.map((e) => [e.path, e]));
  const sourceByPath = new Map(source.entries.map((e) => [e.path, e]));

  const changes: DiffEntry[] = [];
  let unchangedCount = 0;

  for (const sourceEntry of source.entries) {
    const targetEntry = targetByPath.get(sourceEntry.path);
    if (!targetEntry) {
      changes.push({ path: sourceEntry.path, action: "add", entry: sourceEntry });
    } else if (targetEntry.hash !== sourceEntry.hash) {
      changes.push({ path: sourceEntry.path, action: "update", entry: sourceEntry });
    } else {
      unchangedCount++;
    }
  }

  // Files the target has that the source no longer does.
  for (const targetEntry of target.entries) {
    if (!sourceByPath.has(targetEntry.path)) {
      changes.push({ path: targetEntry.path, action: "remove" });
    }
  }

  return { changes, unchangedCount };
}
