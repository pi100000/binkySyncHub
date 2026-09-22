// Shared types across the engine — the contract that lets the UI (and,
// later, a rewritten engine) all agree on shape without touching each
// other's internals.

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface Manifest {
  rootPath: string;
  builtAt: number;
  entries: ManifestEntry[];
}

export type DiffAction = "add" | "update" | "remove";

export interface DiffEntry {
  path: string;
  action: DiffAction;
  entry?: ManifestEntry;
}

export interface DiffResult {
  changes: DiffEntry[];
  unchangedCount: number;
}

/** A peer discovered on the LAN. */
export interface Peer {
  id: string;
  displayName: string;
  reachability: "lan" | "relay";
  address?: string; // full base URL, e.g. "http://192.168.1.23:4021"
}

/** Something one engine instance is sharing — a single catalog entry. */
export interface SharedItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  fileCount: number;
  totalSize: number;
}

/** A SharedItem as seen from another peer's /browse aggregation. */
export interface BrowseEntry extends SharedItem {
  peerId: string;
  peerName: string;
  peerAddress: string;
}
