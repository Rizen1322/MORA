/** Read-only evidence for a listener-transition audit. Does not open providers or change ratings.
 * node tools/audit-listener-transitions.mjs <automix.sqlite> [report.json]
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [, , database, output] = process.argv;
if (!database) throw new Error('Usage: node tools/audit-listener-transitions.mjs <automix.sqlite> [report.json]');
const db = new DatabaseSync(database, { readOnly: true });
try {
  const rows = db.prepare(`SELECT l.*, a.title fromTitle, a.artist fromArtist, b.title toTitle, b.artist toArtist
    FROM transition_log l LEFT JOIN tracks a ON a.id = l.from_track LEFT JOIN tracks b ON b.id = l.to_track
    WHERE l.rating IN ('good', 'bad') ORDER BY l.id`).all();
  const counts = {};
  const transitions = rows.map(row => {
    const p = JSON.parse(row.plan), d = p.debug ?? {}, outcome = JSON.parse(row.outcome);
    const group = counts[`${p.version}/${p.method}`] ??= { good: 0, bad: 0 };
    group[row.rating]++;
    const selected = d.renderCheck?.selected ?? d.fullMix?.this;
    return {
      id: row.id, executedAt: new Date(row.executed_at).toISOString(),
      rating: row.rating, reason: row.rating_reason,
      from: { id: row.from_track, artist: row.fromArtist, title: row.fromTitle },
      to: { id: row.to_track, artist: row.toArtist, title: row.toTitle },
      version: p.version, method: p.method, duration: p.duration, aExit: p.aExit,
      bEntry: p.bEntry, bDelay: p.bDelay ?? 0, nominalCutSeconds: d.cut ?? null,
      beatAlign: p.beatAlign, outcome, fullMix: d.fullMix, ratingFeedback: d.ratingFeedback,
      renderCheck: d.renderCheck,
      selectedRenderMetrics: d.renderCheck?.candidates?.find(c => c.name === selected)?.metrics ?? null,
    };
  });
  const saved = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get();
  const report = {
    generatedAt: new Date().toISOString(), database: path.resolve(database),
    totalLogged: db.prepare('SELECT count(*) n FROM transition_log').get().n,
    rated: rows.length, good: rows.filter(r => r.rating === 'good').length,
    bad: rows.filter(r => r.rating === 'bad').length,
    settings: saved ? JSON.parse(saved.value).automix : null,
    counts, transitions,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(output, json, 'utf8');
  console.log(JSON.stringify({ ...report, transitions: transitions.map(t => ({
    id: t.id, rating: t.rating, reason: t.reason, pair: `${t.from.title} → ${t.to.title}`,
    duration: t.duration, entry: t.bEntry, cut: t.nominalCutSeconds,
    technicalCost: t.selectedRenderMetrics?.cost ?? null,
  })) }, null, 2));
} finally { db.close(); }
