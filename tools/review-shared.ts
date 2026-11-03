import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TrackAnalysis, TransitionPlan } from '../packages/core/src/types.ts';
import { ANALYZER_VERSION } from '../packages/core/src/types.ts';
import { stepAsync, type PcmSpan } from '../packages/core/src/engine/render-check.ts';
import { renderTransitionSteps } from '../packages/core/src/engine/arm.ts';
import { planForSourceWindows } from './review-source-window.ts';
import { absoluteExportBrowserScript } from './review-absolute-browser.ts';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const REVIEW_RATE = 48000;
export type ReviewTrack = { id: string; content_hash: string; title: string; artist: string };
export type ReviewSource = { file: string; kind: 'encoded' | 'f32' | 's16h' };
export type ReviewVariant = { variantId: string; title: string; file: string; sha256: string; planFile: string; planSha256: string;
  transitionStart: number; duration: number; auditionOnly: boolean; displayOrder: number; [key: string]: unknown };
export type ReviewGroup = { id: number; from: string; to: string; variants: ReviewVariant[]; [key: string]: unknown };

export function readReviewAnalysis(db: DatabaseSync, track: ReviewTrack) {
  const row = db.prepare("SELECT data,version FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY version=? DESC,updated_at DESC LIMIT 1")
    .get(track.content_hash, ANALYZER_VERSION) as { data: string; version: string } | undefined;
  if (!row) throw Error(`No local analysis for ${track.id}`);
  return { analysis: JSON.parse(row.data) as TrackAnalysis, sha256: sha256(row.data), version: row.version };
}

