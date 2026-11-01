// Safe, bounded concurrent ledger reads. No signing or submitting occurs here.
export const MAX_READ_CONCURRENCY = 3;

export async function mapValidatedParallel(items, verify, limit = MAX_READ_CONCURRENCY, onProgress = () => {}) {
  if (!Array.isArray(items) || typeof verify !== "function") throw new Error("Invalid verification task");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_CONCURRENCY)
    throw new Error("Read concurrency exceeds the safe limit");
  const results = new Array(items.length);
  let cursor = 0, completed = 0;
  let firstFailure = null;

  async function worker() {
    while (!firstFailure) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await verify(items[index], index);
        completed++;
        onProgress({completed, total:items.length});
      } catch (error) {
        firstFailure ??= error;
      }
    }
  }
  const workers = Array.from({length:Math.min(limit,items.length)}, () => worker());
  await Promise.all(workers);
  if (firstFailure) throw firstFailure;
  return results;
}
