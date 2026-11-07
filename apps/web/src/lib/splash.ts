/**
 * Launch intro «Хвойная ночь»: a painted spruce valley at sunset, silent, ~6.6 s.
 * The sun sets exactly where the jade period of «Моя волна.» sits on Home; its last
 * green flash becomes that period, night falls into --bg and the canvas dissolves
 * into the real interface underneath. Everything is generated at startup (no assets).
 */
import './splash.css';

type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D;
type Layer = { day: HTMLCanvasElement; night: HTMLCanvasElement; top: number; depth: number; dx?: number };

/** Scene seconds. HOLD is where the scene waits (sun half set) while the app is still loading. */
export const T = { bloom: 1.1, hold: 4.3, flash: 4.62, night: 4.4, fade: 5.6, end: 6.6 };
const MAX_WAIT = 10;

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#050d0a');
const JADE = hex('#4ade9a');
const AMBER = hex('#f5c86e');
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (v: number) => { const x = clamp(v); return x * x * (3 - 2 * x); };
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/** Sky keys (top, middle, horizon) over scene time: golden hour → dusk → the app's own night. */
const SKY: [number, RGB, RGB, RGB][] = [
  [0, hex('#78aeb0'), hex('#efdcae'), hex('#f6c07c')],
  [2.4, hex('#6c9fa3'), hex('#efcf98'), hex('#f5b264')],
  [4.3, hex('#2f5b58'), hex('#a8875e'), hex('#ee9a52')],
  [5.0, hex('#0f2621'), hex('#22382a'), hex('#4a4a2c')],
  [5.9, BG, BG, hex('#0b1d14')],
];
export function skyAt(t: number): [RGB, RGB, RGB] {
  let i = 0;
  while (i < SKY.length - 2 && t > SKY[i + 1][0]) i++;
  const [t0, ...a] = SKY[i];
  const [t1, ...b] = SKY[i + 1];
  const k = smooth((t - t0) / (t1 - t0));
  return [mixc(a[0], b[0], k), mixc(a[1], b[1], k), mixc(a[2], b[2], k)];
}

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function canvas(w: number, h: number, q: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * q));
  c.height = Math.max(1, Math.ceil(h * q));
  const g = c.getContext('2d')!;
  g.scale(q, q);
  return [c, g];
}

/** Flat night copy of a layer: same shape, one colour (shadows read as silhouettes at dusk). */
function silhouette(src: HTMLCanvasElement, color: string) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** One brush dab: an irregular hexagon, the painted-leaf mark the whole scene is made of. */
function dab(g: Ctx, r: () => number, x: number, y: number, s: number, color: string) {
  g.fillStyle = color;
  g.beginPath();
  const rot = r() * 6.28;
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * 6.28;
    const d = s * (0.6 + r() * 0.5);
    g.lineTo(x + Math.cos(a) * d * 1.3, y + Math.sin(a) * d * 0.8);
  }
  g.fill();
}

type Pal = { base: string; lit: string; shade: string; ink: number };
const INK = '#14241b';

