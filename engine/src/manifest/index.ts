// Manifest module — the core of "diffing" as we discussed:
// walk a folder -> hash every file -> compare two such lists.

import { readdir, stat, mkdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { hashFile } from "../hashing/index.js";
import { mapWithConcurrency } from "../util.js";
import type { Manifest, ManifestEntry, DiffResult, DiffEntry } from "../types.js";

// How many files to hash at once. High enough to get real parallelism
// benefit on fast disks, low enough to stay well under typical OS
// open-file limits (often 1024 on Linux, similar on Windows) even when
// a folder has thousands of files.
const HASH_CONCURRENCY = 32;

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

async function hashOne(absolutePath: string, relPath: string): Promise<ManifestEntry> {
  const [hash, fileStat] = await Promise.all([hashFile(absolutePath), stat(absolutePath)]);
  return { path: relPath, hash, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
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

  const entries = await mapWithConcurrency(filePaths, HASH_CONCURRENCY, (absolutePath) =>
    // Normalize Windows separators so manifests are comparable across platforms.
    hashOne(absolutePath, relative(rootPath, absolutePath).split("\\").join("/")),
  );

  return { rootPath, builtAt: Date.now(), entries };
}

/**
 * Build a manifest from an explicit list of individual files (not
 * necessarily in the same folder) — used when someone shares specific
 * files rather than a whole folder. Returns both the manifest (relPath
 * = each file's basename) and a lookup back to the real absolute path,
 * since there's no single root to resolve paths against later.
 *
 * If two selected files share a basename, the later one gets a numeric
 * suffix so nothing silently overwrites — a rare edge case for a
 * friend-to-friend tool, not worth more complexity than that.
 */
export async function buildManifestFromFiles(
  absolutePaths: string[],
): Promise<{ manifest: Manifest; fileMap: Map<string, string> }> {
  const fileMap = new Map<string, string>();
  const relPaths: string[] = [];

  for (const absolutePath of absolutePaths) {
    let relPath = basename(absolutePath);
    let suffix = 1;
    while (fileMap.has(relPath)) {
      const dot = relPath.lastIndexOf(".");
      const stem = dot > 0 ? relPath.slice(0, dot) : relPath;
      const ext = dot > 0 ? relPath.slice(dot) : "";
      relPath = `${stem} (${++suffix})${ext}`;
    }
    fileMap.set(relPath, absolutePath);
    relPaths.push(relPath);
  }

  const entries = await mapWithConcurrency(relPaths, HASH_CONCURRENCY, (relPath) =>
    hashOne(fileMap.get(relPath)!, relPath),
  );

  return {
    manifest: { rootPath: "(individual files)", builtAt: Date.now(), entries },
    fileMap,
  };
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
