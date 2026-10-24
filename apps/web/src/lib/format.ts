export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtTotal(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function tracksWord(n: number): string {
  return `${n} ${plural(n, 'трек', 'трека', 'треков')}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `сегодня, ${time}`;
  if (d.toDateString() === y.toDateString()) return `вчера, ${time}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + `, ${time}`;
}

export const METHOD_LABEL: Record<string, string> = {
  beatmatch_blend: 'Сведение по битам',
  tempo_bridge: 'Мост темпа',
  drop_mix: 'Переход в сильную часть',
  phrase_cut: 'Короткий переход по фразе',
  crossfade: 'Плавный переход',
  echo_out: 'Эхо-переход',
  gapless: 'Без паузы',
  fallback_crossfade: 'Резервный кроссфейд',
  skip_fade: 'Быстрое переключение',
};

export function methodShort(p: { method: string; beatAlign?: { overlapBeats: number; glide?:boolean; bridge?:unknown }; duration: number; debug?: Record<string, unknown> }): string {
  // a crossfade is several different moves; name the one actually planned
  const variant = p.method !== 'crossfade' ? undefined : p.debug?.loopBridge ? 'Инструментальная петля' : p.debug?.washout ? 'Уход через фильтр' : p.debug?.naturalFade ? 'Переход в затухании' : undefined;
  const echo = p.debug?.voiceAnswer || (p.debug?.stems as { voiceEcho?: unknown } | undefined)?.voiceEcho ? ' · эхо голоса' : '';
  const effect=p.debug?.tapeStop?'Остановка ленты':(p.debug?.loopBridge as {roll?:boolean}|undefined)?.roll?'Loop roll':undefined;
  const bridge=p.method==='beatmatch_blend'&&(p.beatAlign?.bridge||p.beatAlign?.glide)?'Мост темпа':undefined;
  const base = (effect ?? (p.debug?.djFilterRelease ? 'Фильтр · эхо · вступление' : bridge ?? variant ?? METHOD_LABEL[p.method] ?? p.method)) + echo;
  if ((p.method === 'beatmatch_blend' || p.method === 'tempo_bridge') && p.beatAlign) {
    const bars=p.beatAlign.overlapBeats/4;
    return `${base} · ${bars} ${plural(bars,'такт','такта','тактов')}`;
  }
  if (p.method === 'crossfade' || p.method === 'fallback_crossfade' || p.method === 'echo_out') return `${base} · ${p.duration.toFixed(0)} с`;
  return base;
}
