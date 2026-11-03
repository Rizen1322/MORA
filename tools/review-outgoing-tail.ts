/** Immutable independent listening set. Reads local SQLite and local audio only.
 * node --import tsx tools/review-outgoing-tail.ts [--output NEW_DIR] [--ids 198,204,205,189]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, PLANNER_VERSION, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/index.ts';
import { finalistSpans, stepAsync, type PcmSpan } from '../packages/core/src/engine/render-check.ts';
import { renderTransitionSteps } from '../packages/core/src/engine/arm.ts';
import { cleanOutAudition } from '../packages/core/src/plan/human-scenarios.ts';
import { outgoingAfterArrival } from '../packages/core/src/plan/fullmix.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = path.resolve(arg('--output') ?? 'data-bench-results/review-outgoing-2026-10-27');
const ids = (arg('--ids') ?? '198,204,205,189').split(',').map(Number);
if (!ids.every(Number.isSafeInteger) || new Set(ids).size !== ids.length) throw Error('Invalid or duplicate ids');
if (fs.existsSync(out)) throw Error('Choose a new output directory; existing reviews cannot be overwritten.');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const data = path.join(process.env.LOCALAPPDATA!, 'MORA', 'data');
const ffmpeg = path.resolve('apps/desktop/vendor/ffmpeg/ffmpeg.exe');
const db = new DatabaseSync(path.join(data, 'automix.sqlite'), { readOnly: true });
const sampleRate = 48000, pre = 8, post = 8;
type Row = { id: string; title: string; artist: string; content_hash: string; duration: number };
const track = (id: string) => db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as unknown as Row | undefined;
const measured = (t: Row): TrackAnalysis | null => {
  const row = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY version=? DESC,updated_at DESC LIMIT 1")
    .get(t.content_hash, ANALYZER_VERSION) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
};
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
async function render(p: TransitionPlan, a: PcmSpan, b: PcmSpan) {
  const audio = await stepAsync(renderTransitionSteps(a.pcm, b.pcm, { ...p, aExit: p.aExit - a.start, bEntry: p.bEntry - b.start }, pre, post));
  if (audio.metrics.underruns || !audio.L.every(Number.isFinite) || !audio.R.every(Number.isFinite)) throw Error('Invalid review render: underrun/non-finite PCM');
  const bytes = Buffer.alloc(44 + audio.L.length * 8);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < audio.L.length; i++) { bytes.writeFloatLE(audio.L[i], 44 + i * 8); bytes.writeFloatLE(audio.R[i], 48 + i * 8); }
  return { bytes, transitionStart: audio.transitionStartFrame / sampleRate, duration: audio.L.length / sampleRate };
}

type Variant = { variantId: string; title: string; aliases: string[]; file: string; sha256: string; planFile: string; planSha256: string; transitionStart: number; duration: number; auditionOnly: boolean; outgoingAfterArrival: ReturnType<typeof outgoingAfterArrival> };
type Group = { id: number; from?: string; to?: string; unavailable?: string; rating?: string | null; ratingReason?: string | null; outcome?: unknown; sourceHashes?: { a: string; b: string }; variants?: Variant[]; candidateUnavailable?: string };
const groups: Group[] = [];
try {
  fs.mkdirSync(out); // atomic refusal to overwrite, including concurrently-created directories
  const getLog = db.prepare('SELECT * FROM transition_log WHERE id=?');
  for (const id of ids) {
    const log = getLog.get(id) as { from_track: string; to_track: string; plan: string; outcome: string; rating: string | null; rating_reason: string | null } | undefined;
    if (!log) { groups.push({ id, unavailable: 'Запись перехода не найдена' }); continue; }
    const A = track(log.from_track), B = track(log.to_track);
    if (!A || !B) { groups.push({ id, unavailable: 'Запись трека не найдена', rating: log.rating, ratingReason: log.rating_reason }); continue; }
    const group: Group = { id, from: `${A.artist} — ${A.title}`, to: `${B.artist} — ${B.title}`, rating: log.rating,
      ratingReason: log.rating_reason, outcome: JSON.parse(log.outcome), sourceHashes: { a: A.content_hash, b: B.content_hash } };
    groups.push(group);
    const a = measured(A), b = measured(B), ia = source(A), ib = source(B);
    if (!ia || !ib || !a || !b) { group.unavailable = [!ia && 'аудио A', !ib && 'аудио B', !a && 'анализ A', !b && 'анализ B'].filter(Boolean).join(', ') + ' недоступно локально'; continue; }
    try {
      const actual = JSON.parse(log.plan) as TransitionPlan;
      const candidate = cleanOutAudition(actual, a);
      if (!candidate) group.candidateUnavailable = 'Пробный выход A неприменим к этому плану';
      const options = [{ title: 'Записанный переход', plan: actual, json: log.plan, auditionOnly: false },
        ...(candidate ? [{ title: 'Пробный выход A после прихода B', plan: candidate.plan, json: JSON.stringify(candidate.plan, null, 2) + '\n', auditionOnly: true }] : [])];
      const spans = finalistSpans(options.map(x => x.plan)), sa = read(ia, spans.a), sb = read(ib, spans.b);
      const variants: Variant[] = [];
      for (const option of options) {
        const rendered = await render(option.plan, sa, sb), audioHash = sha(rendered.bytes), planHash = sha(option.json);
        const duplicate = variants.find(v => v.sha256 === audioHash);
        if (duplicate) { duplicate.aliases.push(option.title); continue; }
        const variantId = `${id}-${planHash.slice(0, 16)}`;
        const file = `${variantId}.wav`, planFile = `${variantId}.plan.json`;
        fs.writeFileSync(path.join(out, file), rendered.bytes, { flag: 'wx' });
        fs.writeFileSync(path.join(out, planFile), option.json, { flag: 'wx' });
        variants.push({ variantId, title: option.title, aliases: [], file, sha256: audioHash, planFile, planSha256: planHash,
          transitionStart: rendered.transitionStart, duration: rendered.duration, auditionOnly: option.auditionOnly,
          outgoingAfterArrival: outgoingAfterArrival(option.plan, a, b) });
      }
      for (let i = variants.length - 1; i > 0; i--) { const j = randomInt(i + 1); [variants[i], variants[j]] = [variants[j], variants[i]]; }
      group.variants = variants;
      console.log(JSON.stringify({ id, variants: variants.length, candidate: !!candidate }));
    } catch (error) { group.unavailable = `Не удалось подготовить аудио: ${(error as Error).message}`; }
  }
  const manifest = { reviewId: path.basename(out), createdAt: new Date().toISOString(), plannerVersion: PLANNER_VERSION,
    databaseReadOnly: true, networkUsed: false, listeningPerformed: false, groups };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(out, 'manifest.json'), manifestJson, { flag: 'wx' });
  const escape = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const sections = groups.map(g => {
    if (!g.variants?.length) return `<section><h2>#${g.id} ${escape(g.from)} → ${escape(g.to)}</h2><p>${escape(g.unavailable)}</p></section>`;
    return `<section><h2>#${g.id} ${escape(g.from)} → ${escape(g.to)}</h2><div class="players">${g.variants.map((v, i) => `<label>Вариант ${i + 1}<audio controls preload="none" src="${escape(v.file)}"></audio><small>Начало перехода: ${v.transitionStart.toFixed(1)} с</small></label>`).join('')}</div><label>Какой звучит лучше? <select data-id="${g.id}"><option value="">Выберите после прослушивания</option>${g.variants.map((v, i) => `<option value="${escape(v.variantId)}">Вариант ${i + 1}</option>`).join('')}<option value="tie">Примерно одинаково</option><option value="all_bad">Все неудачные</option></select></label><textarea data-note="${g.id}" placeholder="Что слышно?"></textarea><details><summary>Раскрыть варианты</summary>${g.variants.map((v, i) => `<p>Вариант ${i + 1}: ${escape(v.title)}${v.aliases.length ? ' / ' + escape(v.aliases.join(' / ')) : ''}</p>`).join('')}${g.candidateUnavailable ? `<p>${escape(g.candidateUnavailable)}</p>` : ''}</details></section>`;
  }).join('');
  const config = JSON.stringify({ reviewId: manifest.reviewId, manifestSha256: sha(manifestJson) }).replaceAll('<', '\\u003c');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MORA — выход A</title><style>body{font:16px/1.5 system-ui;background:#101715;color:#eff6ef;max-width:1040px;margin:36px auto;padding:0 18px}h2{font-size:19px}p,small{color:#afc3b6}section{border:1px solid #365340;background:#15231b;border-radius:16px;padding:22px;margin:20px 0}.players{display:flex;flex-wrap:wrap;gap:18px}.players label{flex:1;min-width:240px}audio{display:block;width:100%;margin:12px 0}select,textarea,button{font:inherit;background:#21392b;border:1px solid #4b6755;color:inherit;border-radius:8px;padding:10px}textarea{display:block;box-sizing:border-box;width:100%;min-height:65px;margin:16px 0}button,summary{cursor:pointer}</style><h1>Выход первого трека</h1><p>Сравните записанный переход и пробный вариант. Можно выбрать «Все неудачные» и описать услышанное. Совпадающее аудио объединено.</p><button id="export">Скачать оценки</button>${sections}<script>const config=${config};const storage='mora-outgoing:'+config.manifestSha256;let votes={};try{votes=JSON.parse(localStorage.getItem(storage)||'{}')}catch{};document.querySelectorAll('select,textarea').forEach(el=>{const id=el.dataset.id||el.dataset.note;const key=el.dataset.id?'preferredVariantId':'note';el.value=votes[id]?.[key]||'';el.oninput=()=>{(votes[id]??={})[key]=el.value;try{localStorage.setItem(storage,JSON.stringify(votes))}catch{}}});document.querySelectorAll('audio').forEach(el=>el.onplay=()=>document.querySelectorAll('audio').forEach(other=>{if(other!==el)other.pause()}));document.getElementById('export').onclick=()=>{const data={version:1,...config,exportedAt:new Date().toISOString(),votes};const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='MORA-outgoing-notes.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};</script></html>`, { flag: 'wx' });
  console.log(JSON.stringify({ output: out, groups: groups.length, manifestSha256: sha(manifestJson) }));
} finally { db.close(); }
