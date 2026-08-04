// Runs `fn` over `items`, at most `limit` at a time.
//
// Why this exists: hashing every file in a folder via a plain
// Promise.all opens one file handle per file, all at once. For folders
// with more than a few hundred files (very possible for a big modpack
// or a folder picked by mistake), that blows past the OS's open-file
// limit and fails with EMFILE. Capping concurrency keeps memory/handle
// usage predictable regardless of folder size, at a small cost to
// wall-clock time on very fast disks.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
