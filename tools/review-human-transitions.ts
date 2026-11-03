/** New, immutable listening trial. Reads local audio/SQLite only; never overwrites an earlier trial.
 * node --import tsx tools/review-human-transitions.ts [--output <new directory>] [--ids 112,151,...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, planFinalists, PLANNER_VERSION, ratingFeatures, ratingStats,
  type AutoMixSettings, type PlannerTrack, type TrackAnalysis, type TransitionPlan, type TransitionRating, type TransitionRatingReason } from '../packages/core/src/index.ts';
import { chooseByRender, finalistSpans, renderMetrics, stepAsync, type PcmSpan } from '../packages/core/src/engine/render-check.ts';
import { renderTransitionSteps } from '../packages/core/src/engine/arm.ts';
import { humanTransitionScenarios } from '../packages/core/src/plan/human-scenarios.ts';
import { fullMixCost } from '../packages/core/src/plan/fullmix.ts';

const argument = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const out = path.resolve(argument('--output') ?? 'data-bench-results/review-human-2026-10-26');
if (fs.existsSync(out)) throw Error('Choose a NEW output directory. Existing listening trials must remain unchanged.');
const previous = path.resolve('data-bench-results/review-2026-10-26');
const feedback = JSON.parse(fs.readFileSync('docs/listener-comparison-feedback-2026-10-26.json', 'utf8')) as {
  pageSha256: string; rows: { id: number; from: string; to: string; preference: string; chosen: string | null; order: string[]; hashes: string[] }[];
};
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
if (sha(fs.readFileSync(path.join(previous, 'index.html'))) !== feedback.pageSha256) throw Error('Previous trial page changed; cannot decode listener choices reliably.');
const ids = argument('--ids')?.split(',').map(Number) ?? [112,151,153,162,167,122,124,125,141,150,139,179];
const data = path.join(process.env.LOCALAPPDATA!, 'MORA', 'data');
const ffmpeg = path.resolve('apps/desktop/vendor/ffmpeg/ffmpeg.exe');
const db = new DatabaseSync(path.join(data, 'automix.sqlite'), { readOnly: true });
const sampleRate = 48000, pre = 8, post = 8;
type Row = { id: string; content_hash: string; duration: number; album: string; artist: string; album_artist: string; track_no: number | null; disc_no: number | null; provider: string };
const track = (id: string) => db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as unknown as Row;
const measured = (t: Row): TrackAnalysis | null => {
  const row = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY version=? DESC,updated_at DESC LIMIT 1")
    .get(t.content_hash, ANALYZER_VERSION) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
};
const plannedTrack = (t: Row): PlannerTrack => ({ id: t.id, duration: t.duration, album: t.album, albumArtist: t.album_artist || t.artist,
  trackNo: t.track_no, discNo: t.disc_no, mixingAllowed: ['local','youtube','soundcloud','yandex'].includes(t.provider), analysis: measured(t) });
function source(t: Row): { file: string; kind: 'encoded' | 'f32' | 's16h' } | null {
  for (const kind of ['f32','s16h'] as const) {
    const file = path.join(data, 'cache/pcm', `${t.content_hash}_${sampleRate}.${kind}`);
    if (fs.existsSync(file)) return { file, kind };
  }
  const linked = db.prepare('SELECT path FROM track_sources WHERE track_id=? AND path IS NOT NULL').all(t.id) as { path: string }[];
  for (const { path: file } of linked) if (!/^[a-z]+:\/\//i.test(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return { file, kind: 'encoded' };
  for (const provider of ['yandex','youtube','soundcloud']) {
    const directory = path.join(data, 'remote', provider);
    const file = fs.existsSync(directory) && fs.readdirSync(directory).find(f => f.startsWith(t.content_hash + '.') && /\.(mp3|m4a|webm|opus|ogg|wav|flac)$/i.test(f));
    if (file) return { file: path.join(directory, file), kind: 'encoded' };
  }
  return null;
}
function read(input: NonNullable<ReturnType<typeof source>>, span: [number, number]): PcmSpan {
  const start = Math.max(0, Math.floor((span[0] - pre) * sampleRate) / sampleRate);
  const seconds = span[1] + post - start;
  let bytes: Buffer;
  if (input.kind === 'encoded') bytes = execFileSync(ffmpeg, ['-v','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(start),'-i',input.file,
    '-t',String(seconds),'-ac','2','-ar',String(sampleRate),'-vn','-sn','-dn','-f','f32le','pipe:1'], { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  else {
    const width = input.kind === 'f32' ? 8 : 4, offset = Math.round(start * sampleRate) * width;
    bytes = Buffer.alloc(Math.max(0, Math.min(Math.ceil(seconds * sampleRate) * width, fs.statSync(input.file).size - offset)));
    const file = fs.openSync(input.file, 'r');
    try { bytes = bytes.subarray(0, fs.readSync(file, bytes, 0, bytes.length, offset)); } finally { fs.closeSync(file); }
  }
  const width = input.kind === 's16h' ? 4 : 8, n = Math.floor(bytes.length / width), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = width === 8 ? bytes.readFloatLE(i * 8) : bytes.readInt16LE(i * 4) / 16384;
    R[i] = width === 8 ? bytes.readFloatLE(i * 8 + 4) : bytes.readInt16LE(i * 4 + 2) / 16384;
  }
  return { pcm: { L, R, sampleRate }, start };
}
async function render(p: TransitionPlan, a: PcmSpan, b: PcmSpan, file: string) {
  const audio = await stepAsync(renderTransitionSteps(a.pcm, b.pcm, { ...p, aExit: p.aExit - a.start, bEntry: p.bEntry - b.start }, pre, post));
  if (audio.metrics.underruns || !audio.L.every(Number.isFinite) || !audio.R.every(Number.isFinite)) throw Error('Invalid review render: underrun/non-finite PCM');
  const bytes = Buffer.alloc(44 + audio.L.length * 8);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < audio.L.length; i++) { bytes.writeFloatLE(audio.L[i], 44 + i * 8); bytes.writeFloatLE(audio.R[i], 48 + i * 8); }
  fs.writeFileSync(path.join(out, file), bytes);
  const planFile = file.replace('.wav', '.plan.json'), json = JSON.stringify(p, null, 2) + '\n';
  fs.writeFileSync(path.join(out, planFile), json);
  return { file, sha256: sha(bytes), planFile, planSha256: sha(json), transitionStart: audio.transitionStartFrame / sampleRate,
    duration: audio.L.length / sampleRate, nonFinite: 0, underruns: 0 };
}
const groups: Record<string, unknown>[] = [];
try {
  // Validate every old reference before creating a new trial; winning an A/B is not an absolute good rating.
  for (const row of feedback.rows.filter(r => ids.includes(r.id))) row.order.forEach((file, i) => {
    if (sha(fs.readFileSync(path.join(previous, file))) !== row.hashes[i]) throw Error(`Previous audio changed: ${file}`);
  });
  fs.mkdirSync(out, { recursive: true });
  const settingsRow = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
  const settings: AutoMixSettings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(settingsRow ? JSON.parse(settingsRow.value).automix : {}) };
  const logs = db.prepare("SELECT * FROM transition_log WHERE rating IN ('good','bad') ORDER BY id").all() as unknown as {
    id: number; from_track: string; to_track: string; plan: string; outcome: string; rating: TransitionRating; rating_reason: TransitionRatingReason | null;
  }[];
  const stats = ratingStats(logs.map(log => {
    const p = JSON.parse(log.plan) as TransitionPlan, outcome = JSON.parse(log.outcome);
    const tempoOf = (id: string) => { const a = measured(track(id)); return { beat: a?.beat ? { bpm: a.beat.bpm } : null }; };
    const snapshot = outcome.listenerFeatures;
    return { rating: log.rating, reason: log.rating_reason,
      features: snapshot?.version === 4 && Array.isArray(snapshot.features) ? snapshot.features
        : ratingFeatures(p, p.beatAlign ? null : tempoOf(log.from_track), p.beatAlign ? null : tempoOf(log.to_track), { outcome }) };
  }));
  for (const id of ids) {
    const human = feedback.rows.find(r => r.id === id), log = logs.find(r => r.id === id);
    if (!human || !log) continue;
    const A = track(log.from_track), B = track(log.to_track), a = plannedTrack(A), b = plannedTrack(B);
    const ia = source(A), ib = source(B);
    if (!a.analysis || !b.analysis || !ia || !ib) { groups.push({ id, unavailable: 'local audio/analysis missing' }); continue; }
    const previousFile = human.chosen ?? `${id}-B-upgrade.wav`;
    const old = JSON.parse(fs.readFileSync(path.join(previous, previousFile.replace('.wav', '.plan.json')), 'utf8')) as TransitionPlan;
    const finalists = planFinalists(a, b, settings, stats);
    const control = finalists.find(p => (p.debug.fullMix as {this?:string}|undefined)?.this === 'baseline') ?? finalists[0];
    const scenarios = humanTransitionScenarios(control, a.analysis, b.analysis, settings);
    const all = [old, ...finalists, ...scenarios.map(s => s.plan)];
    const span = finalistSpans(all), sa = read(ia, span.a), sb = read(ib, span.b);
    const selected = await chooseByRender(finalists, sa, sb);
    const options = [
      { key: 'reference', title: human.chosen ? 'Предпочтённый в прошлом сравнении' : 'Предыдущий вариант, который не понравился', plan: old, auditionOnly: false },
      { key: 'auto', title: 'Новый автоматический выбор', plan: selected, auditionOnly: false },
      ...scenarios.map(s => ({ key: s.name, title: ({ 'section-handoff': 'Передача у завершения фразы', 'natural-tail-start': 'Естественный хвост → начало', 'arrival-build': 'Подводка к приходу энергии (пробный)' } as Record<string,string>)[s.name], plan: s.plan, auditionOnly: !!s.auditionOnly })),
    ];
    // Keep independent strategies, but never ask the listener to choose between identical PCM.
    const variants: Record<string, unknown>[] = [];
    for (const option of options) {
      const audio = await render(option.plan, sa, sb, `${id}-${option.key}.wav`);
      const duplicate = variants.find(v => v.sha256 === audio.sha256);
      if (duplicate) { (duplicate.aliases as string[]).push(option.title); continue; }
      variants.push({ variantId: `${id}-${option.key}`, title: option.title, aliases: [], auditionOnly: option.auditionOnly, ...audio,
        planDuration: option.plan.duration, aExit: option.plan.aExit, bEntry: option.plan.bEntry, bDelay: option.plan.bDelay ?? 0,
        scenario: option.plan.debug.humanScenario ?? null, metrics: renderMetrics(option.plan, sa, sb), cost: fullMixCost(option.plan, a.analysis, b.analysis, settings) });
    }
    // Randomize only once, before the manifest is written. Never change an existing review.
    for (let i = variants.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [variants[i], variants[j]] = [variants[j], variants[i]]; }
    groups.push({ id, from: human.from, to: human.to, priorVerdict: human.preference, sourceHashes: { a: A.content_hash, b: B.content_hash }, variants });
    fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ plannerVersion: PLANNER_VERSION, completed: groups }, null, 2));
    console.log(JSON.stringify({ id, variants: variants.length, selected: (selected.debug.fullMix as {this?:string}|undefined)?.this }));
  }
  const manifest = { reviewId: path.basename(out), createdAt: new Date().toISOString(), plannerVersion: PLANNER_VERSION,
    databaseReadOnly: true, networkUsed: false, listeningPerformed: false, oldPageSha256: feedback.pageSha256, groups };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(out, 'manifest.json'), manifestJson);
  const escape = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const sections = groups.map(g => {
    if (!Array.isArray(g.variants)) return `<section><h2>#${g.id}</h2><p>Локальное аудио недоступно</p></section>`;
    const variants = g.variants as { variantId: string; file: string; title: string; aliases: string[]; transitionStart: number }[];
    return `<section><h2>#${g.id} ${escape(g.from)} → ${escape(g.to)}</h2><div class="players">${variants.map((v, i) => `<label>Вариант ${i + 1}<audio controls preload="none" src="${escape(v.file)}"></audio><small>Начало перехода: ${v.transitionStart.toFixed(1)} с</small></label>`).join('')}</div><label>Какой звучит лучше?<select data-id="${g.id}"><option value="">Выберите после прослушивания</option>${variants.map((v, i) => `<option value="${escape(v.variantId)}">Вариант ${i + 1}</option>`).join('')}<option value="tie">Примерно одинаково</option><option value="both_bad">Все неудачные</option></select></label><textarea data-note="${g.id}" placeholder="Что слышно — можно описать своими словами"></textarea><details><summary>Раскрыть способы</summary>${variants.map((v, i) => `<p>Вариант ${i + 1}: ${escape(v.title)}${v.aliases.length ? ' / ' + escape(v.aliases.join(' / ')) : ''}</p>`).join('')}</details></section>`;
  }).join('');
  const config = JSON.stringify({ reviewId: manifest.reviewId, manifestSha256: sha(manifestJson) }).replaceAll('<','\\u003c');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MORA — новые сценарии переходов</title><style>body{font:16px/1.5 system-ui;background:#101715;color:#eff6ef;max-width:1040px;margin:36px auto;padding:0 18px}h1{font-size:30px}h2{font-size:19px}p,small{color:#afc3b6}section{border:1px solid #365340;background:#15231b;border-radius:16px;padding:22px;margin:20px 0}.players{display:flex;flex-wrap:wrap;gap:18px}.players label{flex:1;min-width:240px}audio{display:block;width:100%;margin:12px 0}select,textarea,button{font:inherit;background:#21392b;border:1px solid #4b6755;color:inherit;border-radius:8px;padding:10px}select{margin:16px 0 0 12px}textarea{display:block;box-sizing:border-box;width:100%;min-height:65px;margin:16px 0}button,summary{cursor:pointer}</style><h1>Новые сценарии переходов</h1><p>Сначала оцените общее звучание. Здесь разные точки и способы передачи: не только другая кривая EQ. Предпочтённый старый вариант включён как ориентир, а не как заведомо хороший переход. Совпадающие аудиофайлы объединены.</p><p>Это новый неизменяемый набор. Предыдущая страница и ваши оценки сохранены. Выбор «все неудачные» допустим. Экспорт содержит идентификаторы вариантов и SHA-256 набора; порядок больше не нужно угадывать.</p><button id="export">Скачать оценки</button>${sections}<script>const config=${config};const storage='mora-review:'+config.manifestSha256;let votes={};try{votes=JSON.parse(localStorage.getItem(storage)||'{}')}catch{};document.querySelectorAll('select,textarea').forEach(el=>{const id=el.dataset.id||el.dataset.note;const key=el.dataset.id?'preferredVariantId':'note';el.value=votes[id]?.[key]||'';el.onchange=()=>{(votes[id]??={})[key]=el.value;try{localStorage.setItem(storage,JSON.stringify(votes))}catch{}}});document.querySelectorAll('audio').forEach(el=>el.onplay=()=>document.querySelectorAll('audio').forEach(other=>{if(other!==el)other.pause()}));document.getElementById('export').onclick=()=>{const data={version:2,...config,exportedAt:new Date().toISOString(),votes};const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='MORA-listening-notes-v2.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};</script></html>`);
  console.log(JSON.stringify({ output: out, groups: groups.length, manifestSha256: sha(manifestJson) }));
} finally { db.close(); }
