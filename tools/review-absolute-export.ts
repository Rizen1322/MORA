export const ABSOLUTE_DEFECTS = ['two-voices', 'rhythm', 'cut-a', 'b-opening', 'energy', 'abrupt'] as const;
export type AbsoluteDefect = typeof ABSOLUTE_DEFECTS[number];
export type AbsoluteRating = 'good' | 'acceptable' | 'bad' | 'unrated';
export type AbsoluteVote = { rating?: AbsoluteRating; defects?: string[]; comment?: string };
export type AbsoluteReviewManifest = {
  reviewId: string;
  manifestSha256: string;
  groups: { id: number; variants: { variantId: string }[] }[];
};

export type AbsoluteReviewExport = { schema: 'mora-listening-absolute-1'; version: 1; reviewId: string; manifestSha256: string; exportedAt: string;
  variantVotes: { groupId: number; variantId: string; rating: AbsoluteRating; defects: AbsoluteDefect[]; comment: string }[] };

function validManifest(manifest: AbsoluteReviewManifest): boolean {
  if (!manifest || typeof manifest.reviewId !== 'string' || !manifest.reviewId.trim() || !/^[a-f0-9]{64}$/i.test(manifest.manifestSha256)
    || !Array.isArray(manifest.groups)) return false;
  const groups = new Set<number>(), variants = new Set<string>();
  for (const group of manifest.groups) {
    if (!group || !Number.isSafeInteger(group.id) || groups.has(group.id) || !Array.isArray(group.variants)) return false;
    groups.add(group.id);
    for (const variant of group.variants) {
      if (!variant || typeof variant.variantId !== 'string' || !variant.variantId.trim() || variants.has(variant.variantId)) return false;
      variants.add(variant.variantId);
    }
  }
  return true;
}

/** Produce a self-contained per-variant export, never the older pairwise votes shape. */
export function buildAbsoluteReviewExport(
  manifest: AbsoluteReviewManifest,
  votes: Record<string, AbsoluteVote>,
  exportedAt: string,
): AbsoluteReviewExport {
  if (!validManifest(manifest)) throw new Error('Invalid absolute review manifest identity');
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error('Invalid export timestamp');
  const known = new Set<string>();
  for (const id of Object.keys(votes)) if (!manifest.groups.some(group => group.variants.some(variant => variant.variantId === id))) throw new Error(`Unknown variant id: ${id}`);
  const variantVotes = manifest.groups.flatMap(group => group.variants.map(variant => {
    if (known.has(variant.variantId)) throw new Error(`Duplicate variant id: ${variant.variantId}`);
    known.add(variant.variantId);
    const vote = votes[variant.variantId] ?? {};
    const rating = vote.rating ?? 'unrated';
    if (!['good', 'acceptable', 'bad', 'unrated'].includes(rating)) throw new Error(`Invalid rating for ${variant.variantId}`);
    const defects = vote.defects ?? [];
    if (!Array.isArray(defects) || defects.some(x => !(ABSOLUTE_DEFECTS as readonly string[]).includes(x))) throw new Error(`Invalid defect for ${variant.variantId}`);
    if (vote.comment !== undefined && typeof vote.comment !== 'string') throw new Error(`Invalid comment for ${variant.variantId}`);
    return { groupId: group.id, variantId: variant.variantId, rating: rating as AbsoluteRating,
      defects: [...new Set(defects)] as AbsoluteDefect[],
      comment: typeof vote.comment === 'string' ? vote.comment : '' };
  }));
  return { schema: 'mora-listening-absolute-1', version: 1, reviewId: manifest.reviewId, manifestSha256: manifest.manifestSha256, exportedAt, variantVotes };
}

/** Validate a downloaded export against its immutable manifest before accepting it. */
export function validateAbsoluteReviewExport(value: unknown, manifest: AbsoluteReviewManifest): value is AbsoluteReviewExport {
  if (!validManifest(manifest)) return false;
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<AbsoluteReviewExport>;
  if (Object.keys(value).sort().join(',') !== ['exportedAt', 'manifestSha256', 'reviewId', 'schema', 'variantVotes', 'version'].sort().join(',')) return false;
  if (x.schema !== 'mora-listening-absolute-1' || x.version !== 1 || x.reviewId !== manifest.reviewId || x.manifestSha256 !== manifest.manifestSha256
    || typeof x.exportedAt !== 'string' || !Number.isFinite(Date.parse(x.exportedAt)) || !Array.isArray(x.variantVotes)) return false;
  const expected = new Map(manifest.groups.flatMap(g => g.variants.map(v => [v.variantId, g.id] as const)));
  if (expected.size !== x.variantVotes.length) return false;
  const seen = new Set<string>();
  for (const row of x.variantVotes) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== ['comment', 'defects', 'groupId', 'rating', 'variantId'].sort().join(',')
      || !expected.has(row.variantId) || seen.has(row.variantId) || expected.get(row.variantId) !== row.groupId
      || !['good', 'acceptable', 'bad', 'unrated'].includes(row.rating) || !Array.isArray(row.defects)
      || row.defects.some(d => !(ABSOLUTE_DEFECTS as readonly string[]).includes(d)) || typeof row.comment !== 'string') return false;
    seen.add(row.variantId);
  }
  return true;
}

export function serializeAbsoluteReviewExport(manifest: AbsoluteReviewManifest, votes: Record<string, AbsoluteVote>, exportedAt: string): string {
  return JSON.stringify(buildAbsoluteReviewExport(manifest, votes, exportedAt), null, 2);
}
