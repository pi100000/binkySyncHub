// Hashing module.
//
// v1 uses Node's built-in SHA-256 — zero extra dependencies, plenty fast
// for mod/config-sized files. If large game folders make this a
// bottleneck later, this is the first module to swap: BLAKE3 has JS and
// native bindings, so the fix is "change the implementation of
// hashFile", not "change the architecture". Nothing outside this file
// needs to know which algorithm is in use — only that hash() is
// prefixed with the algorithm name, so future algorithm changes never
// collide with old manifests.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const ALGO = "sha256";

/** Hash a file's contents by streaming it — safe for large files. */
export function hashFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(ALGO);
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`${ALGO}:${hash.digest("hex")}`));
    stream.on("error", reject);
  });
}
