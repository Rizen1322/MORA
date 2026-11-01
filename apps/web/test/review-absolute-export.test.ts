import { describe, expect, it } from 'vitest';
import { buildAbsoluteReviewExport, serializeAbsoluteReviewExport, validateAbsoluteReviewExport } from '../../../tools/review-absolute-export.ts';

const manifest = { reviewId: 'review-absolute-2026-10-27', manifestSha256: 'a'.repeat(64), groups: [
  { id: 198, variants: [{ variantId: '198-a' }, { variantId: '198-b' }] },
] };

describe('absolute listening export', () => {
  it('exports an absolute vote for every variant with multi-select defects and no pairwise vote field', () => {
    const result = buildAbsoluteReviewExport(manifest, { '198-a': { rating: 'bad', defects: ['two-voices', 'rhythm'], comment: 'Плотно' } }, '2026-10-27T12:00:00.000Z');
    expect(result).toEqual({ schema: 'mora-listening-absolute-1', version: 1, reviewId: manifest.reviewId, manifestSha256: manifest.manifestSha256,
      exportedAt: '2026-10-27T12:00:00.000Z', variantVotes: [
        { groupId: 198, variantId: '198-a', rating: 'bad', defects: ['two-voices', 'rhythm'], comment: 'Плотно' },
        { groupId: 198, variantId: '198-b', rating: 'unrated', defects: [], comment: '' },
      ] });
    expect('votes' in result).toBe(false);
    expect('preferredVariantId' in result.variantVotes[0]).toBe(false);
    expect(validateAbsoluteReviewExport(result, manifest)).toBe(true);
    expect(JSON.parse(serializeAbsoluteReviewExport(manifest, {}, '2026-10-27T12:00:00.000Z'))).toEqual({ ...result,
      variantVotes: result.variantVotes.map(x => ({ ...x, rating: 'unrated', defects: [], comment: '' })) });
  });
  it('rejects tampered manifest identity, unknown variants, ratings, defects and duplicate IDs', () => {
    expect(() => buildAbsoluteReviewExport({ ...manifest, manifestSha256: 'wrong' }, {}, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport(manifest, { ghost: { rating: 'good' } }, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport(manifest, { '198-a': { rating: 'preferredVariantId' as never } }, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport(manifest, { '198-a': { defects: ['all_bad'] } }, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport({ ...manifest, groups: [{ id: 1, variants: [{ variantId: 'same' }, { variantId: 'same' }] }] }, {}, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport({ ...manifest, groups: [{ id: NaN, variants: [{ variantId: 'x' }] }] }, {}, '2026-10-27')).toThrow();
    expect(() => buildAbsoluteReviewExport({ ...manifest, groups: [{ id: 1, variants: [{ variantId: 'x' }] }, { id: 1, variants: [{ variantId: 'y' }] }] }, {}, '2026-10-27')).toThrow();
    const valid = buildAbsoluteReviewExport(manifest, {}, '2026-10-27T12:00:00.000Z');
    expect(validateAbsoluteReviewExport({ ...valid, manifestSha256: 'b'.repeat(64) }, manifest)).toBe(false);
    expect(validateAbsoluteReviewExport({ ...valid, variantVotes: [{ ...valid.variantVotes[0], variantId: 'unknown' }, valid.variantVotes[1]] }, manifest)).toBe(false);
    expect(validateAbsoluteReviewExport({ ...valid, votes: { '198': { preferredVariantId: 'tie' } } }, manifest)).toBe(false);
    expect(validateAbsoluteReviewExport(valid, { ...manifest, groups: [{ id: NaN, variants: [{ variantId: '198-a' }, { variantId: '198-b' }] }] })).toBe(false);
  });
});