export function findReviewSource(db: DatabaseSync, data: string, track: ReviewTrack): ReviewSource {
  if (!/^[a-zA-Z0-9_-]+$/.test(track.content_hash)) throw Error('Invalid content hash');
  for (const kind of ['f32', 's16h'] as const) {
    const file = path.join(data, 'cache/pcm', `${track.content_hash}_${REVIEW_RATE}.${kind}`);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return { file, kind };
  }
  const rows = db.prepare('SELECT path FROM track_sources WHERE track_id=? AND path IS NOT NULL').all(track.id) as { path: string }[];
  for (const { path: file } of rows) if (!/^[a-z]+:\/\//i.test(file) && path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return { file, kind: 'encoded' };
  for (const provider of ['yandex', 'youtube', 'soundcloud']) {
    const directory = path.join(data, 'remote', provider);
    const name = fs.existsSync(directory) && fs.readdirSync(directory).find(f => f.startsWith(track.content_hash + '.') && /\.(mp3|m4a|webm|opus|ogg|wav|flac)$/i.test(f));
    if (name) return { file: path.join(directory, name), kind: 'encoded' };
  }
  throw Error(`No local audio for ${track.id}; downloading is disabled`);
}

export function readReviewPcm(input: ReviewSource, span: [number, number], pre = 8, post = 8): PcmSpan {
  if (![...span, pre, post].every(Number.isFinite) || span[0] < 0 || span[1] < span[0] || pre < 0 || post < 0) throw Error('Invalid source window');
  const sr = REVIEW_RATE, start = Math.max(0, Math.floor((span[0] - pre) * sr) / sr), seconds = span[1] + post - start;
  if (seconds > 300) throw Error('Review window exceeds bounded decode limit');
  let bytes: Buffer;
  if (input.kind === 'encoded') bytes = execFileSync(path.resolve('apps/desktop/vendor/ffmpeg/ffmpeg.exe'),
    ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input.file, '-t', String(seconds), '-ac', '2', '-ar', String(sr), '-vn', '-sn', '-dn', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  else {
    const width = input.kind === 'f32' ? 8 : 4, offset = Math.round(start * sr) * width;
    bytes = Buffer.alloc(Math.max(0, Math.min(Math.ceil(seconds * sr) * width, fs.statSync(input.file).size - offset)));
    const file = fs.openSync(input.file, 'r');
    try { bytes = bytes.subarray(0, fs.readSync(file, bytes, 0, bytes.length, offset)); } finally { fs.closeSync(file); }
  }
  const width = input.kind === 's16h' ? 4 : 8, frames = Math.floor(bytes.length / width);
  if (!frames) throw Error('Empty decoded PCM');
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = width === 8 ? bytes.readFloatLE(i * 8) : bytes.readInt16LE(i * 4) / 16384;
    R[i] = width === 8 ? bytes.readFloatLE(i * 8 + 4) : bytes.readInt16LE(i * 4 + 2) / 16384;
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw Error('Nonfinite source PCM');
  }
  return { pcm: { L, R, sampleRate: sr }, start };
}

export async function renderReviewWav(plan: TransitionPlan, a: PcmSpan, b: PcmSpan, pre = 8, post = 8) {
  const audio = await stepAsync(renderTransitionSteps(a.pcm, b.pcm, planForSourceWindows(plan, a.start, b.start), pre, post));
  if (audio.metrics.underruns || !audio.L.every(Number.isFinite) || !audio.R.every(Number.isFinite)) throw Error('Invalid review render');
  const bytes = Buffer.alloc(44 + audio.L.length * 8), sr = REVIEW_RATE;
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(sr, 24); bytes.writeUInt32LE(sr * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(audio.L.length * 8, 40);
  for (let i = 0; i < audio.L.length; i++) { bytes.writeFloatLE(audio.L[i], 44 + i * 8); bytes.writeFloatLE(audio.R[i], 48 + i * 8); }
  return { bytes, transitionStart: audio.transitionStartFrame / sr, duration: audio.L.length / sr,
    renderMetrics: { finite: true, underruns: audio.metrics.underruns, sampleRate: sr, frames: audio.L.length, peak: audio.metrics.peak } };
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function reviewListeningHtml(reviewId: string, manifestSha256: string, groups: ReviewGroup[], intro: string): string {
  const sections = groups.map(g => `<section><h2>#${g.id} ${escapeHtml(g.from)} → ${escapeHtml(g.to)}</h2>${g.variants.map(v => `<article><h3>Вариант ${v.displayOrder}</h3><audio controls preload="none" src="${escapeHtml(v.file)}" aria-label="Пара ${g.id}, вариант ${v.displayOrder}"></audio><small>Начало перехода: ${v.transitionStart.toFixed(1)} с</small><label>Оценка <select data-variant="${escapeHtml(v.variantId)}"><option value="unrated">Не оценено</option><option value="good">Хорошо</option><option value="acceptable">Приемлемо</option><option value="bad">Плохо</option></select></label><fieldset><legend>Слышимые проблемы — можно несколько</legend>${[['two-voices','Два голоса'],['rhythm','Сбивается ритм'],['cut-a','Срезается фраза A'],['b-opening','Плохо слышно начало B'],['energy','Не подходит энергия'],['abrupt','Резко']].map(([key,label]) => `<label><input type="checkbox" data-for="${escapeHtml(v.variantId)}" data-defect="${key}"> ${label}</label>`).join('')}</fieldset><label>Комментарий<textarea data-comment="${escapeHtml(v.variantId)}"></textarea></label></article>`).join('')}<details><summary>Происхождение вариантов</summary>${g.variants.map(v => `<p>Вариант ${v.displayOrder}: ${escapeHtml(v.title)}</p>`).join('')}</details></section>`).join('');
  const config = JSON.stringify({ reviewId, manifestSha256 }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MORA — похожие ситуации</title><style>:root{color-scheme:dark;font:16px/1.5 system-ui;background:#0d1510;color:#eef4ef}body{max-width:950px;margin:24px auto;padding:0 18px}section,article,.intro,.actions{border:1px solid #35533e;border-radius:14px;padding:18px;margin:18px 0;background:#132019}article{background:#0c1811}h2{font-size:21px}audio,textarea{display:block;width:100%;box-sizing:border-box;margin:10px 0}textarea{min-height:75px}button,select,textarea{font:inherit;background:#203d2b;color:inherit;border:1px solid #52715e;border-radius:8px;padding:9px}label{display:inline-block;margin:8px 12px 8px 0}fieldset{border:1px solid #35533e}.actions{position:sticky;bottom:8px;display:flex;align-items:center;gap:12px}small{color:#b2c7b7}button,summary{cursor:pointer}:focus-visible{outline:3px solid #a3eab7}</style></head><body><h1>Петли в похожих ситуациях</h1><div class="intro">${escapeHtml(intro)}</div><div class="actions"><button id="export">Скачать оценки</button><span id="status" role="status">Оценки сохраняются в браузере</span></div>${sections}<script>
const config=${config}, storage='mora-absolute:'+config.manifestSha256;let votes={};try{votes=JSON.parse(localStorage.getItem(storage)||'{}')}catch{}
const persist=()=>{try{localStorage.setItem(storage,JSON.stringify(votes));document.getElementById('status').textContent='Сохранено'}catch{document.getElementById('status').textContent='Скопируйте оценки текстом'}};
document.querySelectorAll('select[data-variant]').forEach(el=>{const id=el.dataset.variant;el.value=votes[id]?.rating||'unrated';el.onchange=()=>{(votes[id]??={}).rating=el.value;persist()}});
document.querySelectorAll('input[data-defect]').forEach(el=>{const id=el.dataset.for;el.checked=(votes[id]?.defects||[]).includes(el.dataset.defect);el.onchange=()=>{const v=(votes[id]??={}),d=new Set(v.defects||[]);el.checked?d.add(el.dataset.defect):d.delete(el.dataset.defect);v.defects=[...d];persist()}});
document.querySelectorAll('textarea[data-comment]').forEach(el=>{const id=el.dataset.comment;el.value=votes[id]?.comment||'';el.oninput=()=>{(votes[id]??={}).comment=el.value;persist()}});
document.querySelectorAll('audio').forEach(el=>el.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==el)other.pause()})));
${absoluteExportBrowserScript({ reviewId, manifestSha256, groups })}
</script></body></html>`;
}