function spruce(g: Ctx, r: () => number, x: number, base: number, h: number, p: Pal, sunX: number) {
  const tiers = Math.min(18, 6 + ((h / 70) | 0) + ((r() * 3) | 0));
  const w = h * (0.19 + r() * 0.07);
  const side = sunX >= x ? 1 : -1;
  g.fillStyle = p.shade;
  g.fillRect(x - h * 0.012, base - h * 0.14, h * 0.024, h * 0.14);
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const yt = base - h + h * 0.86 * Math.pow(f, 0.92);
    const yb = yt + (h * 0.86 / tiers) * 1.9;
    const wi = w * Math.pow((i + 1) / tiers, 0.9) * (0.85 + r() * 0.3);
    const droop = h * 0.025 * (0.5 + r());
    const tier = new Path2D();
    tier.moveTo(x + (r() - 0.5) * h * 0.01, yt);
    tier.lineTo(x + wi, yb + droop);
    const teeth = 3 + ((r() * 3 + wi / 30) | 0);
    for (let k = 1; k < teeth * 2; k++) {
      const px = x + wi - (2 * wi * k) / (teeth * 2);
      tier.lineTo(px, yb + (k % 2 ? -h * 0.028 * r() : droop * 0.6 * r()));
    }
    tier.lineTo(x - wi, yb + droop);
    tier.closePath();
    g.fillStyle = p.base;
    g.fill(tier);
    g.save();
    g.clip(tier);
    // light comes from the setting sun: warm dabs on its side, cool ones under the branches
    const s = Math.min(h * 0.022, 6);
    for (let k = 0; k < 4 + wi / 4; k++) dab(g, r, x + side * wi * Math.sqrt(r()), yt + (yb - yt) * (0.25 + r() * 0.6), s * (0.6 + r()), p.lit);
    for (let k = 0; k < 3 + wi / 4; k++) dab(g, r, x + (r() * 2 - 1) * wi, yb - (yb - yt) * r() * 0.3, s * 1.3, p.shade);
    g.restore();
    if (p.ink) { g.strokeStyle = INK; g.globalAlpha = p.ink; g.lineWidth = 1; g.stroke(tier); g.globalAlpha = 1; }
  }
}

function ridge(W: number, top: number, bottom: number, q: number, seed: number, sunX: number, opts: { trees: number; h: [number, number]; amp: number; pal: Pal; ground: string; night: string; gap: number; dab: number }): Layer {
  const r = rng(seed);
  const [c, g] = canvas(W, bottom - top, q);
  g.translate(0, -top);
  const ph = r() * 6;
  const hill = (x: number) => top + opts.h[1] + opts.amp * (0.5 + 0.5 * Math.sin(x / W * 5.1 + ph) * Math.sin(x / W * 2.3 + ph * 0.7))
    // the valley opens around the sun so it can set behind the far line
    + opts.gap * Math.exp(-Math.pow((x - sunX) / (W * 0.16), 2));
  // trees stand in groves, thinning out where the sun goes down
  const groves = Array.from({ length: 5 + ((r() * 4) | 0) }, () => r() * W);
  const trees: number[] = [];
  for (let i = 0; i < opts.trees; i++) {
    const x = groves[i % groves.length] + (r() + r() + r() - 1.5) * W * 0.09;
    if (Math.abs(x - sunX) > W * 0.05 || r() < 0.2) trees.push(x);
  }
  trees.sort((a, b) => a - b);
  g.fillStyle = opts.ground;
  g.beginPath();
  g.moveTo(0, bottom);
  for (let x = 0; x <= W; x += 8) g.lineTo(x, hill(x) + opts.h[0] * 0.35);
  g.lineTo(W, bottom);
  g.fill();
  // dappled canopy below the ridge line: the ground is painted, never flat
  const depthTone = g.createLinearGradient(0, top + opts.h[1], 0, bottom);
  depthTone.addColorStop(0, 'rgba(8,20,14,0)'); depthTone.addColorStop(1, 'rgba(8,20,14,.45)');
  const tones = [opts.pal.shade, opts.ground, opts.pal.lit];
  for (let i = 0; i < Math.min(5000, W * (bottom - top) / 260); i++) {
    const x = r() * W, y = hill(x) + opts.h[0] * 0.4 + Math.pow(r(), 1.4) * (bottom - hill(x));
    const t = r();
    dab(g, r, x, y, opts.dab * (0.6 + r() * 0.8), tones[t < 0.45 ? 0 : t < 0.91 ? 1 : 2]);
  }
  g.fillStyle = depthTone; g.fillRect(0, top, W, bottom - top);
  for (const x of trees) {
    const h = opts.h[0] + r() * (opts.h[1] - opts.h[0]);
    spruce(g, r, x, hill(x) + h * 0.35 + r() * opts.h[0] * 0.2, h, opts.pal, sunX);
  }
  return { day: c, night: silhouette(c, opts.night), top, depth: 0 };
}

