import { useEffect, useRef, useState } from 'react';

export interface CatalogCacheEntry<T> { value: T; expires: number }

export function useCatalogResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  cache: Map<string, CatalogCacheEntry<T>>,
  { scope = null, retainPrefix }: { scope?: string | null; retainPrefix?: string } = {},
) {
  const loader = useRef(load); loader.current = load;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; value: T; scope: typeof scope } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string; scope: typeof scope } | null>(null);
  const cacheKey = key === null ? null : JSON.stringify([scope, key]);
  const previous = result?.scope === scope ? result : null;
  const cached = cacheKey === null ? undefined : cache.get(cacheKey);
  const current = cached && cached.expires > Date.now() ? cached.value : previous?.key === key ? previous.value : null;
  const retained = key && retainPrefix && key.startsWith(retainPrefix) && previous?.key.startsWith(retainPrefix) ? previous : null;
  useEffect(() => {
    if (!key || !cacheKey) return;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      setFailure(null);
      setResult({ key, value: cached.value, scope });
      return;
    }
    const abort = new AbortController();
    setFailure(null);
    void loader.current(abort.signal).then((value) => {
      if (abort.signal.aborted) return;
      cache.delete(cacheKey);
      cache.set(cacheKey, { value, expires: Date.now() + 180_000 });
      if (cache.size > 40) cache.delete(cache.keys().next().value!);
      setResult({ key, value, scope });
    }).catch((e) => { if (!abort.signal.aborted) setFailure({ key, message: (e as Error).message, scope }); });
    return () => abort.abort();
  }, [key, attempt, cache, scope, cacheKey]);
  const error = failure?.scope === scope && failure.key === key ? failure.message : null;
  return { data: current ?? retained?.value ?? null, dataKey: current ? key : retained?.key, error,
    loading: !!key && current === null && !error, retry: () => setAttempt((v) => v + 1) };
}
