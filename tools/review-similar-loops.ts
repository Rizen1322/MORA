/** Render a bounded, read-only extension trial. No automatic policy or library writes.
 * node --import tsx tools/review-similar-loops.ts --ids ID,ID,ID --audit FILE --output NEW_DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_AUTOMIX_SETTINGS, PLANNER_VERSION, type AutoMixSettings, type TransitionPlan } from '../packages/core/src/types.ts';
import { stemlessLoopAudition } from '../packages/core/src/plan/stemless-loop.ts';
import { finalistSpans } from '../packages/core/src/engine/render-check.ts';
import { sha256, readReviewAnalysis, findReviewSource, readReviewPcm, renderReviewWav, reviewListeningHtml,
  type ReviewTrack, type ReviewGroup, type ReviewVariant } from './review-shared.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw Error(`Missing ${name}`); return process.argv[i + 1]; };
const ids = arg('--ids').split(',').map(Number), out = path.resolve(arg('--output')), auditFile = path.resolve(arg('--audit'));
if (!ids.length || ids.length > 4 || !ids.every(Number.isSafeInteger) || new Set(ids).size !== ids.length) throw Error('Choose one to four unique log IDs');
if (fs.existsSync(out)) throw Error('Existing listening sets cannot be overwritten');
const auditBytes = fs.readFileSync(auditFile), audit = JSON.parse(auditBytes.toString('utf8'));
if (!Array.isArray(audit.selected) || ids.some(id => !audit.selected.some((x: { id: number }) => x.id === id))) throw Error('Every target must be selected in the audit');
const data = path.join(process.env.LOCALAPPDATA!, 'MORA/data');
const db = new DatabaseSync(path.join(data, 'automix.sqlite'), { readOnly: true });
type Log = { id: number; from_track: string; to_track: string; plan: string; rating: string | null };
const logAt = (id: number) => db.prepare('SELECT id,from_track,to_track,plan,rating FROM transition_log WHERE id=?').get(id) as Log | undefined;
const trackAt = (id: string) => { const t = db.prepare('SELECT id,content_hash,title,artist FROM tracks WHERE id=?').get(id) as ReviewTrack | undefined; if (!t) throw Error('Missing track'); return t; };
const pending: { file: string; bytes: Buffer }[] = [], groups: ReviewGroup[] = [];
try {
  const protectedLogs = db.prepare("SELECT id,from_track,to_track,plan FROM transition_log WHERE rating='good'").all() as Log[];
  const protectedHashes = protectedLogs.map(l => ({ id: l.id, planSha256: sha256(l.plan), from: l.from_track, to: l.to_track,
    sourceHashes: { a: trackAt(l.from_track).content_hash, b: trackAt(l.to_track).content_hash } }));
  const saved = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
  const settings: AutoMixSettings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(saved ? JSON.parse(saved.value).automix : {}), stemMixing: false };
  for (const id of ids) {
    const log = logAt(id); if (!log) throw Error(`Missing transition ${id}`);
    if (protectedLogs.some(g => g.from_track === log.from_track && g.to_track === log.to_track)) throw Error(`Refusing a new recipe for protected good pair ${id}`);
    if ([189, 204, 205].includes(id)) throw Error('Previously settled pairs are controls, not new experiments');
    const evidence = audit.selected.find((x: { id: number }) => x.id === id);
    const A = trackAt(log.from_track), B = trackAt(log.to_track), a = readReviewAnalysis(db, A), b = readReviewAnalysis(db, B);
    if (protectedHashes.some(g => g.sourceHashes.a === A.content_hash && g.sourceHashes.b === B.content_hash)) throw Error(`Protected good audio pair alias: ${id}`);
    assert.equal(sha256(log.plan), evidence.logPlanSha256, 'Recorded plan changed after audit');
    assert.deepEqual({ a: a.sha256, b: b.sha256 }, evidence.analysisSha256, 'Analysis changed after audit');
    assert.deepEqual({ a: A.content_hash, b: B.content_hash }, evidence.sourceHashes, 'Sources changed after audit');
    const original = JSON.parse(log.plan) as TransitionPlan, frozen = JSON.stringify(original);
    const trial = stemlessLoopAudition(original, a.analysis, settings);
    if (!trial) throw Error(`Audited candidate no longer eligible: ${id}`);
    assert.equal(JSON.stringify(original), frozen, 'Helper mutated original plan');
    for (const key of ['aExit', 'bEntry', 'duration', 'swapAt', 'tempoA', 'tempoB', 'bDelay', 'gap'] as const) assert.deepEqual(trial.plan[key], original[key], key);
    assert.deepEqual(trial.plan.automation.filter(l => l.deck === 'B'), original.automation.filter(l => l.deck === 'B'));
    const sourceA = findReviewSource(db, data, A), sourceB = findReviewSource(db, data, B), spans = finalistSpans([original, trial.plan]);
    const pcmA = readReviewPcm(sourceA, spans.a), pcmB = readReviewPcm(sourceB, spans.b), variants: ReviewVariant[] = [];
    for (const [plan, title, auditionOnly, planBytes] of [
      [original, 'Исходный план из истории (повторный рендер)', false, Buffer.from(log.plan)],
      [trial.plan, 'Петля A с выходом на такте', true, Buffer.from(JSON.stringify(trial.plan, null, 2) + '\n')],
    ] as const) {
      const rendered = await renderReviewWav(plan, pcmA, pcmB), planHash = sha256(planBytes), variantId = `${id}-${planHash.slice(0, 16)}`;
      const file = `${variantId}.wav`, planFile = `${variantId}.plan.json`;
      pending.push({ file, bytes: rendered.bytes }, { file: planFile, bytes: planBytes });
      variants.push({ variantId, title, file, sha256: sha256(rendered.bytes), planFile, planSha256: planHash,
        transitionStart: rendered.transitionStart, duration: rendered.duration, auditionOnly, displayOrder: 0, renderMetrics: rendered.renderMetrics });
    }
    variants.sort((x, y) => x.sha256.localeCompare(y.sha256)); variants.forEach((v, i) => { v.displayOrder = i + 1; });
    groups.push({ id, from: `${A.artist} — ${A.title}`, to: `${B.artist} — ${B.title}`, variants,
      originalRating: log.rating, originalPlanVersion: original.version, logPlanSha256: sha256(log.plan), sourceHashes: evidence.sourceHashes,
      analysisSha256: evidence.analysisSha256, analysisVersions: { a: a.version, b: b.version },
      sourceFiles: { a: sourceA, b: sourceB }, trialSource: 'unchanged-stemless-loop-helper' });
    console.log(JSON.stringify({ id, variants: variants.length, allFinite: true, underruns: 0 }));
  }

  // Preserve both the repeatedly good original and the accepted loop exactly.
  const priorDir = path.resolve('data-bench-results/review-stemless-loop-2026-10-28-v4');
  const priorBytes = fs.readFileSync(path.join(priorDir, 'manifest.json'));
  assert.equal(sha256(priorBytes), '3159b03c165613ba7b46e9e8bfc794c82dd41376aafe929ed77e9a6c0945845b');
  const prior = JSON.parse(priorBytes.toString('utf8'));
  for (const [id, variantId] of [[204, '204-2f4eaf19e8ae1db1'], [189, '189-18754715fd21a2b9']] as const) {
    const g = prior.groups.find((x: { id: number }) => x.id === id), v = g?.variants.find((x: ReviewVariant) => x.variantId === variantId);
    if (!g || !v) throw Error('Protected listening control is missing');
    const log = logAt(id); if (!log) throw Error('Missing control log');
    const A = trackAt(log.from_track), B = trackAt(log.to_track);
    assert.deepEqual(g.sourceHashes, { a: A.content_hash, b: B.content_hash });
    if (id === 204) {
      const rebuilt = stemlessLoopAudition(JSON.parse(log.plan), readReviewAnalysis(db, A).analysis, settings);
      if (!rebuilt) throw Error('Accepted loop recipe is no longer reproducible');
      assert.equal(sha256(JSON.stringify(rebuilt.plan, null, 2) + '\n'), v.planSha256, 'Accepted #204 recipe changed');
    }
    for (const [file, expected] of [[v.file, v.sha256], [v.planFile, v.planSha256]]) {
      if (path.basename(file) !== file) throw Error('Unsafe immutable control filename');
      const bytes = fs.readFileSync(path.join(priorDir, file)); assert.equal(sha256(bytes), expected); pending.push({ file, bytes });
    }
    groups.push({ ...g, protectedControl: true, variants: [{ ...v, displayOrder: 1, sourceReviewId: prior.reviewId,
      sourceManifestSha256: sha256(priorBytes), copiedVerifiedSha256: v.sha256 }] });
  }
  // Read-only plus content checks: no existing good log or source recipe changed.
  for (const item of protectedHashes) assert.equal(sha256(logAt(item.id)!.plan), item.planSha256);
  const manifest = { reviewId: path.basename(out), createdAt: new Date().toISOString(), plannerVersion: PLANNER_VERSION,
    databaseReadOnly: true, networkUsed: false, listeningPerformed: false, automaticEnabled: false, candidateKind: 'similar-stemless-loop',
    audit: { file: path.relative(process.cwd(), auditFile), sha256: sha256(auditBytes) }, settingsUsed: settings,
    implementationHashes: Object.fromEntries(['packages/core/src/plan/stemless-loop.ts', 'packages/core/src/plan/planner.ts', 'tools/review-source-window.ts']
      .map(file => [file, sha256(fs.readFileSync(file))])), accepted204RecipeReproduced: true,
    targetIds: ids, protectedControlIds: [204, 189], protectedGoodPlans: protectedHashes,
    orderPolicy: 'Ascending audio SHA-256 within each target pair; copied controls unchanged.', groups };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n', manifestSha256 = sha256(manifestJson);
  const html = reviewListeningHtml(manifest.reviewId, manifestSha256, groups,
    'Новые пары: исходный план и та же экспериментальная петля A. В конце — две неизменные контрольные записи: приемлемая петля #204 и хороший исходный #189; их можно не оценивать повторно. Оцените новые варианты независимо; голос в петле может остаться. Автоматический выбор не изменён.');
  fs.mkdirSync(out);
  for (const item of pending) fs.writeFileSync(path.join(out, item.file), item.bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'manifest.json'), manifestJson, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'index.html'), html, { flag: 'wx' });
  console.log(JSON.stringify({ output: out, targetPairs: ids.length, variants: groups.reduce((n, g) => n + g.variants.length, 0), manifestSha256 }));
} finally { db.close(); }