/** A long stratus band: rose crown, cream body, underside gilded by the low sun, scalloped edge. */
function cloudBand(W: number, th: number, q: number, seed: number): HTMLCanvasElement {
  const r = rng(seed);
  const bw = W * (0.55 + r() * 0.35);
  const [c, g] = canvas(bw, th * 3, q);
  const p = [r() * 6, r() * 6, r() * 6];
  const env = (x: number) => Math.pow(Math.sin(Math.PI * x / bw), 0.5);
  const top = (x: number) => th * 1.6 - th * env(x) * (0.55 + 0.3 * Math.sin(x / bw * 11 + p[0]) * Math.sin(x / bw * 4 + p[2]) + 0.15 * Math.sin(x / bw * 37 + p[1]));
  const bot = (x: number) => th * 1.6 + th * 0.3 * env(x) * (0.7 + 0.3 * Math.sin(x / bw * 7 + p[2]));
  const body = (dy: number, color: string, under = 1) => {
    g.fillStyle = color;
    g.beginPath();
    for (let x = 0; x <= bw; x += 4) g.lineTo(x, top(x) + dy);
    for (let x = bw; x >= 0; x -= 4) g.lineTo(x, th * 1.6 + (bot(x) - th * 1.6) * under + dy * 0.3);
    g.fill();
  };
  body(-th * 0.2, '#d89ba3');
  for (let x = 4; x < bw; x += 3 + r() * 9) dab(g, r, x, top(x) - th * 0.12, th * 0.16 * env(x) + 0.5, '#e3abaa');
  body(th * 0.06, '#f7e6c6');
  for (let x = 4; x < bw; x += 3 + r() * 8) dab(g, r, x, top(x) + th * 0.1, th * 0.14 * env(x) + 0.5, '#fbefd6');
  g.fillStyle = '#f3c98d';
  g.beginPath();
  for (let x = 0; x <= bw; x += 4) g.lineTo(x, bot(x) - th * 0.12 * env(x));
  for (let x = bw; x >= 0; x -= 4) g.lineTo(x, bot(x));
  g.fill();
  for (let i = 0; i < bw / 30; i++) {
    const x = r() * bw;
    g.fillStyle = 'rgba(255,250,236,.35)';
    g.beginPath(); g.ellipse(x, (top(x) + bot(x)) / 2, th * (0.6 + r()), 0.8 + r() * 1.4, 0, 0, 6.28); g.fill();
  }
  return c;
}

function soft(W: number, h: number, q: number, seed: number, n: number) {
  const r = rng(seed);
  const [c, g] = canvas(W, h, q);
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = h * (0.3 + r() * 0.4), rx = W * (0.06 + r() * 0.12), ry = h * (0.12 + r() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, rx);
    gr.addColorStop(0, 'rgba(255,248,232,.5)');
    gr.addColorStop(1, 'rgba(255,248,232,0)');
    g.fillStyle = gr;
    g.setTransform(q, 0, 0, q * ry / rx, 0, y * q * (1 - ry / rx));
    g.beginPath(); g.arc(x, y, rx, 0, 6.28); g.fill();
  }
  return c;
}

