export function waveDownloadIds(next: string[], count: number, available: Set<string>): string[] {
  return [5, 10, 20, 50].includes(count) ? [...new Set(next.slice(0, count))].filter(id => !available.has(id)) : [];
}
