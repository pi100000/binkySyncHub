// Transfer module — NOT YET IMPLEMENTED.
//
// Plan for v1 (whole-file transfer, per our discussion): each engine
// instance runs a small HTTP server. To pull a file, a peer just does
// GET /files/<path> against the source peer's address and streams the
// response to disk. No chunking, no resuming — that's a deliberate v2
// upgrade, not a v1 requirement.
//
// serveFiles() is the source side (answers GET /files/*).
// pullFile() is the target side (fetches one file from a peer).

import type { Peer, DiffEntry } from "../types.js";

export interface TransferService {
  /** Start serving this folder's files to other peers. Returns the port it's listening on. */
  serveFiles(rootPath: string): Promise<number>;
  /** Pull every changed file in a diff from a peer, into localRootPath. */
  pullChanges(peer: Peer, changes: DiffEntry[], localRootPath: string): Promise<void>;
}

export function createTransferService(): TransferService {
  return {
    async serveFiles(rootPath) {
      // TODO: start an HTTP server (e.g. via node:http) that streams
      // files from rootPath, guarding against path traversal.
      console.log(`[transfer] stub — would serve files from ${rootPath}`);
      return 0;
    },
    async pullChanges(peer, changes, localRootPath) {
      // TODO: for each "add"/"update" entry, GET the file from
      // peer.address and write it under localRootPath. For "remove",
      // delete the local file.
      console.log(
        `[transfer] stub — would pull ${changes.length} change(s) from ${peer.displayName} into ${localRootPath}`,
      );
    },
  };
}
