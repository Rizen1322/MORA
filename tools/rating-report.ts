/** Which planner signals separate transitions the listener rated good from bad.
 * Reads the server's transition_log (ratings + stored plan.debug) read-only and prints a report.
 * No weights are changed. Usage: npx tsx tools/rating-report.ts
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import type { TransitionPlan } from '../packages/core/src/index.ts';

/** P(bad value > good value), ties count half (Mann-Whitney AUC). 0.5 = no separation. */
export function auc(good: number[], bad: number[]): number {
  let s = 0;
  for (const b of bad) for (const g of good) s += b > g ? 1 : b === g ? 0.5 : 0;
  return s / (good.length * bad.length);
}
assert.equal(auc([1, 2], [3, 4]), 1);
assert.equal(auc([3, 4], [1, 2]), 0);
assert.equal(auc([1, 2], [1, 2]), 0.5);

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

interface Row { rating: 'good' | 'bad'; reason: string | null; plan: TransitionPlan; outcome: Record<string, unknown> }
type Stems = { lostA?: number; lostB?: number; voiceEcho?: unknown; entryScore?: number } | undefined;

const numeric: Record<string, (r: Row) => number | undefined> = {
  duration: (r) => num(r.plan.duration),
  stretchPercent: (r) => num(r.plan.beatAlign?.stretchPercent) ?? 0,
  loudnessHold: (r) => { const h = r.plan.debug.loudnessHold; return Array.isArray(h) && h.length ? Math.max(...h.filter((x) => typeof x === 'number')) : 0; },
  lostA: (r) => num((r.plan.debug.stems as Stems)?.lostA),
  lostB: (r) => num((r.plan.debug.stems as Stems)?.lostB),
  entryScore: (r) => num((r.plan.debug.stems as Stems)?.entryScore) ?? num(r.plan.debug.entryScore),
};
const categorical: Record<string, (r: Row) => string> = {
  method: (r) => r.plan.method,
  voiceEcho: (r) => ((r.plan.debug.stems as Stems)?.voiceEcho ? 'да' : 'нет'),
  stems: (r) => (r.plan.debug.stems ? 'да' : 'нет'),
  forced: (r) => (r.outcome.forced ? 'да' : 'нет'),
  late: (r) => (r.outcome.late ? 'да' : 'нет'),
};

const cfg = loadConfig();
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const cols = new Set((db.prepare('PRAGMA table_info(transition_log)').all() as { name: string }[]).map((c) => c.name));
const total = (db.prepare('SELECT count(*) AS n FROM transition_log').get() as { n: number }).n;
console.log(`База: ${cfg.dataDir}. Переходов в журнале: ${total}.`);
if (!cols.has('rating')) {
  console.log('В журнале ещё нет колонки оценок: перезапустите сервер с новым кодом и оцените несколько переходов.');
  process.exit(0);
}
const rows: Row[] = (db.prepare("SELECT rating, rating_reason, plan, outcome FROM transition_log WHERE rating IN ('good', 'bad') ORDER BY id").all() as
  { rating: 'good' | 'bad'; rating_reason: string | null; plan: string; outcome: string }[])
  .map((r) => ({ rating: r.rating, reason: r.rating_reason, plan: JSON.parse(r.plan) as TransitionPlan, outcome: JSON.parse(r.outcome) as Record<string, unknown> }));
const good = rows.filter((r) => r.rating === 'good'), bad = rows.filter((r) => r.rating === 'bad');
console.log(`Оценено: ${rows.length} (хорошо ${good.length}, плохо ${bad.length}).`);
if (!good.length || !bad.length) {
  console.log('Нужны оценки обоих видов, чтобы сравнивать признаки.');
  process.exit(0);
}
if (good.length < 10 || bad.length < 10) console.log('Внимание: меньше 10 оценок в одной из групп, выводы ненадёжны.');

const reasons = new Map<string, number>();
for (const r of bad) reasons.set(r.reason ?? 'без причины', (reasons.get(r.reason ?? 'без причины') ?? 0) + 1);
console.log('\nПричины плохих оценок:');
for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

console.log('\nЧисловые признаки (AUC: доля пар, где у плохого перехода значение больше; 0.5 — не разделяет):');
const table = Object.entries(numeric).map(([name, f]) => {
  const g = good.map(f).filter((v): v is number => v !== undefined), b = bad.map(f).filter((v): v is number => v !== undefined);
  return { name, g, b, auc: g.length && b.length ? auc(g, b) : NaN };
}).sort((x, y) => (Math.abs(y.auc - 0.5) || 0) - (Math.abs(x.auc - 0.5) || 0));
for (const t of table) {
  if (!t.g.length || !t.b.length) { console.log(`  ${t.name.padEnd(15)} мало данных (хорошо ${t.g.length}, плохо ${t.b.length})`); continue; }
  const dir = t.auc > 0.5 ? 'больше → хуже' : t.auc < 0.5 ? 'меньше → хуже' : '—';
  console.log(`  ${t.name.padEnd(15)} AUC ${t.auc.toFixed(2)}  медиана хорошо ${median(t.g).toFixed(2)} / плохо ${median(t.b).toFixed(2)}  (n ${t.g.length}/${t.b.length})  ${dir}`);
}

console.log('\nКатегории (доля плохих):');
for (const [name, f] of Object.entries(categorical)) {
  const by = new Map<string, { good: number; bad: number }>();
  for (const r of rows) { const k = f(r), c = by.get(k) ?? { good: 0, bad: 0 }; c[r.rating]++; by.set(k, c); }
  const parts = [...by].sort((a, b) => b[1].bad / (b[1].bad + b[1].good) - a[1].bad / (a[1].bad + a[1].good))
    .map(([k, c]) => `${k} ${Math.round((100 * c.bad) / (c.bad + c.good))}% из ${c.bad + c.good}`);
  console.log(`  ${name.padEnd(10)} ${parts.join(', ')}`);
}