/** Everything static for one window size. */
function build(W: number, H: number, hY: number, sunX: number, q: number) {
  const r = rng(7);
  const [streaks, sg] = canvas(W, hY, q);
  for (let i = 0; i < 140; i++) {
    sg.fillStyle = r() < 0.5 ? 'rgba(255,246,222,.06)' : 'rgba(120,170,170,.05)';
    sg.beginPath();
    sg.ellipse(r() * W, r() * hY, W * (0.05 + r() * 0.15), 1 + r() * 4, (r() - 0.5) * 0.06, 0, 6.28);
    sg.fill();
  }
  const ground = H - hY;
  const far: Layer = ridge(W, hY - 10, H, q, 11, sunX, { trees: Math.round(W / 5), h: [6, 14], amp: 3, pal: { base: '#a7bd9c', lit: '#e3d7a2', shade: '#93ab93', ink: 0 }, ground: '#a7bd9c', night: '#0c1d16', gap: 0, dab: 2 });
  far.depth = 0.12;
  const l1 = ridge(W, hY + ground * 0.04 - H * 0.12, H, q, 23, sunX, { trees: Math.round(W / 16), h: [H * 0.05, H * 0.1], amp: H * 0.05, pal: { base: '#6f957a', lit: '#c8cf8a', shade: '#557b68', ink: 0 }, ground: '#6f957a', night: '#0a1813', gap: H * 0.035, dab: 4 });
  l1.depth = 0.3;
  const l2 = ridge(W, hY + ground * 0.3 - H * 0.24, H, q, 37, sunX, { trees: Math.round(W / 34), h: [H * 0.12, H * 0.22], amp: H * 0.07, pal: { base: '#3c6a4b', lit: '#9fc162', shade: '#294c3a', ink: 0.35 }, ground: '#3c6a4b', night: '#08140f', gap: H * 0.06, dab: 7 });
  l2.depth = 0.55;
  // near framing: two spruce clusters at the edges and a meadow; they part like curtains at night
  const near = (left: boolean): Layer => {
    const rr = rng(left ? 51 : 67);
    const w = W * 0.3;
    const [c, g] = canvas(w, H * 1.25, q);
    for (let i = 0; i < 3; i++) {
      const h = H * (0.75 + rr() * 0.4);
      const x = left ? w * (0.02 + i * 0.16 + rr() * 0.06) : w * (0.98 - i * 0.16 - rr() * 0.06);
      spruce(g, rr, x, H * 1.25, h, { base: '#183526', lit: '#456f37', shade: '#0e2218', ink: 0.7 }, left ? W : -W);
    }
    return { day: c, night: silhouette(c, '#060f0b'), top: H * -0.25, depth: 1, dx: left ? 0 : W - w };
  };
  const meadowTop = hY + ground * 0.62;
  const [m, mg] = canvas(W, H - meadowTop + H * 0.3, q);
  mg.translate(0, -meadowTop);
  mg.fillStyle = '#2d5733';
  mg.beginPath(); mg.moveTo(0, H * 1.3);
  for (let x = 0; x <= W; x += 10) mg.lineTo(x, meadowTop + 14 + Math.sin(x / W * 7) * 8 + Math.sin(x / W * 17) * 4);
  mg.lineTo(W, H * 1.3); mg.fill();
  for (let i = 0; i < W / 2.2; i++) {
    const x = r() * W, y = meadowTop + 18 + r() * (H * 1.3 - meadowTop), hh = 6 + r() * 16;
    mg.strokeStyle = r() < 0.35 ? '#a6cd5e' : r() < 0.6 ? '#4d7d3c' : '#1c3a26';
    mg.lineWidth = 1.2;
    mg.beginPath(); mg.moveTo(x, y); mg.quadraticCurveTo(x + (r() - 0.5) * 6, y - hh * 0.6, x + (r() - 0.5) * 8, y - hh); mg.stroke();
  }
  for (let i = 0; i < W / 40; i++) dab(mg, r, r() * W, meadowTop + 30 + r() * (H - meadowTop), 1.6, '#f1ecdc');
  const meadow: Layer = { day: m, night: silhouette(m, '#07110c'), top: meadowTop, depth: 0.85 };
  const clouds = [0, 1, 2].map((i) => cloudBand(W, H * (0.06 - i * 0.012), q, 90 + i)).map((c, i) => ({ c, dusk: silhouette(c, '#6a5468'), y: hY * (0.04 + i * 0.27), x: W * [-0.12, 0.5, 0.08][i], v: 5 + i * 4 }));
  const mist = soft(W * 1.4, H * 0.08, q, 5, 26);
  const motes = Array.from({ length: 42 }, () => ({ x: r() * W, y: hY + r() * ground, s: 0.8 + r() * 1.8, v: 6 + r() * 14, p: r() * 6.28 }));
  const blades = Array.from({ length: Math.round(W / 22) }, () => ({ x: r() * W, h: H * (0.05 + r() * 0.09), w: 2 + r() * 3, p: r() * 6.28, lit: r() < 0.4 }));
  return { streaks, ridges: [far, l1, l2], nearL: near(true), nearR: near(false), meadow, clouds, mist, motes, blades, q };
}

