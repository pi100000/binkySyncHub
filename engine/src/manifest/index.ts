// Manifest module: walk a folder -> hash every file -> compare two
// such lists. This is the core of "diffing" from our design discussion.

import { readdir, stat, mkdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { hashFile } from "../hashing/index.js";
import { mapWithConcurrency } from "../util.js";
import type { Manifest, ManifestEntry, DiffResult, DiffEntry } from "../types.js";

const HASH_CONCURRENCY = 32;

async function walk(root: string, dir: string = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function hashOne(absolutePath: string, relPath: string): Promise<ManifestEntry> {
  const [hash, fileStat] = await Promise.all([hashFile(absolutePath), stat(absolutePath)]);
  return { path: relPath, hash, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
}

/** Build a manifest for a folder. Creates the folder if it doesn't exist yet. */
export async function buildManifest(rootPath: string): Promise<Manifest> {
  await mkdir(rootPath, { recursive: true });
  const filePaths = await walk(rootPath);
  const entries = await mapWithConcurrency(filePaths, HASH_CONCURRENCY, (absolutePath) =>
    hashOne(absolutePath, relative(rootPath, absolutePath).split("\\").join("/")),
  );
  return { rootPath, builtAt: Date.now(), entries };
}

/**
 * Build a manifest from an explicit list of individual files (not
 * necessarily sharing a folder) — used when sharing specific files.
 * relPath = each file's basename, deduped on collision.
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

  return { manifest: { rootPath: "(individual files)", builtAt: Date.now(), entries }, fileMap };
}

export function totalSize(manifest: Manifest): number {
  return manifest.entries.reduce((sum, e) => sum + e.size, 0);
}

/**
 * Compare a source manifest (the truth) against a target manifest
 * (what's currently there). One-way: tells the target exactly what to
 * add/update/remove to match the source.
 */
export function diffManifests(source: Manifest, target: Manifest): DiffResult {
  const targetByPath = new Map(target.entries.map((e) => [e.path, e]));
  const sourceByPath = new Map(source.entries.map((e) => [e.path, e]));

  const changes: DiffEntry[] = [];
  let unchangedCount = 0;

  for (const sourceEntry of source.entries) {
    const targetEntry = targetByPath.get(sourceEntry.path);
    if (!targetEntry) changes.push({ path: sourceEntry.path, action: "add", entry: sourceEntry });
    else if (targetEntry.hash !== sourceEntry.hash)
      changes.push({ path: sourceEntry.path, action: "update", entry: sourceEntry });
    else unchangedCount++;
  }

  for (const targetEntry of target.entries) {
    if (!sourceByPath.has(targetEntry.path)) changes.push({ path: targetEntry.path, action: "remove" });
  }

  return { changes, unchangedCount };
}
