/** Absolute per-variant listening set. Existing actual/relay audio is copied only after SHA verification.
 * node --import tsx tools/review-absolute.ts [--output NEW_DIR] [--ids 198,204,205,189] [--candidate complementary|closure-aligned]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, PLANNER_VERSION, DEFAULT_AUTOMIX_SETTINGS, type AutoMixSettings, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/index.ts';
import { finalistSpans, stepAsync, type PcmSpan } from '../packages/core/src/engine/render-check.ts';
import { renderTransitionSteps } from '../packages/core/src/engine/arm.ts';
import { complementaryHandoffAudition, closureAlignedHandoffAudition, measuredBarEntryAudition } from '../packages/core/src/plan/human-scenarios.ts';
import { outgoingAfterArrival } from '../packages/core/src/plan/fullmix.ts';
import { ABSOLUTE_DEFECTS } from './review-absolute-export.ts';
import { absoluteExportBrowserScript } from './review-absolute-browser.ts';
import { stemlessLoopAudition } from '../packages/core/src/plan/stemless-loop.ts';
import { planForSourceWindows } from './review-source-window.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = path.resolve(arg('--output') ?? 'data-bench-results/review-absolute-2026-10-27');
const ids = (arg('--ids') ?? '198,204,205,189').split(',').map(Number);
const candidateKind = arg('--candidate') ?? 'complementary';
if (!['complementary', 'closure-aligned', 'measured-bar-entry', 'stemless-loop'].includes(candidateKind)) throw Error('Unknown candidate family');
const stemlessLoop = candidateKind === 'stemless-loop';
const controlIds = (arg('--control-ids') ?? '').split(',').filter(Boolean).map(Number);
if (!controlIds.every(id => ids.includes(id))) throw Error('Control IDs must belong to this review');
const closureAligned = candidateKind === 'closure-aligned';
const measuredBar = candidateKind === 'measured-bar-entry';
if (!ids.every(Number.isSafeInteger) || new Set(ids).size !== ids.length) throw Error('Invalid or duplicate ids');
if (fs.existsSync(out)) throw Error('Choose a new output directory; existing reviews cannot be overwritten.');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const priorReviews = [
  { reviewId: 'review-outgoing-2026-10-27-v2', directory: path.resolve('data-bench-results/review-outgoing-2026-10-27-v2'), manifestSha256: '208d870d024403d5d1fdf9708d0c8d536ab91b4e7339b38361952f5f1482c620' },
  { reviewId: 'review-relay-2026-10-27', directory: path.resolve('data-bench-results/review-relay-2026-10-27'), manifestSha256: '1ef3b426d24a330f1649ebf6d66c0f2ab074583a9a5392197fe288cb2aab55b8' },
];
type OldVariant = { variantId: string; title: string; aliases: string[]; file: string; sha256: string; planFile: string; planSha256: string; transitionStart: number; duration: number; auditionOnly: boolean };
type OldGroup = { id: number; from?: string; to?: string; sourceHashes?: { a: string; b: string }; variants?: OldVariant[] };
function readManifest(review: typeof priorReviews[number]) {
  const bytes = fs.readFileSync(path.join(review.directory, 'manifest.json'));
  if (sha(bytes) !== review.manifestSha256) throw Error(`Immutable manifest hash mismatch: ${review.reviewId}`);
  const manifest = JSON.parse(bytes.toString('utf8')) as { reviewId: string; groups: OldGroup[] };
  if (manifest.reviewId !== review.reviewId) throw Error(`Unexpected reviewId: ${review.reviewId}`);
  return manifest;
}
function verifyAndRead(review: typeof priorReviews[number], variant: OldVariant) {
  for (const file of [variant.file, variant.planFile]) {
    if (path.basename(file) !== file) throw Error(`Unsafe immutable filename: ${file}`);
  }
  const audio = fs.readFileSync(path.join(review.directory, variant.file));
  const planBytes = fs.readFileSync(path.join(review.directory, variant.planFile));
  if (sha(audio) !== variant.sha256 || sha(planBytes) !== variant.planSha256) throw Error(`Immutable file hash mismatch: ${variant.variantId}`);
  const plan = JSON.parse(planBytes.toString('utf8')) as TransitionPlan;
  return { audio, planBytes, plan };
}
const [outgoingManifest, relayManifest] = priorReviews.map(readManifest);
const immutable: { id: number; actual: ReturnType<typeof verifyAndRead>; actualVariant: OldVariant; relay: ReturnType<typeof verifyAndRead>; relayVariant: OldVariant; sourceHashes: { a: string; b: string }; from: string; to: string }[] = [];
for (const id of ids) {
  const outgoing = outgoingManifest.groups.find(g => g.id === id), relay = relayManifest.groups.find(g => g.id === id);
  if (!outgoing?.variants || !relay?.variants) throw Error(`Missing immutable pair ${id}`);
  const actualVariant = outgoing.variants.filter(v => !v.auditionOnly && v.title === 'Записанный переход');
  const relayVariant = relay.variants.filter(v => v.title === 'Пробная последовательная передача');
  if (actualVariant.length !== 1 || relayVariant.length !== 1) throw Error(`Missing or duplicate actual/relay candidate for ${id}`);
  const actual = verifyAndRead(priorReviews[0], actualVariant[0]), relayAudio = verifyAndRead(priorReviews[1], relayVariant[0]);
  const relayActual = relay.variants.find(v => v.variantId === actualVariant[0].variantId);
  if (!relayActual || relayActual.sha256 !== actualVariant[0].sha256 || relayActual.planSha256 !== actualVariant[0].planSha256) throw Error(`Relay actual does not match outgoing source for ${id}`);
  if (actual.plan.method !== 'beatmatch_blend' || actual.plan.version !== 'am-planner-v15-human-1') throw Error(`Unexpected source plan version/method for ${id}`);
  if (relayAudio.plan.debug.humanScenario && (relayAudio.plan.debug.humanScenario as { kind?: string }).kind !== 'sequential-relay') throw Error(`Unexpected relay plan for ${id}`);
  if (!outgoing.sourceHashes || !relay.sourceHashes || JSON.stringify(outgoing.sourceHashes) !== JSON.stringify(relay.sourceHashes)) throw Error(`Immutable source identity mismatch for ${id}`);
  immutable.push({ id, actual, actualVariant: actualVariant[0], relay: relayAudio, relayVariant: relayVariant[0], sourceHashes: outgoing.sourceHashes, from: outgoing.from ?? `#${id}`, to: outgoing.to ?? '' });
}

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
  for (const kind of ['f32', 's16h'] as const) {
    const file = path.join(data, 'cache/pcm', `${t.content_hash}_${sampleRate}.${kind}`);
    if (fs.existsSync(file)) return { file, kind };
  }
  const linked = db.prepare('SELECT path FROM track_sources WHERE track_id=? AND path IS NOT NULL').all(t.id) as { path: string }[];
  for (const { path: file } of linked) if (!/^[a-z]+:\/\//i.test(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return { file, kind: 'encoded' };
  for (const provider of ['yandex', 'youtube', 'soundcloud']) {
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
  if (input.kind === 'encoded') bytes = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input.file,
    '-t', String(seconds), '-ac', '2', '-ar', String(sampleRate), '-vn', '-sn', '-dn', '-f', 'f32le', 'pipe:1'], { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  else {
    const width = input.kind === 'f32' ? 8 : 4, offset = Math.round(start * sampleRate) * width;
    bytes = Buffer.alloc(Math.max(0, Math.min(Math.ceil(seconds * sampleRate) * width, fs.statSync(input.file).size - offset)));
    const file = fs.openSync(input.file, 'r');
    try { bytes = bytes.subarray(0, fs.readSync(file, bytes, 0, bytes.length, offset)); } finally { fs.closeSync(file); }
  }
  const width = input.kind === 's16h' ? 4 : 8, n = Math.floor(bytes.length / width), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = width === 8 ? bytes.readFloatLE(i * 8) : bytes.readInt16LE(i * 4) / 16384; R[i] = width === 8 ? bytes.readFloatLE(i * 8 + 4) : bytes.readInt16LE(i * 4 + 2) / 16384; }
  return { pcm: { L, R, sampleRate }, start };
}
async function render(p: TransitionPlan, a: PcmSpan, b: PcmSpan) {
  const audio = await stepAsync(renderTransitionSteps(a.pcm, b.pcm, planForSourceWindows(p, a.start, b.start), pre, post));
  const allFinite = audio.L.every(Number.isFinite) && audio.R.every(Number.isFinite);
  if (audio.metrics.underruns || !allFinite) throw Error('Invalid complementary render: underrun/non-finite PCM');
  const bytes = Buffer.alloc(44 + audio.L.length * 8);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(audio.L.length * 8, 40);
  for (let i = 0; i < audio.L.length; i++) { bytes.writeFloatLE(audio.L[i], 44 + i * 8); bytes.writeFloatLE(audio.R[i], 48 + i * 8); }
  let peak = 0; for (let i = 0; i < audio.L.length; i++) peak = Math.max(peak, Math.abs(audio.L[i]), Math.abs(audio.R[i]));
  return { bytes, transitionStart: audio.transitionStartFrame / sampleRate, duration: audio.L.length / sampleRate,
    renderMetrics: { underruns: audio.metrics.underruns, finite: allFinite, frames: audio.L.length, sampleRate, peak } };
}

type Variant = { variantId: string; title: string; file: string; sha256: string; planFile: string; planSha256: string; transitionStart: number; duration: number; auditionOnly: boolean; displayOrder: number; sourceReviewId?: string; sourceManifestSha256?: string; sourceVariantId?: string; copiedVerifiedSha256?: string; renderMetrics: unknown | null; outgoingAfterArrival: unknown | null };
type Group = { id: number; from: string; to: string; sourceHashes: { a: string; b: string }; candidateUnavailable?: string; variants: Variant[] };
type PendingFile = { path: string; bytes: Buffer };
const groups: Group[] = [], files: PendingFile[] = [];
const getLog = db.prepare('SELECT from_track,to_track,plan FROM transition_log WHERE id=?');
const settingsRow = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
const settings: AutoMixSettings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(settingsRow ? JSON.parse(settingsRow.value).automix : {}) };
try {
  for (const old of immutable) {
    const log = getLog.get(old.id) as { from_track: string; to_track: string; plan: string } | undefined;
    if (!log || sha(log.plan) !== old.actualVariant.planSha256) throw Error(`Current transition log differs from immutable v15 plan for ${old.id}`);
    const A = track(log.from_track), B = track(log.to_track);
    if (!A || !B || A.content_hash !== old.sourceHashes.a || B.content_hash !== old.sourceHashes.b) throw Error(`Current track identity differs from source manifest for ${old.id}`);
    const a = measured(A), b = measured(B), ia = source(A), ib = source(B);
    if (!a || !b || !ia || !ib) throw Error(`New complementary render inputs unavailable for ${old.id}`);
    const candidate = controlIds.includes(old.id) ? null : stemlessLoop ? stemlessLoopAudition(old.actual.plan, a, settings)
      : measuredBar ? measuredBarEntryAudition(old.actual.plan, b, settings)
      : closureAligned ? closureAlignedHandoffAudition(old.actual.plan, a, b, settings) : complementaryHandoffAudition(old.actual.plan);
    if (closureAligned && !candidate) throw Error(`No measured closure-aligned candidate for ${old.id}; no review will be written.`);
    const candidateTitle = stemlessLoop ? 'Петля полного микса A с выходом на такте' : measuredBar ? 'Вход на измеренной сильной доле B' : closureAligned ? 'Передача у измеренного закрытия A' : 'Встречная передача громкости';
    const variants: Variant[] = [];
    const addCopied = (sourceReview: typeof priorReviews[number], oldVariant: OldVariant, readResult: ReturnType<typeof verifyAndRead>, title: string) => {
      const audioCopy = Buffer.from(readResult.audio), planCopy = Buffer.from(readResult.planBytes);
      files.push({ path: oldVariant.file, bytes: audioCopy }, { path: oldVariant.planFile, bytes: planCopy });
      variants.push({ variantId: oldVariant.variantId, title, file: oldVariant.file, sha256: oldVariant.sha256, planFile: oldVariant.planFile,
        planSha256: oldVariant.planSha256, transitionStart: oldVariant.transitionStart, duration: oldVariant.duration, auditionOnly: oldVariant.auditionOnly,
        displayOrder: 0, sourceReviewId: sourceReview.reviewId, sourceManifestSha256: sourceReview.manifestSha256,
        sourceVariantId: oldVariant.variantId, copiedVerifiedSha256: oldVariant.sha256, renderMetrics: null, outgoingAfterArrival: null });
    };
    addCopied(priorReviews[0], old.actualVariant, old.actual, 'Записанный переход v15');
    if (!closureAligned && !measuredBar && !stemlessLoop) addCopied(priorReviews[1], old.relayVariant, old.relay, 'Последовательная передача');
    let candidateUnavailable: string | undefined;
    if (candidate) {
      const spans = finalistSpans([candidate.plan]), sa = read(ia, spans.a), sb = read(ib, spans.b);
      const rendered = await render(candidate.plan, sa, sb), audioHash = sha(rendered.bytes);
      const planJson = JSON.stringify(candidate.plan, null, 2) + '\n', planHash = sha(planJson);
      const variantId = `${old.id}-${planHash.slice(0, 16)}`, file = `${variantId}.wav`, planFile = `${variantId}.plan.json`;
      const planBytes = Buffer.from(planJson);
      files.push({ path: file, bytes: rendered.bytes }, { path: planFile, bytes: planBytes });
      variants.push({ variantId, title: candidateTitle, file, sha256: audioHash, planFile, planSha256: planHash,
        transitionStart: rendered.transitionStart, duration: rendered.duration, auditionOnly: true, displayOrder: 0,
        renderMetrics: rendered.renderMetrics, outgoingAfterArrival: outgoingAfterArrival(candidate.plan, a, b) });
    } else candidateUnavailable = controlIds.includes(old.id) ? 'Неизменный положительный контроль' : 'Пробный вариант не проходит ограничения текущего плана';
    variants.sort((x, y) => x.sha256.localeCompare(y.sha256) || x.variantId.localeCompare(y.variantId));
    variants.forEach((variant, i) => { variant.displayOrder = i + 1; });
    groups.push({ id: old.id, from: old.from, to: old.to, sourceHashes: old.sourceHashes, ...(candidateUnavailable ? { candidateUnavailable } : {}), variants });
    console.log(JSON.stringify({ id: old.id, variants: variants.length, candidateKind, candidateAvailable: !!candidate, candidateUnderruns: candidate ? (variants.find(v => v.title === candidateTitle)!.renderMetrics as { underruns: number }).underruns : null }));
  }
  const manifest = { reviewId: path.basename(out), createdAt: new Date().toISOString(), plannerVersion: PLANNER_VERSION,
    databaseReadOnly: true, networkUsed: false, listeningPerformed: false, candidateKind, controlIds, orderPolicy: 'Ascending audio SHA-256 per pair; displayOrder persisted in manifest.',
    absoluteRatings: ['good', 'acceptable', 'bad', 'unrated'], defects: [...ABSOLUTE_DEFECTS], priorReviews: priorReviews.map(x => ({ reviewId: x.reviewId, manifestSha256: x.manifestSha256 })), groups };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n', manifestSha256 = sha(manifestJson);
  const escape = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const sections = groups.map(g => `<section><h2>#${g.id} ${escape(g.from)} → ${escape(g.to)}</h2>${g.variants.map(v => `<article><h3>Вариант ${v.displayOrder}</h3><audio controls preload="none" aria-label="Переход ${g.id}, вариант ${v.displayOrder}" src="${escape(v.file)}"></audio><small>Начало перехода: ${v.transitionStart.toFixed(1)} с · длительность ${v.duration.toFixed(1)} с</small><label class="rating">Оценка звучания <select data-variant="${escape(v.variantId)}" aria-label="Абсолютная оценка перехода ${g.id}, вариант ${v.displayOrder}"><option value="unrated">Не оценено</option><option value="good">Хорошо</option><option value="acceptable">Приемлемо</option><option value="bad">Плохо</option></select></label><fieldset><legend>Какие дефекты слышны? Можно выбрать несколько</legend>${[['two-voices','Два голоса одновременно'],['rhythm','Сбивается ритм'],['cut-a','Срезается фраза A'],['b-opening','Плохо слышно начало B'],['energy','Не подходит энергия'],['abrupt','Звучит резко']].map(([key,label]) => `<label class="check"><input type="checkbox" data-defect="${key}" data-for="${escape(v.variantId)}"> ${label}</label>`).join('')}</fieldset><label class="comment">Комментарий<textarea data-comment="${escape(v.variantId)}" aria-label="Комментарий к переходу ${g.id}, вариант ${v.displayOrder}" placeholder="Что именно слышно?"></textarea></label></article>`).join('')}${g.candidateUnavailable ? `<p role="status">${escape(g.candidateUnavailable)}</p>` : ''}<details><summary>Раскрыть происхождение вариантов</summary>${g.variants.map(v => `<p>Вариант ${v.displayOrder}: ${escape(v.title)} · SHA-256 ${escape(v.sha256)}</p>`).join('')}</details></section>`).join('');
  const config = JSON.stringify({ reviewId: manifest.reviewId, manifestSha256 }).replaceAll('<', '\\u003c');
  const exportUi = absoluteExportBrowserScript({ reviewId: manifest.reviewId, manifestSha256, groups });
  const description = stemlessLoop ? 'Петля полного микса A с выходом через фильтр на границе такта. Голос неизвестен и может повторяться; требуется прослушивание. B, его вход и темп сохранены; положительный контроль неизменен.' : measuredBar ? 'Проба входа B на измеренной сильной доле: исходные громкость, EQ и темп сохранены. Сетка может ошибаться; улучшение звучания ещё не подтверждено.' : closureAligned ? 'В наборе исходный записанный переход и пробная передача у измеренной границы структуры A. Граница структуры не гарантирует конец вокальной фразы.' : 'В наборе есть записанный переход, прежняя последовательная передача и новый встречный фейдер.';
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MORA — абсолютная оценка переходов</title><style>
    :root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#0c1210;color:#eef5ef}body{max-width:980px;margin:32px auto;padding:0 18px}h1{font-size:clamp(26px,4vw,36px);line-height:1.15}h2{font-size:20px}h3{font-size:18px;margin:.3em 0}p,small{color:#b6c9bb}.intro,.actions,section{border:1px solid #35513e;background:#131f18;border-radius:16px;padding:20px;margin:18px 0}.intro{background:linear-gradient(145deg,#192c20,#111a15)}article{border:1px solid #2c4434;border-radius:12px;padding:16px;margin:14px 0;background:#101913}audio{display:block;width:100%;margin:10px 0 4px}select,textarea,button{font:inherit;color:inherit;background:#21392b;border:1px solid #526e5b;border-radius:9px;padding:10px}.rating{display:flex;align-items:center;gap:12px;margin-top:16px}.rating select{min-width:170px}.comment{display:block;margin-top:14px}textarea{display:block;box-sizing:border-box;width:100%;min-height:74px;margin-top:6px}.check{display:inline-flex;align-items:center;gap:7px;margin:5px 18px 5px 0}fieldset{border:1px solid #344b3a;border-radius:9px;margin-top:14px}input[type=checkbox]{width:18px;height:18px;accent-color:#77d89a}button{background:#24623b;font-weight:650;cursor:pointer}button:hover{background:#2d7948}button:focus-visible,select:focus-visible,textarea:focus-visible,audio:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a1edb5;outline-offset:2px}.actions{position:sticky;bottom:8px;display:flex;gap:12px;align-items:center;box-shadow:0 8px 28px #0008}details{margin-top:14px}summary{cursor:pointer}.saved{color:#a8efbd} </style></head><body><h1>Оценка каждого перехода</h1><div class="intro"><p>Оцените каждый вариант независимо: хорошо, приемлемо или плохо. Можно отметить несколько слышимых проблем и оставить комментарий. Оценка «плохо» не требует выбора победителя.</p><p>Порядок вариантов зафиксирован по SHA-256 аудио. ${description} Названия скрыты до раскрытия происхождения. Прослушивание субъективно; технический расчёт не означает, что вариант звучит лучше.</p></div><div class="actions"><button id="export">Скачать оценки</button><span id="status" role="status" class="saved">Оценки хранятся в этом браузере</span></div>${sections}<script>
    const config=${config}, storage='mora-absolute:'+config.manifestSha256;let votes={};try{votes=JSON.parse(localStorage.getItem(storage)||'{}')}catch{}
    const persist=()=>{try{localStorage.setItem(storage,JSON.stringify(votes));document.getElementById('status').textContent='Оценки сохранены в этом браузере'}catch{document.getElementById('status').textContent='Не удалось сохранить локально — скачайте экспорт'}};
    document.querySelectorAll('select[data-variant]').forEach(el=>{const id=el.dataset.variant;el.value=votes[id]?.rating||'unrated';el.onchange=()=>{(votes[id]??={rating:'unrated',defects:[],comment:''}).rating=el.value;persist()}});
    document.querySelectorAll('input[data-defect]').forEach(el=>{const id=el.dataset.for;el.checked=(votes[id]?.defects||[]).includes(el.dataset.defect);el.onchange=()=>{const v=(votes[id]??={rating:'unrated',defects:[],comment:''});const s=new Set(v.defects||[]);el.checked?s.add(el.dataset.defect):s.delete(el.dataset.defect);v.defects=[...s];persist()}});
    document.querySelectorAll('textarea[data-comment]').forEach(el=>{const id=el.dataset.comment;el.value=votes[id]?.comment||'';el.oninput=()=>{(votes[id]??={rating:'unrated',defects:[],comment:''}).comment=el.value;persist()}});
    document.querySelectorAll('audio').forEach(el=>el.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==el)other.pause()})));
    ${exportUi}
  </script></body></html>`;
  fs.mkdirSync(out);
  for (const file of files) fs.writeFileSync(path.join(out, file.path), file.bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'manifest.json'), manifestJson, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'index.html'), html, { flag: 'wx' });
  console.log(JSON.stringify({ output: out, groups: groups.length, variants: groups.reduce((n,g)=>n+g.variants.length,0), manifestSha256, allFinite: groups.flatMap(g=>g.variants).filter(v=>v.renderMetrics).every(v=>(v.renderMetrics as {finite:boolean}).finite), totalUnderruns: groups.flatMap(g=>g.variants).reduce((n,v)=>n+((v.renderMetrics as {underruns:number}|null)?.underruns??0),0), verifiedCopied: groups.flatMap(g=>g.variants).filter(v=>v.copiedVerifiedSha256).length }));
} finally { db.close(); }