export interface SplashOptions {
  /** True once the interface underneath is worth revealing. */
  ready: () => boolean;
  /** Home's jade period, the point the sun sets into. */
  target: () => Element | null;
}

export function playSplash({ ready, target }: SplashOptions) {
  const root = document.createElement('div');
  root.className = 'splash';
  root.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas');
  root.append(cv);
  const g = cv.getContext('2d');
  if (!g) return;
  document.body.append(root);

  let W = 0, H = 0, q = 1, scene: ReturnType<typeof build> | null = null;
  let builtY = 0, dotX = 0, dotY = 0, dotR = 0, aimed = false;
  // `?splash=4.6` holds the scene at that second, for design review
  const freeze = Number(new URLSearchParams(location.search).get('splash')) || 0;
  let st = 0, last = 0, wall = 0, fade = -1, fadeLen = T.end - T.fade, revealed = false;

  const reduced = () => {
    const m = document.documentElement.dataset.motion;
    return m === 'reduced' || (m === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };
  const measure = () => {
    const el = target();
    const b = el?.getBoundingClientRect();
    if (!b || !b.width) { if (!aimed) { dotX = W / 2; dotY = H * 0.42; dotR = Math.max(5, W * 0.006); } return; }
    // where the period's ink really is: the same font measured on our canvas
    const cs = getComputedStyle(el!);
    g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = g.measureText('.');
    const base = b.top + (b.height - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 + m.fontBoundingBoxAscent;
    const x = b.left + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const y = base - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    const rad = (m.actualBoundingBoxRight + m.actualBoundingBoxLeft) / 2;
    if (!aimed) { dotX = x; dotY = y; dotR = rad; aimed = true; }
    else { dotX += (x - dotX) * 0.2; dotY += (y - dotY) * 0.2; dotR += (rad - dotR) * 0.2; }
  };
  const skip = () => { if (fade < 0) { fade = st; fadeLen = 0.35; } };
  const stop = () => {
    removeEventListener('resize', onResize);
    root.removeEventListener('pointerdown', skip);
    removeEventListener('keydown', skip, true);
    root.remove();
  };
  const onResize = () => { scene = null; };
  addEventListener('resize', onResize);
  root.addEventListener('pointerdown', skip);
  addEventListener('keydown', skip, true);

  const frame = (now: number) => {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    wall += dt;
    if (document.hidden && fade < 0) skip();
    if (reduced() && fade < 0) { fade = st; fadeLen = 0.25; }
    if (!scene || W !== innerWidth || H !== innerHeight) {
      W = innerWidth; H = innerHeight;
      // weak GPUs and 4K screens: cap the backing store at ~3.6 MP
      q = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(3.6e6 / (W * H)));
      cv.width = Math.round(W * q); cv.height = Math.round(H * q);
      measure();
      builtY = dotY;
      scene = build(W, H, dotY, dotX, q);
    }
    measure();
    const waiting = st >= T.hold && !(ready() && aimed) && wall < MAX_WAIT;
    if (freeze) st = freeze;
    else if (!waiting) st += dt;
    const s = scene;
    const shift = dotY - builtY;
    const hY = dotY;
    const night = smooth((st - T.night) / (T.fade + 0.4 - T.night));
    const descend = 1 - smooth(st / 4.6);
    const [top, mid, hor] = skyAt(st);

    g.setTransform(q, 0, 0, q, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // sky
    const sky = g.createLinearGradient(0, 0, 0, hY + 40);
    sky.addColorStop(0, css(top)); sky.addColorStop(0.62, css(mid)); sky.addColorStop(1, css(hor));
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1 - night;
    g.drawImage(s.streaks, 0, shift, W, s.streaks.height / s.q);
    // sun: sinks from above the far line to below it, glow first
    const sunR = Math.min(W, H) * 0.06;
    // linear like a real sunset; keeps sinking after the flash
    const sunY = hY - sunR * 1.9 + sunR * 2.9 * clamp((st - 0.3) / (T.flash - 0.3), 0, 1.6);
    const glowA = (1 - night) * smooth(st / 0.8);
    let gr = g.createRadialGradient(dotX, sunY, 0, dotX, sunY, Math.max(W, H) * 0.55);
    gr.addColorStop(0, css(hex('#fff1c8'), 0.75 * glowA)); gr.addColorStop(0.18, css(hex('#f7c47c'), 0.32 * glowA)); gr.addColorStop(1, css(hor, 0));
    g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = css(mixc(hex('#fff4d6'), AMBER, smooth(st / T.flash)), 1 - night);
    g.beginPath(); g.arc(dotX, sunY, sunR, 0, 6.28); g.fill();
    // clouds drift and lose their light
    for (const c of s.clouds) {
      const w = c.c.width / s.q;
      const x = ((c.x + wall * c.v) % (W + w)) - w * 0.15;
      const y = c.y + shift + descend * H * 0.04, h = c.c.height / s.q;
      g.globalAlpha = 0.95 * (1 - night) * (1 - night);
      g.drawImage(c.c, x, y, w, h);
      g.globalAlpha *= 0.75 * smooth((st - 3.4) / 1.3);
      if (g.globalAlpha > 0) g.drawImage(c.dusk, x, y, w, h);
    }
    // crepuscular rays fanning up from the sun
    const rays = smooth((st - 1) / 1.2) * (1 - smooth((st - 4.2) / 0.6));
    if (rays > 0) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.5 + Math.sin(wall * 0.25 + i) * 0.05;
        const len = Math.max(W, H) * 0.9;
        gr = g.createLinearGradient(dotX, sunY, dotX + Math.cos(a) * len, sunY + Math.sin(a) * len);
        gr.addColorStop(0, `rgba(255,232,180,${0.035 * rays})`); gr.addColorStop(1, 'rgba(255,232,180,0)');
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(dotX, sunY);
        g.lineTo(dotX + Math.cos(a - 0.12) * len, sunY + Math.sin(a - 0.12) * len);
        g.lineTo(dotX + Math.cos(a + 0.12) * len, sunY + Math.sin(a + 0.12) * len);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }
    // ridges with aerial haze; the camera descends, so near layers rise more
    const haze = (y: number, a: number) => {
      // starts at the ridge line so the setting sun above it stays clean
      gr = g.createLinearGradient(0, y, 0, y + H * 0.1);
      gr.addColorStop(0, css(hor, 0)); gr.addColorStop(0.3, css(hor, a)); gr.addColorStop(1, css(hor, 0));
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, y, W, H * 0.1);
    };
    const draw = (l: Layer, dx = 0, dy = 0) => {
      const y = l.top + shift + descend * H * 0.35 * l.depth + night * H * 0.04 * l.depth + dy;
      const w = l.day.width / s.q, h = l.day.height / s.q;
      g.globalAlpha = 1; g.drawImage(l.day, (l.dx ?? 0) + dx, y, w, h);
      if (night > 0) { g.globalAlpha = night; g.drawImage(l.night, (l.dx ?? 0) + dx, y, w, h); }
      return y;
    };
    s.ridges.forEach((l, i) => {
      const y = draw(l);
      haze(y + (i ? H * 0.07 : 8),[0.55, 0.4, 0.25][i] * (1 - night * 0.5));
      if (i < 2) {
        // a slow river of mist between ridges — the scene's only "wave"
        const mw = s.mist.width / s.q;
        g.globalAlpha = (0.55 - i * 0.15) * (1 - night * 0.85);
        g.drawImage(s.mist, -((wall * (10 + i * 8)) % (mw - W)), y + H * (0.06 + i * 0.05) + Math.sin(wall * 0.8 + i) * 3, mw, s.mist.height / s.q);
      }
    });
    draw(s.meadow);
    // fireflies: pollen in daylight, amber sparks at dusk
    g.globalCompositeOperation = 'lighter';
    const fire = smooth((st - 2.6) / 1.4);
    for (const m of s.motes) {
      const y = m.y + shift - ((wall * m.v) % (H * 0.5));
      const x = m.x + Math.sin(wall * 0.9 + m.p) * 10;
      const blink = 0.5 + 0.5 * Math.sin(wall * 3 + m.p * 3);
      const a = (0.35 + fire * 0.6 * blink) * (1 - smooth((st - T.fade) / 0.6));
      g.globalAlpha = clamp(a);
      g.fillStyle = css(mixc(hex('#fff2cf'), AMBER, fire));
      g.beginPath(); g.arc(x, y, m.s * (1 + fire * blink), 0, 6.28); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const part = smooth((st - T.night) / (T.fade - T.night + 0.6)) * W * 0.32;
    draw(s.nearL, -part);
    draw(s.nearR, part);
    // foreground blades sway in a breeze
    const bladeY = H + descend * H * 0.35 + night * H * 0.04;
    for (const b of s.blades) {
      const sw = Math.sin(wall * 1.3 + b.p) * b.h * 0.12;
      g.fillStyle = css(mixc(hex(b.lit ? '#3f6e36' : '#1b3424'), hex('#050e0a'), night));
      g.beginPath(); g.moveTo(b.x - b.w, bladeY);
      g.quadraticCurveTo(b.x + sw * 0.5, bladeY - b.h * 0.6, b.x + sw, bladeY - b.h);
      g.quadraticCurveTo(b.x + sw * 0.4, bladeY - b.h * 0.5, b.x + b.w, bladeY); g.fill();
    }
    // night settles into --bg with Home's soft green glow around the hero
    if (night > 0) {
      g.globalAlpha = night * 0.9;
      gr = g.createRadialGradient(dotX, hY, 0, dotX, hY, Math.max(W, H) * 0.6);
      gr.addColorStop(0, '#0d2216'); gr.addColorStop(0.5, css(BG)); gr.addColorStop(1, css(BG));
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    // the green flash: the sun's last sliver turns jade and stays as the period
    const flash = smooth((st - (T.flash - 0.22)) / 0.3);
    if (flash > 0) {
      const settle = smooth((st - T.flash) / 0.45);
      const bloomR = dotR * (1 + 2.4 * (1 - settle) * flash);
      g.globalAlpha = 1;
      gr = g.createRadialGradient(dotX, dotY, 0, dotX, dotY, bloomR * 5);
      gr.addColorStop(0, css(JADE, 0.5 * flash)); gr.addColorStop(1, css(JADE, 0));
      g.fillStyle = gr; g.fillRect(dotX - bloomR * 5, dotY - bloomR * 5, bloomR * 10, bloomR * 10);
      // a flat sliver on the horizon that rounds up into the period
      g.fillStyle = css(mixc(AMBER, JADE, smooth((st - T.flash + 0.2) / 0.3)), flash);
      g.beginPath(); g.ellipse(dotX, dotY, bloomR * (1 + 1.2 * (1 - settle)), bloomR * (1 - 0.6 * (1 - settle)), 0, 0, 6.28); g.fill();
    }
    // opening: light blooms out of the dark, from where the sun is
    const open = smooth(st / T.bloom);
    if (open < 1) {
      const R = Math.hypot(W, H);
      const r0 = R * 1.3 * open;
      gr = g.createRadialGradient(dotX, sunY, r0 * 0.4, dotX, sunY, r0 + R * 0.25);
      gr.addColorStop(0, css(BG, 0)); gr.addColorStop(1, css(BG, 1));
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }

    if (fade < 0 && st >= T.fade && !freeze) fade = T.fade;
    if (fade >= 0) {
      const k = smooth((st - fade) / fadeLen);
      if (!revealed) { revealed = true; root.style.pointerEvents = 'none'; document.documentElement.classList.add('splash-reveal'); }
      if (waiting) st += dt; // a skip runs on wall time even while the scene waits for the app
      root.style.opacity = String(1 - k);
      if (k >= 1) { stop(); setTimeout(() => document.documentElement.classList.remove('splash-reveal'), 1200); return; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
