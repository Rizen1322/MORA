/**
 * Adds many provider tracks to the library, optionally liking them. At most
 * `concurrency` full downloads run at once; a cancelled batch starts nothing
 * new. A like is sent only for a track that is not liked yet, so tracks that
 * come from the service's own likes are never liked there a second time.
 */
export interface BatchItem { key: string; trackId?: string | null }
export interface BatchDeps {
  importOne(item: BatchItem): Promise<string>;
  isLiked(trackId: string): boolean | Promise<boolean>;
  like(trackId: string): Promise<void>;
  onProgress(p: { done: number; total: number; failed: number }): void;
  cancelled(): boolean;
}

export async function addBatch(items: BatchItem[], like: boolean, deps: BatchDeps, concurrency = 2): Promise<{ added: string[]; liked: number; failed: number }> {
  const added: (string | undefined)[] = new Array(items.length);
  let next = 0, done = 0, failed = 0, liked = 0;
  const worker = async () => {
    while (next < items.length && !deps.cancelled()) {
      const index = next++;
      const item = items[index];
      try {
        const id = item.trackId ?? await deps.importOne(item);
        if (like && !(await deps.isLiked(id))) { await deps.like(id); liked++; }
        added[index] = id;
      } catch {
        failed++;
      }
      deps.onProgress({ done: ++done, total: items.length, failed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { added: added.filter((id): id is string => !!id), liked, failed };
}
