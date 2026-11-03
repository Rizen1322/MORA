/** Read-only historical screening. No decoding, providers, models or replanning.
 * node --import tsx tools/audit-similar-loops.ts [--output NEW.json]
 * Omit output for a compact dry-run. Existing reports are never overwritten. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/types.ts';
import { stemlessLoopAudition } from '../packages/core/src/plan/stemless-loop.ts';
import { outgoingAfterArrival } from '../packages/core/src/plan/fullmix.ts';
import { integrateTempo } from '../packages/core/src/plan/timing.ts';

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const data = path.resolve(arg('--data') ?? path.join(process.env.LOCALAPPDATA!, 'MORA/data'));
const output = arg('--output');
if (output && fs.existsSync(output)) throw Error('Audit snapshots are immutable; choose a new filename');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const db = new DatabaseSync(path.join(data, 'automix.sqlite'), { readOnly: true });
type Row = { id: number; plan: string; rating: string | null; rating_reason: string | null; from_track: string; to_track: string; executed_at: number };
type Track = { id: string; title: string; artist: string; content_hash: string };
try {
  const rows = db.prepare('SELECT * FROM transition_log ORDER BY id').all() as unknown as Row[];
  const settingsRow = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(settingsRow ? JSON.parse(settingsRow.value).automix : {}), stemMixing: false };
  const tracks = new Map((db.prepare('SELECT id,title,artist,content_hash FROM tracks').all() as unknown as Track[]).map(t => [t.id, t]));
  const analyzed = new Map<string, { analysis: TrackAnalysis; sha256: string; version: string } | null>();
  const analysis = (hash: string) => {
    if (!analyzed.has(hash)) {
      const row = db.prepare("SELECT data,version FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY version=? DESC,updated_at DESC LIMIT 1").get(hash, ANALYZER_VERSION) as { data: string; version: string } | undefined;
      analyzed.set(hash, row ? { analysis: JSON.parse(row.data), sha256: sha(row.data), version: row.version } : null);
    }
    return analyzed.get(hash)!;
  };
  const sources = new Map<string, string | null>();
  const source = (t: Track) => {
    if (!sources.has(t.id)) {
      const candidates = ['f32', 's16h'].map(ext => path.join(data, 'cache/pcm', `${t.content_hash}_48000.${ext}`));
      const linked = db.prepare('SELECT path FROM track_sources WHERE track_id=? AND path IS NOT NULL').all(t.id) as { path: string }[];
      candidates.push(...linked.map(x => x.path).filter(p => !/^[a-z]+:\/\//i.test(p)));
      for (const provider of ['yandex', 'youtube', 'soundcloud']) {
        const dir = path.join(data, 'remote', provider);
        if (fs.existsSync(dir)) candidates.push(...fs.readdirSync(dir).filter(f => f.startsWith(t.content_hash + '.') && /\.(mp3|m4a|webm|opus|ogg|wav|flac)$/i.test(f)).map(f => path.join(dir, f)));
      }
      sources.set(t.id, candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null);
    }
    return sources.get(t.id)!;
  };
  const feedbackFiles = fs.readdirSync('docs').filter(f => f.includes('feedback') && f.endsWith('.json'));
  const feedback = feedbackFiles.map(file => { const raw = fs.readFileSync(path.join('docs', file)); return { file, sha256: sha(raw), data: JSON.parse(raw.toString()) }; });
  const protectedIds = new Set(rows.filter(r => r.rating === 'good').map(r => r.id));
  const documentedBad = new Set<number>();
  const reviewedIds = new Set<number>();
  for (const f of feedback) {
    for (const v of f.data.resolvedVotes ?? []) {
      reviewedIds.add(v.groupId);
      if (v.rating === 'good') protectedIds.add(v.groupId);
      if (v.rating === 'bad' && v.auditionOnly === false) documentedBad.add(v.groupId);
    }
    for (const v of f.data.variantVotes ?? []) reviewedIds.add(v.groupId);
    for (const r of f.data.rows ?? []) {
      reviewedIds.add(r.id);
      if (r.preference === 'bothBad' || r.preferredVariantId === 'all_bad') documentedBad.add(r.id);
    }
  }
  const key = (r: Row) => `${tracks.get(r.from_track)?.content_hash ?? r.from_track}>${tracks.get(r.to_track)?.content_hash ?? r.to_track}`;
  const protectedPairs = new Set(rows.filter(r => protectedIds.has(r.id)).map(key));
  const reviewedPairs = new Set(rows.filter(r => reviewedIds.has(r.id)).map(key));
  const exploredPairs = new Set(rows.filter(r => [204, 205].includes(r.id)).map(key));
  const screened = rows.map(row => {
    const a = tracks.get(row.from_track), b = tracks.get(row.to_track), aa = a ? analysis(a.content_hash) : null, bb = b ? analysis(b.content_hash) : null;
    const p = JSON.parse(row.plan) as TransitionPlan, reasons: string[] = [];
    const candidate = aa && bb ? stemlessLoopAudition(p, aa.analysis, settings) : null;
    const grid = aa?.analysis.beat;
    if (!a || !b) reasons.push('missing-track');
    if (!aa || !bb) reasons.push('missing-analysis');
    if (protectedPairs.has(key(row))) reasons.push('protected-good-directional-pair');
    if (reviewedPairs.has(key(row))) reasons.push('previously-reviewed-directional-pair-preserve-preferred-variants');
    if (exploredPairs.has(key(row))) reasons.push('already-reviewed-204-or-205-directional-pair');
    if (p.method !== 'beatmatch_blend' || !p.beatAlign) reasons.push('not-beatmatched-plan');
    if (p.loopA || p.tapeStopA || p.echo || p.voiceEcho || p.vocalA || p.vocalB || p.gap !== 0 || (p.bDelay ?? 0) !== 0) reasons.push('incompatible-source-effects-or-clock');
    if (!grid?.stable || !(grid.confidence >= .8) || !(grid.downbeatConfidence >= .75) || !(grid.jitterMs <= 20)) reasons.push('outgoing-grid-unreliable-or-missing');
    if (!candidate) reasons.push('unchanged-loop-helper-ineligible');
    const localA = a ? source(a) : null, localB = b ? source(b) : null;
    if (!localA || !localB) reasons.push('local-audio-unavailable');
    const residual = aa && bb ? outgoingAfterArrival(p, aa.analysis, bb.analysis) : null;
    const detail = candidate?.plan.debug.humanScenario as { exit: number; release: number; candidates: number; differenceDb: number; bars: number } | undefined;
    const replaced = candidate ? p.aExit + integrateTempo(p.tempoA, p.duration) - candidate.plan.loopA!.end : null;
    return { id: row.id, directionalPair: key(row), from: a ? `${a.artist} — ${a.title}` : row.from_track, to: b ? `${b.artist} — ${b.title}` : row.to_track,
      fromTrack: row.from_track, toTrack: row.to_track, originalVersion: p.version, originalPlanSha256: sha(row.plan), logPlanSha256: sha(row.plan),
      sourceHashes: { a: a?.content_hash ?? null, b: b?.content_hash ?? null }, analysisSha256: { a: aa?.sha256 ?? null, b: bb?.sha256 ?? null }, rating: row.rating,
      historicalBadEvidence: row.rating === 'bad' || documentedBad.has(row.id), ratingReason: row.rating_reason,
      protectedGood: protectedPairs.has(key(row)), previouslyReviewed: reviewedPairs.has(key(row)),
      protectedTrackIntersections: [...new Set(rows.filter(r => protectedIds.has(r.id) && [tracks.get(r.from_track)?.content_hash, tracks.get(r.to_track)?.content_hash]
        .some(hash => hash && (hash === a?.content_hash || hash === b?.content_hash))).map(r => r.id))],
      analysis: { a: aa ? { version: aa.version, sha256: aa.sha256 } : null, b: bb ? { version: bb.version, sha256: bb.sha256 } : null },
      localSources: { a: localA, b: localB },
      features: { duration: p.duration, swapAt: p.swapAt, tempoRatio: p.beatAlign?.ratio ?? null,
        grid: grid ? { stable: grid.stable, confidence: grid.confidence, downbeatConfidence: grid.downbeatConfidence, jitterMs: grid.jitterMs } : null,
        outgoingAfterArrival: residual, candidateWindows: detail?.candidates ?? 0, loop: candidate?.plan.loopA ?? null,
        release: detail?.release ?? null, exit: detail?.exit ?? null, envelopeDifferenceDb: detail?.differenceDb ?? null,
        replacedOriginalSourceSeconds: replaced, removedAfterExitOutputSeconds: detail ? p.duration - detail.exit : null,
        originalSegmentsAfterLoopEnd: candidate ? (aa?.analysis.structure?.segments ?? []).filter(segment => segment.end > candidate.plan.loopA!.end && segment.start < p.aExit + integrateTempo(p.tempoA, p.duration))
          .map(segment => ({ start: segment.start, end: segment.end, group: segment.group, endClosure: segment.endClosure, novelty: segment.novelty })) : [] },
      candidateAvailable: !!candidate, reasons, selected: false, selectionReason: '' };
  });
  // Unheard v15 pairs are comparable to the accepted v15-based #204 experiment.
  // Older reviewed upgrades must not be replaced by their rejected logged plans.
  // Tempo distance ranks research examples, not automatic musical acceptance.
  const anchorVersion = screened.find(x => x.id === 204)?.originalVersion;
  const eligible = screened.filter(x => !x.reasons.length).sort((a, b) => Number(b.originalVersion === anchorVersion) - Number(a.originalVersion === anchorVersion)
    || Math.abs(Math.log(a.features.tempoRatio ?? 1)) - Math.abs(Math.log(b.features.tempoRatio ?? 1))
    || (b.features.outgoingAfterArrival?.residualSeconds ?? 0) - (a.features.outgoingAfterArrival?.residualSeconds ?? 0) || b.id - a.id);
  const seenPairs = new Set<string>(), usedTracks = new Set<string>();
  for (const row of eligible) {
    if (seenPairs.has(row.directionalPair)) { row.reasons.push('duplicate-directional-pair'); continue; }
    seenPairs.add(row.directionalPair);
    if (screened.filter(x => x.selected).length >= 3) { row.selectionReason = 'eligible-reserve'; continue; }
    if (usedTracks.has(row.sourceHashes.a!) || usedTracks.has(row.sourceHashes.b!)) { row.selectionReason = 'reserve-shares-content-with-selected-pair'; continue; }
    row.selected = true; row.selectionReason = 'unheard directional content-hash pair; unchanged-loop-eligible; local audio; same v15 baseline family as accepted204; modest tempo adjustment; persistent outgoing material; disjoint source contents';
    usedTracks.add(row.sourceHashes.a!); usedTracks.add(row.sourceHashes.b!);
  }
  const report = { schema: 'mora-loop-similarity-audit-1', generatedAt: new Date().toISOString(), databaseReadOnly: true,
    database: path.join(data, 'automix.sqlite'), audioDecoded: false, networkUsed: false, modelsUsed: false, automaticBehaviorChanged: false,
    policy: 'Existing stemlessLoopAudition unchanged. All history screened; content-hash directional pair dedup; any good or previously reviewed pair excluded to preserve preferred variants. Prefer unheard same-baseline-version pairs as204, then smaller absolute log tempo ratio, outgoing residual and recency. Select three disjoint source-content pairs. This is research sampling, not an automatic eligibility threshold. Envelope error is descriptive only, never vocal detection or quality.',
    feedbackSources: feedback.map(({ file, sha256 }) => ({ file, sha256 })), protectedGoodIds: [...protectedIds].sort((a, b) => a - b),
    protectedGood: screened.filter(x => protectedIds.has(x.id)).map(x => ({ id: x.id, directionalPair: x.directionalPair, sourceHashes: x.sourceHashes, from: x.from, to: x.to })),
    reviewedIds: [...reviewedIds].sort((a, b) => a - b), settings, total: rows.length, eligibleBeforeDedup: eligible.length,
    selectedIds: screened.filter(x => x.selected).map(x => x.id), selected: screened.filter(x => x.selected), screened };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ total: report.total, protectedGoodIds: report.protectedGoodIds, eligible: eligible.length,
    selected: screened.filter(x => x.selected), reserves: eligible.filter(x => !x.selected).map(x => ({ id: x.id, from: x.from, to: x.to, version: x.originalVersion, rating: x.rating, reason: x.selectionReason, exclusions: x.reasons, residual: x.features.outgoingAfterArrival })) }, null, 2));
} finally { db.close(); }
