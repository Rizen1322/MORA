// Local objective checks + audition files. Never uploads audio or edits the user's queue.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MixerCore, CHUNK_FRAMES, LoudnessMeter, renderTransitionOffline, type PlaybackSettings, type TransitionPlan } from '../packages/core/src/index.ts';

const root = 'http://localhost:4730';
const release = process.argv.find(a => a.startsWith('--release='))?.slice(10) ?? '0.3.2';
if (!/^[\w.-]+$/.test(release)) throw new Error('Invalid release label');
const out = path.resolve(`tools/.cache/automix-review-${release}`); fs.mkdirSync(out, { recursive: true });
async function json(url: string) { const r = await fetch(root + url); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json(); }
const library = await json('/api/library') as { tracks: { id: string; title: string; duration: number; analysis?: { bpm: number } }[] };
const tracks: typeof library.tracks = [];
for (const track of library.tracks) {
  if ((await json(`/api/tracks/${track.id}/stems`)).status === 'ready') tracks.push(track);
  if (tracks.length === 8) break;
}
async function pcm(id: string, start: number, seconds: number, voice = false) {
  const count = Math.ceil(seconds * 44100), L = new Float32Array(count), R = L.slice();
  for (let offset = 0; offset < count; offset += 1 << 19) {
    const frames = Math.min(1 << 19, count - offset);
    const response = await fetch(`${root}/api/tracks/${id}/${voice ? 'vocals/' : ''}pcm?sr=44100&start=${Math.round(start * 44100) + offset}&frames=${frames}&format=f32le`);
    if (!response.ok) throw new Error(`PCM HTTP ${response.status}`);
    if (response.headers.get('x-pcm-format') !== 'f32le') throw new Error('Expected float PCM');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== frames * 8) throw new Error(`Incomplete PCM: ${buffer.length} / ${frames * 8} bytes`);
    for (let i = 0; i < buffer.length / 8; i++) { L[offset + i] = buffer.readFloatLE(i * 8); R[offset + i] = buffer.readFloatLE(i * 8 + 4); }
  }
  return { L, R };
}
function wav(file: string, L: Float32Array, R: Float32Array, sr: number) {
  const b = Buffer.alloc(44 + L.length * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(L.length * 4, 40);
  for (let i = 0; i < L.length; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}
const results: unknown[] = [];
const plansFile = process.argv.find(a => a.startsWith('--plans='))?.slice(8);
const supplied = plansFile ? (JSON.parse(fs.readFileSync(plansFile, 'utf8')).candidates as { plan: TransitionPlan }[]).slice(0, 3) : null;
if (supplied && !supplied.length) throw new Error('No eligible loop plans to render');
const pairs = supplied ? supplied.map(({ plan }) => ({ a: library.tracks.find(t => t.id === plan.fromTrackId), b: library.tracks.find(t => t.id === plan.toTrackId), plan }))
  : [[0, 1], [4, 5], [6, 7]].map(([ai, bi]) => ({ a: tracks[ai], b: tracks[bi], plan: null as TransitionPlan | null }));
for (const [index, pair] of pairs.entries()) {
  const { a, b } = pair; if (!a || !b) throw new Error('Need prepared tracks');
  const plan = pair.plan ?? ((await json(`/api/automix/plan?from=${a.id}&to=${b.id}`)) as { plan: TransitionPlan }).plan;
  const pre = 4, post = Math.max(6, (plan.tempoB.at(-1)?.[0] ?? 0) - plan.duration + 1), aStart = Math.max(0, Math.floor(plan.aExit - pre)), bStart = Math.max(0, Math.floor(plan.bEntry - 1));
  const rateA = Math.max(1, ...(plan.tempoA ?? []).map(([, r]) => r)), rateB = Math.max(1, ...plan.tempoB.map(([, r]) => r));
  const aLength = Math.min(a.duration - aStart, plan.aExit - aStart + plan.duration * rateA + 2);
  const bLength = Math.min(b.duration - bStart, plan.bEntry - bStart + (plan.duration + post + plan.gap + 2) * rateB);
  const [ap, av, bp, bv] = await Promise.all([pcm(a.id, aStart, aLength), pcm(a.id, aStart, aLength, true), pcm(b.id, bStart, bLength), pcm(b.id, bStart, bLength, true)]);
  const localPlan = { ...plan, aExit: plan.aExit - aStart, bEntry: plan.bEntry - bStart,
    loopA: plan.loopA ? { ...plan.loopA, start: plan.loopA.start - aStart, end: plan.loopA.end - aStart, until: plan.loopA.until - aStart,
      roll:plan.loopA.roll?.map(x=>({...x,at:x.at-aStart})) } : undefined,
    tapeStopA:plan.tapeStopA?{...plan.tapeStopA,start:plan.tapeStopA.start-aStart,end:plan.tapeStopA.end-aStart}:undefined };
  for (const [label, settings] of [
    ['normal', { speed: 1, semitones: 0 }], ['faster', { speed: 1.2, semitones: 0 }], ['pitch-up', { speed: 1, semitones: 3 }],
  ] as [string, PlaybackSettings][]) {
    const t = performance.now();
    const rendered = renderTransitionOffline({ ...ap, sampleRate: 44100, vocals: av }, { ...bp, sampleRate: 44100, vocals: bv }, localPlan, pre, post, settings);
    const renderMs = performance.now() - t;
    const meter = new LoudnessMeter(44100); meter.push([rendered.L, rendered.R]); const truePeakDb = meter.result().truePeakDb;
    if (rendered.metrics.underruns || !rendered.L.every(Number.isFinite) || !rendered.R.every(Number.isFinite) || truePeakDb > -.94)
      throw new Error(`Render failed: ${JSON.stringify({ a: a.title, b: b.title, settings, metrics: rendered.metrics, truePeakDb, aLength, bLength, plan: localPlan })}`);
    const file = `${index + 1}-${label}.wav`; wav(path.join(out, file), rendered.L, rendered.R, 44100);
    const item = { a: a.title, b: b.title, bpmA: a.analysis?.bpm, bpmB: b.analysis?.bpm, method: plan.method, masterTempo: !!plan.beatAlign?.masterDeck, vocalPolicy: (plan.debug.stems as {policy?:string}|undefined)?.policy, loopBridge: !!plan.loopA, vocalMasks: !!(plan.vocalA || plan.vocalB), file, settings,
      filterSweep: plan.automation.some(l => l.lane === 'filter'), originalExit: plan.aExit, originalEntry: plan.bEntry, duration: rendered.L.length / 44100, renderMs: Math.round(renderMs), truePeakDb, ...rendered.metrics };
    results.push(item); console.log(JSON.stringify(item));
  }
}

// Deadline diagnostics after warming the JIT. Includes two simultaneously stretched decks.
const sr = 48000, source = Float32Array.from({ length: sr * 12 }, (_, i) => .2 * Math.sin(i * .063) + .1 * Math.sin(i * .16));
const mixer = new MixerCore(sr, () => {}); mixer.setPlayback({ speed: 1.2, semitones: 6 });
for (const [deck, token] of [[0, 'A'], [1, 'B']] as const) {
  mixer.load(deck, token, source.length, 0);
  for (let c = 0; c * CHUNK_FRAMES < source.length; c++) { const chunk = source.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES); mixer.feed(deck, token, c, chunk, chunk.slice()); }
}
mixer.start(0, 'A', 0); mixer.arm({ planId: 'bench', method: 'test', fromToken: 'A', toToken: 'B', triggerFrame: 0, entryFrame: 0, durationFrames: sr * 10, gapFrames: 0, swapFrame: sr * 5,
  tempoA: [[0, 1.03]], tempoB: [[0, .98]], loopA: { start: sr, end: sr * 3, until: sr * 9, fade: Math.round(sr * .006) }, lanes: [
    { deck: 'A', lane: 6, points: [[0, 0], [sr * 9, .8]] },
    { deck: 'B', lane: 6, points: [[0, -.6], [sr * 9, 0]] },
  ] });
const L = new Float32Array(128), R = L.slice(), timings: number[] = [];
for (let b = 0; b < 2500; b++) { const begin = performance.now(); mixer.process(L, R, 128); if (b > 300) timings.push(performance.now() - begin); }
timings.sort((a, b) => a - b);
const benchmark = { quantumMs: 128 / sr * 1000, medianMs: timings[Math.floor(timings.length * .5)], p95Ms: timings[Math.floor(timings.length * .95)], p99Ms: timings[Math.floor(timings.length * .99)], maxMs: timings.at(-1) };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, benchmark }, null, 2));
fs.writeFileSync(path.join(out, 'README.md'), '# Локальные примеры AutoMix\n\nДля каждой пары: normal — обычный режим, faster — 1,2× без смены тона, pitch-up — +3 полутона без смены длительности.\n\nФайлы проверены по PCM и пикам, не прослушаны агентом. Оцените остаточный вокал, бас, ударные и естественность перехода. Это ваши локальные треки; файлы никуда не отправлялись.\n\n' + results.map((r: any) => `- [${r.file}](${r.file}) — ${r.a} → ${r.b}; ${r.method}, true peak ${r.truePeakDb.toFixed(2)} дБ`).join('\n'));
console.log(JSON.stringify({ benchmark, directory: out }));
