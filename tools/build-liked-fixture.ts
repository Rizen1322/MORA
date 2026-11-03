// Builds packages/core/test/fixtures/liked-transitions.json: the real analyses of every
// positively rated pair whose two analyses are in a library, and the plans the planner makes
// for them now. The test fails when any of those plans changes. No audio is copied.
// Usage: npx tsx tools/build-liked-fixture.ts --app=<copy of automix.sqlite> [--dev=<copy>]
// Pass COPIES of the libraries: they are opened read-only, but the live files must not be touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { planFinalists, planTransition } from '../packages/core/src/plan/planner.ts';
import { ratingFeatures, ratingStats } from '../packages/core/src/plan/feedback.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type AutoMixSettings, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (k: string) => process.argv.find(v => v.startsWith(`--${k}=`))?.slice(k.length + 3);
const appPath = arg('app'), devPath = arg('dev');
if (!appPath) throw new Error('--app=<copy of automix.sqlite> is required');
const open = (p: string) => new DatabaseSync(path.resolve(p), { readOnly: true });
const app = open(appPath), dev = devPath ? open(devPath) : null;

// Positive votes from docs/*feedback*.json on the planner's own transition (not audition-only variants).
const docPairs: [string, string, string][] = [
  ['docs-189', 'ROCKET — Один', 'Пошлая Молли — ПОРНХАБ КРИСМАС КЛАБ'],
  ['docs-127', 'SODA LUV — Бехелит', 'ЕГОР КРИД, OG Buda, Toxi$, Мэйби Бэйби — Malo 2.0'],
  ['docs-212', 'GONE.Fludd — Плохая Сука', 'FRIENDLY THUG 52 NGG — Lost Angeles'],
  ['app14-255', '$undown — Stray (Slowed)', 'PHARAOH — В Прошлых Жизнях'],
];
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
type Row = { id: string; artist: string; title: string; duration: number; content_hash: string };
type Lib = { db: DatabaseSync; name: string };
const analysisOf = (lib: Lib, hash: string): TrackAnalysis | null => {
  const r = lib.db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(hash) as { data: string } | undefined;
  return r ? JSON.parse(r.data) as TrackAnalysis : null;
};
const settingsOf = (db: DatabaseSync): AutoMixSettings => {
  const r = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
  return { ...DEFAULT_AUTOMIX_SETTINGS, ...(r ? JSON.parse(r.value).automix : {}) };
};
// Same evidence as AutoMixService.ratingStats (apps/server/src/automix.ts), frozen at build time.
const feedbackOf = (db: DatabaseSync) => {
  const rows = db.prepare('SELECT plan, outcome, rating, rating_reason FROM transition_log WHERE rating IS NOT NULL ORDER BY id').all() as { plan: string; outcome: string; rating: 'good' | 'bad'; rating_reason: string | null }[];
  return ratingStats(rows.flatMap(r => {
    const plan = JSON.parse(r.plan) as TransitionPlan, outcome = JSON.parse(r.outcome || '{}');
    const snap = outcome.listenerFeatures as { version?: number; features?: string[] } | undefined;
    const features = snap?.version === 4 && Array.isArray(snap.features) ? snap.features : ratingFeatures(plan, null, null, { outcome });
    return r.rating === 'good' || r.rating === 'bad' ? [{ rating: r.rating, reason: r.rating_reason as never, features }] : [];
  }));
};

const libs: Lib[] = [{ db: app, name: 'app' }, ...(dev ? [{ db: dev, name: 'dev' }] : [])];
const pairs: { id: string; lib: Lib; a: Row; b: Row }[] = [];
for (const lib of libs) {
  const rated = lib.db.prepare(`SELECT l.id, l.from_track fa, l.to_track tb FROM transition_log l WHERE l.rating='good' ORDER BY l.id`).all() as { id: number; fa: string; tb: string }[];
  const track = lib.db.prepare('SELECT id, artist, title, duration, content_hash FROM tracks WHERE id=?');
  for (const r of rated) {
    const a = track.get(r.fa) as Row | undefined, b = track.get(r.tb) as Row | undefined;
    if (a && b) pairs.push({ id: `${lib.name}-${r.id}`, lib, a, b });
  }
}
const all = app.prepare('SELECT id, artist, title, duration, content_hash FROM tracks').all() as Row[];
const byTitle = (t: string) => all.find(r => norm(`${r.artist} ${r.title}`) === norm(t));
for (const [id, fa, fb] of docPairs) {
  const a = byTitle(fa), b = byTitle(fb);
  if (a && b) pairs.push({ id, lib: libs[0], a, b });
}

const settings = settingsOf(app), feedback = feedbackOf(app);
const analyses: Record<string, TrackAnalysis> = {};
const cases = [];
const seen = new Set<string>();
for (const p of pairs) {
  const A = analysisOf(p.lib, p.a.content_hash), B = analysisOf(p.lib, p.b.content_hash);
  const key = `${A?.version}:${p.a.content_hash}>${B?.version}:${p.b.content_hash}`;
  if (!A || !B || seen.has(key)) { if (!A || !B) console.log(`skip ${p.id}: analysis missing`); continue; }
  seen.add(key);
  const ka = `${A.version}:${p.a.content_hash.slice(0, 16)}`, kb = `${B.version}:${p.b.content_hash.slice(0, 16)}`;
  analyses[ka] = A; analyses[kb] = B;
  const from = { id: p.a.id, duration: p.a.duration, mixingAllowed: true }, to = { id: p.b.id, duration: p.b.duration, mixingAllowed: true };
  const plans: Record<string, unknown> = {};
  // desktop strips separation metadata (apps/server/src/automix.ts); the iPhone core may keep it
  for (const desktop of [true, false]) for (const fb of [null, feedback]) {
    const pa: PlannerTrack = { ...from, analysis: desktop ? { ...A, vocalActivity: undefined } : A };
    const pb: PlannerTrack = { ...to, analysis: desktop ? { ...B, vocalActivity: undefined } : B };
    const name = `${desktop ? 'desktop' : 'full'}-${fb ? 'ratings' : 'plain'}`;
    plans[name] = { plan: planTransition(pa, pb, settings, undefined, fb), finalists: planFinalists(pa, pb, settings, fb) };
  }
  cases.push({ id: p.id, label: `${p.a.artist} — ${p.a.title} → ${p.b.artist} — ${p.b.title}`, from: { ...from, analysis: ka }, to: { ...to, analysis: kb }, plans });
  console.log(`${p.id}: ${A.version}/${B.version} ${(plans['desktop-plain'] as { plan: TransitionPlan }).plan.method}`);
}
const out = path.join(root, 'packages/core/test/fixtures/liked-transitions.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ schema: 'mora-liked-transitions-1', note: 'Positively rated pairs: real analyses and the plans they must keep. Rebuild only on purpose.', settings, feedback, analyses, cases }));
console.log(`${cases.length} liked pairs, ${Object.keys(analyses).length} analyses -> ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
