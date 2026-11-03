/** Produce an opt-in local catalog from verified, absolute good votes only.
 * node --import tsx tools/build-reviewed-transitions.ts --review DIR --feedback FILE --output NEW_FILE
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateAbsoluteReviewExport } from './review-absolute-export.ts';
import { sha256, readReviewAnalysis, type ReviewTrack } from './review-shared.ts';
import { getSettings } from '../apps/server/src/automix.ts';
import { reviewedPlanFits, reviewedPlanHash, reviewedSettings, type ReviewedTransitionEntry, type ReviewedTransitionFile } from '../apps/server/src/reviewed-transitions.ts';
import type { PlannerTrack, TransitionPlan } from '../packages/core/src/types.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw Error(`Missing ${name}`); return process.argv[i + 1]; };
const dir = path.resolve(arg('--review')), feedbackPath = path.resolve(arg('--feedback')), output = path.resolve(arg('--output'));
if (fs.existsSync(output)) throw Error('Existing catalogs are not overwritten');
const manifestBytes = fs.readFileSync(path.join(dir, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString('utf8'));
const manifestSha256 = sha256(manifestBytes), notesBytes = fs.readFileSync(feedbackPath), notes: unknown = JSON.parse(notesBytes.toString('utf8'));
if (!validateAbsoluteReviewExport(notes, { ...manifest, manifestSha256 })) throw Error('Feedback/manifest identity mismatch');
const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA!, 'MORA/data/automix.sqlite'), { readOnly: true });
try {
  const settings = getSettings(db as never).automix;
  assert.deepEqual(reviewedSettings(settings), reviewedSettings(manifest.settingsUsed), 'Listening settings changed; no catalog produced');
  const entries: ReviewedTransitionEntry[] = [], pairs = new Set<string>();
  for (const vote of notes.variantVotes.filter(v => v.rating === 'good')) {
    const group = manifest.groups.find((g: { id: number }) => g.id === vote.groupId), variant = group.variants.find((v: { variantId: string }) => v.variantId === vote.variantId);
    const assets = [variant.file, variant.planFile].map((name: string, i: number) => {
      if (path.basename(name) !== name) throw Error('Unsafe artifact filename');
      const bytes = fs.readFileSync(path.join(dir, name)); assert.equal(sha256(bytes), i === 0 ? variant.sha256 : variant.planSha256); return bytes;
    });
    const plan = JSON.parse(assets[1].toString('utf8')) as TransitionPlan;
    const a = db.prepare('SELECT * FROM tracks WHERE id=?').get(plan.fromTrackId) as unknown as ReviewTrack & { duration: number };
    const b = db.prepare('SELECT * FROM tracks WHERE id=?').get(plan.toTrackId) as unknown as ReviewTrack & { duration: number };
    if (!a || !b) throw Error('A reviewed source recording is missing');
    assert.deepEqual(group.sourceHashes, { a: a.content_hash, b: b.content_hash });
    const pa = { id: a.id, duration: a.duration, analysis: readReviewAnalysis(db, a).analysis, mixingAllowed: true } as PlannerTrack;
    const pb = { id: b.id, duration: b.duration, analysis: readReviewAnalysis(db, b).analysis, mixingAllowed: true } as PlannerTrack;
    if (!reviewedPlanFits(plan, pa, pb)) throw Error(`Reviewed plan no longer fits the exact recordings: ${vote.variantId}`);
    const pair = `${a.content_hash}>${b.content_hash}`;
    if (pairs.has(pair)) throw Error('Multiple good plans for a pair require an explicit choice');
    pairs.add(pair);
    entries.push({ id: vote.variantId, fromHash: a.content_hash, toHash: b.content_hash, settings: reviewedSettings(settings), plan,
      planSha256: reviewedPlanHash(plan), evidence: { reviewId: notes.reviewId, manifestSha256, variantId: vote.variantId, rating: 'good' } });
  }
  if (!entries.length) throw Error('No good votes to save');
  const catalog: ReviewedTransitionFile & { createdAt: string; feedbackSha256: string } = { schema: 'mora-reviewed-transitions-1',
    createdAt: new Date().toISOString(), feedbackSha256: sha256(notesBytes), entries };
  const bytes = JSON.stringify(catalog, null, 2) + '\n';
  fs.writeFileSync(output, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ output, sha256: sha256(bytes), entries: entries.map(e => ({ id: e.id, loop: !!e.plan.loopA })) }, null, 2));
} finally { db.close(); }
