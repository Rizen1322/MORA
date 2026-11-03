/** Read-only feedback import. Never writes ratings to the application database.
 * node --import tsx tools/import-absolute-review.ts --input FILE --review DIR --output NEW_FILE
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateAbsoluteReviewExport } from './review-absolute-export.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw Error(`Missing ${name}`); return process.argv[i + 1]; };
const input = path.resolve(arg('--input')), review = path.resolve(arg('--review')), output = path.resolve(arg('--output'));
if (fs.existsSync(output)) throw Error('Feedback snapshots cannot be overwritten.');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const inputBytes = fs.readFileSync(input), manifestBytes = fs.readFileSync(path.join(review, 'manifest.json'));
const manifestSha256 = sha(manifestBytes);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const feedback: unknown = JSON.parse(inputBytes.toString('utf8'));
if (!validateAbsoluteReviewExport(feedback, { ...manifest, manifestSha256 })) throw Error('Feedback does not match the immutable review.');
const resolvedVotes = feedback.variantVotes.map(vote => {
  const group = manifest.groups.find((g: { id: number }) => g.id === vote.groupId);
  const variant = group.variants.find((v: { variantId: string }) => v.variantId === vote.variantId);
  for (const [file, expected] of [[variant.file, variant.sha256], [variant.planFile, variant.planSha256]]) {
    if (typeof file !== 'string' || path.basename(file) !== file || !/^[a-f0-9]{64}$/.test(expected)) throw Error('Unsafe review asset identity.');
    if (sha(fs.readFileSync(path.join(review, file))) !== expected) throw Error(`Review asset changed: ${file}`);
  }
  return { ...vote, title: variant.title, displayOrder: variant.displayOrder, from: group.from, to: group.to,
    audioSha256: variant.sha256, planSha256: variant.planSha256, auditionOnly: variant.auditionOnly };
});
const counts = { good: 0, acceptable: 0, bad: 0, unrated: 0 };
for (const vote of resolvedVotes) counts[vote.rating]++;
const snapshot = { schema: 'mora-verified-absolute-feedback-1', importedAt: new Date().toISOString(),
  inputSha256: sha(inputBytes), manifestSha256, databaseModified: false, assetHashesVerified: true,
  counts, feedback, resolvedVotes };
fs.writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, counts, votes: resolvedVotes.map(v => ({ group: v.groupId, title: v.title, rating: v.rating, defects: v.defects, comment: v.comment })) }, null, 2));
