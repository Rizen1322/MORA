/** Songs a bulk "like all" changes: not liked yet; a dislike was a deliberate choice and stays. */
export function toLike<T>(items: T[], reaction: (item: T) => number): T[] {
  return items.filter((item) => reaction(item) === 0);
}

/** Likes one by one with a few requests in flight: a long playlist must not flood the service. */
export async function likeEach<T>(items: T[], like: (item: T) => Promise<void>, parallel = 3): Promise<{ liked: number; failed: number }> {
  let next = 0, liked = 0, failed = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await like(item); liked++; } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  return { liked, failed };
}

export function likeAllSummary(liked: number, failed: number, kept: number): string {
  const parts = [liked ? `В любимое добавлено: ${liked}` : 'Новых лайков нет — всё уже в любимом'];
  if (kept) parts.push(`с дизлайком оставлено как есть: ${kept}`);
  if (failed) parts.push(`не получилось: ${failed}`);
  return parts.join(' · ');
}
