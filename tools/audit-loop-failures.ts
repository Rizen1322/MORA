/** Diagnose measured beat accents using the loop's real source map. No render or model. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { TrackAnalysis, TransitionPlan } from '../packages/core/src/types.ts';
import { integrateTempo, outputTimeAt, pointValue } from '../packages/core/src/plan/timing.ts';
const output = process.argv[2];
if (output && fs.existsSync(output)) throw Error('Immutable audit output already exists');
const sha = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
const data = path.join(process.env.LOCALAPPDATA!, 'MORA/data');
const db = new DatabaseSync(path.join(data, 'automix.sqlite'), { readOnly: true });
type Event = { out: number; source: number; kick: number; snare: number };
function events(p: TransitionPlan, an: TrackAnalysis, deck: 'A' | 'B', end: number): Event[] {
  const g = an.beat!, cue = deck === 'A' ? p.aExit : p.bEntry, tempo = deck === 'A' ? p.tempoA : p.tempoB;
  const sourceEnd = cue + integrateTempo(tempo, end), result: Event[] = [];
  const emit = (source: number, virtual: number, index: number) => {
    if (virtual < cue - .001 || virtual >= sourceEnd) return;
    result.push({ out: outputTimeAt(tempo, Math.max(0, virtual - cue), p.duration), source,
      kick: g.accents!.kick[index], snare: g.accents!.snare[index] });
  };
  g.beats.forEach((t, i) => {
    if (deck !== 'A' || !p.loopA || t < p.loopA.start) emit(t, t, i);
    else if (t >= p.loopA.start && t < p.loopA.end) {
      for (let virtual = t; virtual < Math.min(p.loopA.until, sourceEnd); virtual += p.loopA.end - p.loopA.start) emit(t, virtual, i);
    }
  });
  return result.sort((a, b) => a.out - b.out);
}
function agreement(a: Event[], b: Event[]) {
  const used = new Set<Event>();
  const pairs = a.flatMap(x => {
    const peer = b.reduce<Event | null>((best, y) => used.has(y) ? best : !best || Math.abs(x.out - y.out) < Math.abs(x.out - best.out) ? y : best, null);
    if (!peer || Math.abs(x.out - peer.out) >= .1) return [];
    used.add(peer); return [{ a: x, b: peer }];
  });
  const corr = (band: 'kick' | 'snare') => {
    if (pairs.length < 8) return null;
    const mx = pairs.reduce((s, p) => s + p.a[band], 0) / pairs.length, my = pairs.reduce((s, p) => s + p.b![band], 0) / pairs.length;
    const xx = pairs.reduce((s, p) => s + (p.a[band] - mx) ** 2, 0), yy = pairs.reduce((s, p) => s + (p.b![band] - my) ** 2, 0);
    return xx * yy > 0 ? pairs.reduce((s, p) => s + (p.a[band] - mx) * (p.b![band] - my), 0) / Math.sqrt(xx * yy) : null;
  };
  return { eventsA: a.length, eventsB: b.length, pairs: pairs.length, unmatchedA: a.length - pairs.length,
    meanBeatDistanceMs: pairs.length ? pairs.reduce((s, p) => s + Math.abs(p.a.out - p.b!.out), 0) / pairs.length * 1000 : null,
    kickCorrelation: corr('kick'), snareCorrelation: corr('snare') };
}
try {
  const results = [];
  for (const id of [185, 204, 205, 208, 212]) {
    const directory = path.resolve('data-bench-results', [204, 205].includes(id) ? 'review-stemless-loop-2026-10-28-v4' : 'review-similar-loops-2026-10-28');
    const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString());
    const group = manifest.groups.find((g: { id: number }) => g.id === id);
    const log = db.prepare('SELECT * FROM transition_log WHERE id=?').get(id) as { from_track: string; to_track: string; plan: string };
    const analysis = (track: string) => {
      const t = db.prepare('SELECT content_hash FROM tracks WHERE id=?').get(track) as { content_hash: string };
      const row = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' ORDER BY updated_at DESC LIMIT 1").get(t.content_hash) as { data: string };
      return { hash: sha(row.data), data: JSON.parse(row.data) as TrackAnalysis };
    };
    const A = analysis(log.from_track), B = analysis(log.to_track);
    const variants = group.variants.map((v: { planFile: string; planSha256: string; title: string; variantId: string }) => {
      const bytes = fs.readFileSync(path.join(directory, v.planFile));
      if (sha(bytes) !== v.planSha256) throw Error('Plan hash mismatch');
      return { ...v, plan: JSON.parse(bytes.toString()) as TransitionPlan };
    });
    const loopVariant = variants.find((v: { plan: TransitionPlan }) => v.plan.loopA), actual = JSON.parse(log.plan) as TransitionPlan;
    if (!loopVariant) throw Error(`Missing loop for ${id}`);
    const p = loopVariant.plan as TransitionPlan;
    const end = outputTimeAt(p.tempoA, p.loopA!.until - p.aExit, p.duration), start = outputTimeAt(p.tempoA, p.loopA!.start - p.aExit, p.duration);
    const a = events(p, A.data, 'A', end), originalA = events(actual, A.data, 'A', end), b = events(p, B.data, 'B', end);
    const after = (xs: Event[]) => xs.filter(x => x.out >= start);
    const knot = (t: number) => Object.fromEntries(['A', 'B'].map(deck => [deck, Object.fromEntries(['gain', 'low', 'mid', 'high'].map(lane => [lane,
      pointValue(p.automation.find(x => x.deck === deck && x.lane === lane)?.points ?? [[0, 1]], t)]))]));
    results.push({ id, sourceReviewId: manifest.reviewId, sourceManifestSha256: sha(manifestBytes), variantId: loopVariant.variantId,
      analysisHashes: { a: A.hash, b: B.hash }, loop: p.loopA, outputLoopStart: start, outputLoopStop: end,
      originalSameWindow: agreement(originalA, b), loopSameWindow: agreement(a, b),
      originalAfterLoopStart: agreement(after(originalA), after(b)), repeatedAfterLoopStart: agreement(after(a), after(b)),
      loopSourceAccents: a.filter(x => x.out >= start && x.source < p.loopA!.end).slice(0, Math.round((p.loopA!.end - p.loopA!.start) / A.data.beat!.period)),
      laneAtStart: knot(start), laneBeforeExit: knot(Math.max(start, end - A.data.beat!.period * 4)),
      voiceEvidence: { a: !!A.data.vocalActivity, b: !!B.data.vocalActivity, conclusion: 'unknown-without-listener-or-vocal-measurements' },
      structureA: A.data.structure?.segments.filter(s => s.end > p.loopA!.start && s.start < p.loopA!.until),
      structureB: B.data.structure?.segments.filter(s => s.end > p.bEntry && s.start < p.bEntry + integrateTempo(p.tempoB, end)) });
  }
  const report = { schema: 'mora-loop-source-rhythm-audit-1', createdAt: new Date().toISOString(), databaseReadOnly: true, rendered: false,
    limitations: ['per-beat measured accents are not drum transcription', 'correlation is not musical quality', 'does not identify voice', 'fixed100ms pairing is descriptive, not a selector'], results };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(results.map(({ id, originalAfterLoopStart, repeatedAfterLoopStart, voiceEvidence, laneBeforeExit }) => ({ id, originalAfterLoopStart, repeatedAfterLoopStart, voiceEvidence, laneBeforeExit })), null, 2));
} finally { db.close(); }
