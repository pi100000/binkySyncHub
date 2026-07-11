// Shared types across the engine.
//
// This file is the "API contract" mentioned in our architecture discussion.
// As long as whatever runs the engine (Node now, maybe Rust/Go later)
// produces data shaped like this, the UI never has to change.

export interface ManifestEntry {
  /** Path relative to the synced folder's root, e.g. "config/settings.toml" */
  path: string;
  /** Content hash of the file, e.g. "sha256:9c2d41..." */
  hash: string;
  /** Size in bytes */
  size: number;
  /** Last modified time, ms since epoch (informational only — hash is the source of truth) */
  mtimeMs: number;
}

export interface Manifest {
  /** Root folder this manifest describes */
  rootPath: string;
  /** When this manifest was built, ms since epoch */
  builtAt: number;
  entries: ManifestEntry[];
}

export type DiffAction = "add" | "update" | "remove";

export interface DiffEntry {
  path: string;
  action: DiffAction;
  /** The entry to fetch (present for "add" and "update") */
  entry?: ManifestEntry;
}

export interface DiffResult {
  /** Files present in target but missing/different from source */
  changes: DiffEntry[];
  /** Files identical in both — no action needed */
  unchangedCount: number;
}

/** A peer discovered on the network (LAN or via relay) */
export interface Peer {
  id: string;
  displayName: string;
  /** "lan" = direct mDNS discovery, "relay" = reachable only via relay */
  reachability: "lan" | "relay";
  address?: string; // host:port, only set for "lan" peers
}
