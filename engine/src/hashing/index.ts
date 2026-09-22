// Hashing module. SHA-256 for now, zero extra dependencies — swap this
// implementation for BLAKE3 later if hashing ever becomes the
// bottleneck; nothing outside this file needs to know or care.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const ALGO = "sha256";

export function hashFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(ALGO);
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`${ALGO}:${hash.digest("hex")}`));
    stream.on("error", reject);
  });
}
