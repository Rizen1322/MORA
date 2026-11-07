/**
 * Launch intro «Хвойная ночь»: a painted spruce valley at sunset, silent, ~6.6 s.
 * The sun sets exactly where the jade period of «Моя волна.» sits on Home; its last
 * green flash becomes that period, night falls into --bg and the canvas dissolves
 * into the real interface underneath. Everything is painted at startup (no assets)
 * with one brush language: needle and grass strokes, soft gradients, backlit rims.
 */
import './splash.css';

type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D;
type Sprite = { day: HTMLCanvasElement; night: HTMLCanvasElement; halo?: HTMLCanvasElement; x: number; y: number; w: number; h: number };

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
const mixh = (a: string, b: string, t: number) => '#' + mixc(hex(a), hex(b), t).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

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

/** The scene keeps an unheard tempo, 104 bpm, so the green flash lands on a downbeat (beat 8). */
export const BEAT = T.flash / 8;
/** Wind swells once a bar and peaks on the downbeat. */
const bar = (t: number) => 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / (4 * BEAT));
/** A pluck from a beat onset: quick soft attack, slower release. */
const pluck = (f: number) => (1 - Math.exp(-f * 9)) * Math.exp(-f * 3.2);
/** What the mist river carries: a slow waveform with an envelope, like a track seen from afar. */
const waveform = (u: number, t: number) => (0.55 + 0.45 * Math.sin(u * 5.5 - t * 0.9)) * (0.65 * Math.sin(u * 38 - t * 2.6) + 0.35 * Math.sin(u * 83 - t * 4.1));
/** One smooth wind field for the whole scene: slow swell plus gusts rolling left to right. */
const gust = (x: number, t: number) => 0.55 * Math.sin(t * 0.8 - x * 0.004) + 0.3 * Math.sin(t * 0.33 - x * 0.0016 + 1.3) + 0.15 * Math.sin(t * 1.7 - x * 0.011);

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function canvas(w: number, h: number, q: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * q));
  c.height = Math.max(1, Math.ceil(h * q));
  const g = c.getContext('2d')!;
  g.scale(q, q);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  return [c, g];
}

/** Same shape, one colour: what each layer becomes once the light is gone. */
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

/** Soft focus for depth: distant planes are painted a touch out of focus. */
function soften(src: HTMLCanvasElement, px: number) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d')!;
  g.filter = `blur(${px}px)`;
  g.drawImage(src, 0, 0);
  return c;
}

/** Four values of one hue: shade inside the boughs, body, light on top, warm backlit rim. */
type Tone = [string, string, string, string];
const tone = (base: string, haze = 0): Tone => {
  const b = mixh(base, '#f3d7a0', haze);
  // distance flattens contrast: hazier planes keep their shapes but lose their values
  const k = clamp(1 - haze * 1.7);
  return [mixh(b, '#0b1d15', 0.42 * k + 0.06), b, mixh(b, '#d9e59a', 0.26 * k + 0.04), mixh(b, '#ffd890', 0.6 * k + 0.12)];
};

/** Stroke buckets: one path per value, stroked in order shade → body → light → rim. */
class Brush {
  p = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  constructor(private g: Ctx, private t: Tone) {}
  line(v: number, x0: number, y0: number, x1: number, y1: number) { this.p[v].moveTo(x0, y0); this.p[v].lineTo(x1, y1); }
  flush(width: number) {
    // shade strokes are fuller, rim strokes finer: the brush lightens as it lifts
    this.p.forEach((p, i) => { this.g.lineWidth = width * [1.35, 1.1, 0.9, 0.7][i]; this.g.strokeStyle = this.t[i]; this.g.stroke(p); });
    this.p = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  }
}

/**
 * A spruce built like a painter builds one: a slim trunk, drooping boughs from a dark
 * core outwards, needle sprays whose upper sides catch the sky and whose tips facing
 * the setting sun glow.
 */
function spruce(g: Ctx, r: () => number, x: number, base: number, h: number, t: Tone, sunX: number, small = false) {
  const side = sunX >= x ? 1 : -1;
  const w = h * (0.2 + r() * 0.08);
  const lean = (r() - 0.5) * h * 0.03;
  const d = clamp(h * 0.03, 1.2, 11);
  const lw = Math.max(0.5, d * 0.16);
  const brush = new Brush(g, t);
  if (small) {
    // distant trees read as masses first: a ragged cone, shaded toward its foot
    const body = g.createLinearGradient(0, base - h, 0, base);
    body.addColorStop(0, t[1]); body.addColorStop(1, t[0]);
    g.fillStyle = body;
    g.beginPath(); g.moveTo(x + lean, base - h);
    const steps = Math.max(3, Math.round(h / 5));
    for (const s of [1, -1]) for (let k = 1; k <= steps; k++) {
      const kk = s > 0 ? k : steps + 1 - k;
      const f = kk / steps;
      g.lineTo(x + lean * (1 - f) + s * w * f * (k % 2 ? 1 : 0.7) * (0.85 + r() * 0.3), base - h + h * f * 0.95);
    }
    g.closePath(); g.fill();
  } else {
    g.strokeStyle = t[0];
    g.lineWidth = Math.max(0.8, h * 0.016);
    g.beginPath(); g.moveTo(x, base); g.lineTo(x + lean * 0.5, base - h * 0.5); g.stroke();
  }
  /** One bough: it droops from the trunk and lifts again at the tip; branchlets hang from it in fans. */
  const bough = (tx: number, y: number, s: number, len: number, f: number, front: boolean, br = brush, core = t[0]) => {
    const droop = (0.1 + (1 - f) * 0.3 + r() * 0.12) * len;
    const curl = len * (0.05 + r() * 0.08);
    const at = (u: number): [number, number] => [tx + s * len * u, y + droop * Math.sin(u * 2.2) * 0.9 - curl * u * u * u];
    if (!small) {
      g.strokeStyle = core; g.lineWidth = d * (front ? 0.9 : 1.3);
      g.beginPath(); g.moveTo(tx, y);
      for (let u = 0.1; u <= 1.001; u += 0.1) { const [px, py] = at(u); g.lineTo(px, py); }
      g.stroke();
    }
    const fans = Math.max(2, Math.round(len / (d * (small ? 1.1 : 0.7))));
    for (let k = 1; k <= fans; k++) {
      const u = k / fans;
      const [px, py] = at(u);
      const hang = d * (0.7 + u * 0.9) * (0.75 + r() * 0.6);
      const strands = small ? 3 : 6 + ((r() * 3) | 0);
      for (let m = 0; m < strands; m++) {
        // a fan from lying-out to hanging-down; the upper strands face the sky and are shorter
        const a = (m / (strands - 1)) * 1.3 + (r() - 0.5) * 0.3;
        const upper = a < 0.35;
        const l = hang * (upper ? 0.65 : 1) * (0.75 + r() * 0.4);
        const nx = px + s * Math.cos(a) * l * 0.8, ny = py + Math.sin(a) * l - l * 0.15;
        const rim = upper && ((s === side && u > 0.5 && r() < 0.8) || (f > 0.85 && r() < 0.5));
        const v = rim ? 3 : upper ? 2 : a > 0.95 ? 0 : front && r() < 0.5 ? 0 : 1;
        br.line(v, px, py, nx, ny);
      }
    }
    if (!small) br.flush(lw);
  };
  const n = Math.round(clamp(h / 8, 5, 48));
  if (!small) {
    // the far side of the crown first: darker boughs between the visible ones give the tree its volume
    const back: Tone = [t[0], t[0], mixh(t[0], t[1], 0.5), mixh(t[1], t[3], 0.25)];
    const bb = new Brush(g, back);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const y = base - h * 0.1 - f * h * 0.86;
      const reach = (w * Math.pow(1 - f, 0.75) + d) * (0.6 + r() * 0.4);
      for (const s of [-1, 1]) bough(x + lean * (base - y) / h, y, s, reach * (0.7 + r() * 0.3), f, false, bb, t[0]);
    }
  }
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const y = base - h * 0.1 - f * h * 0.86 + (r() - 0.5) * h * 0.02;
    const tx = x + lean * (base - y) / h;
    // a slightly convex cone with ragged edges and the odd missing bough
    const reach = (w * Math.pow(1 - f, 0.75) + d) * (0.65 + r() * 0.6);
    // small trees keep their boughs inside their silhouette, or they read as crosses
    for (const s of [-1, 1]) if (r() > 0.08 || f > 0.8) { const len = reach * (0.75 + r() * 0.45); bough(tx, y, s, small ? Math.min(len, w * (1 - f) + d * 0.4) : len, f, false); }
    // boughs reaching toward the camera hide the trunk and give the crown depth
    if (!small && f < 0.85) bough(tx + (r() - 0.5) * d, y + d * 0.6, r() < 0.5 ? -1 : 1, reach * (0.25 + r() * 0.25), f, true);
  }
  // crown: a short spire of fresh growth
  const cx = x + lean * 0.95, cy = base - h * 0.97;
  for (let k = 0; k < 5; k++) brush.line(k < 2 ? 3 : 2, cx, cy + k * d * 0.5, cx + (k % 2 ? 1 : -1) * d * 0.6, cy + k * d * 0.5 + d * 0.5);
  brush.line(3, cx, cy + d * 2, cx, cy - d * 0.8);
  brush.flush(lw);
}

/** Grass over a slope: tapered, gently curved blades, lighter toward the lit crest. */
function grass(g: Ctx, r: () => number, t: Tone, W: number, crest: (x: number) => number, bottom: number, n: number, len: number) {
  const p = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  for (let i = 0; i < n; i++) {
    const x = r() * W;
    const top = crest(x);
    const depth = Math.pow(r(), 1.3);
    const y = top + 2 + depth * (bottom - top);
    const l = len * (0.5 + r() * 0.8) * (0.6 + depth * 0.8);
    const v = depth < 0.08 ? (r() < 0.25 ? 3 : 2) : r() < 0.3 ? 2 : r() < 0.6 ? 1 : 0;
    const lean = (r() - 0.45) * l * 0.55, bw = Math.max(0.35, l * 0.045) * (0.7 + r() * 0.6);
    const b = p[v];
    b.moveTo(x - bw, y);
    b.quadraticCurveTo(x + lean * 0.25 - bw * 0.3, y - l * 0.6, x + lean, y - l);
    b.quadraticCurveTo(x + lean * 0.3 + bw * 0.5, y - l * 0.5, x + bw, y);
    b.closePath();
  }
  p.forEach((b, i) => { g.fillStyle = t[i]; g.fill(b); });
}

/** Volume over a finished layer: warm bounce near the sun, cool shade lower down. */
function light(g: Ctx, W: number, top: number, bottom: number, sunX: number, sunY: number, warm: number, shade: number) {
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const r = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, W * 0.55);
  r.addColorStop(0, `rgba(255,214,140,${warm})`); r.addColorStop(1, 'rgba(255,214,140,0)');
  g.fillStyle = r; g.fillRect(0, top, W, bottom - top);
  const v = g.createLinearGradient(0, top, 0, bottom);
  v.addColorStop(0, 'rgba(6,18,12,0)'); v.addColorStop(1, `rgba(6,18,12,${shade})`);
  g.fillStyle = v; g.fillRect(0, top, W, bottom - top);
  g.restore();
}

const wave = (r: () => number, W: number) => {
  const p = [r() * 6, r() * 6, r() * 6];
  return (x: number) => 0.5 + 0.28 * Math.sin(x / W * 4.3 + p[0]) + 0.16 * Math.sin(x / W * 9.7 + p[1]) + 0.06 * Math.sin(x / W * 23 + p[2]);
};

type Layer = { day: HTMLCanvasElement; night: HTMLCanvasElement; top: number; depth: number };
function layer(W: number, top: number, bottom: number, q: number, night: string, depth: number, blur: number, paint: (g: Ctx) => void): Layer {
  const [c, g] = canvas(W, bottom - top, q);
  g.translate(0, -top);
  paint(g);
  const day = blur ? soften(c, blur * q) : c;
  return { day, night: silhouette(day, night), top, depth };
}

/** A long stratus band: soft rose crown, cream body, underside gilded by the low sun. */
function cloud(W: number, th: number, q: number, seed: number) {
  const r = rng(seed);
  const bw = W * (0.55 + r() * 0.35);
  const [c, g] = canvas(bw, th * 3.2, q);
  /** A band of overlapping puffs along part of the cloud, tapering at both ends. */
  const shape = (grow: number, dy: number, a0 = 0, a1 = 1, wv = wave(r, bw)) => {
    const p = new Path2D();
    for (let x = a0 * bw; x < a1 * bw; x += th * 0.16) {
      const env = Math.pow(Math.sin(Math.PI * (x / bw - a0) / (a1 - a0)), 0.6);
      const rad = th * env * (0.3 + 0.7 * wv(x)) * grow + 0.5;
      const cy = th * 1.9 - rad * 0.55 + dy;
      p.moveTo(x + rad * 1.3, cy); p.ellipse(x, cy, rad * 1.3, rad, 0, 0, 6.29);
    }
    return p;
  };
  const body = g.createLinearGradient(0, th * 0.6, 0, th * 2.5);
  body.addColorStop(0, '#dca4a8'); body.addColorStop(0.45, '#f7e4c8'); body.addColorStop(1, '#f2c487');
  // a fainter, broken tier behind and above: stratus is never one clean lens
  g.filter = `blur(${2.2 * q}px)`;
  g.globalAlpha = 0.55;
  g.fillStyle = body; g.fill(shape(0.6, -th * 0.55, 0.05 + r() * 0.2, 0.55 + r() * 0.2));
  g.fill(shape(0.45, -th * 0.4, 0.5 + r() * 0.15, 0.92));
  g.globalAlpha = 1;
  g.filter = `blur(${0.9 * q}px)`;
  g.fillStyle = body; g.fill(shape(1, 0));
  g.filter = `blur(${1.6 * q}px)`;
  g.fillStyle = 'rgba(255,246,226,.55)'; g.fill(shape(0.6, -th * 0.15));
  g.fillStyle = 'rgba(250,196,130,.5)'; g.fill(shape(0.45, th * 0.32));
  // wisps trailing off the ends, combed by the wind
  g.filter = `blur(${1.2 * q}px)`;
  for (let i = 0; i < 14; i++) {
    const x = bw * (0.1 + r() * 0.8), y = th * (1.5 + r() * 0.7);
    // never wider than the room left to the canvas edge, or the wisp would end in a cut
    const rx = Math.min(th * (1 + r() * 2.5), x - 4, bw - x - 4);
    g.fillStyle = `rgba(250,232,206,${0.12 + r() * 0.15})`;
    g.beginPath(); g.ellipse(x, y, rx, 0.8 + r() * 1.6, 0, 0, 6.29); g.fill();
  }
  return c;
}

function glow(color: RGB, q: number) {
  const [c, g] = canvas(32, 32, q);
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, css(color, 1)); gr.addColorStop(0.18, css(color, 0.75)); gr.addColorStop(0.45, css(color, 0.18)); gr.addColorStop(1, css(color, 0));
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return c;
}

/** A grass tuft for the foreground: tapered blades, dark with sunlit edges. */
function tuft(r: () => number, h: number, q: number, sunRight: boolean): Sprite {
  // wide enough that no blade, leaning or blurred, ever reaches the sprite's edge
  const w = h * 1.5;
  const [c, g] = canvas(w, h, q);
  const blades = 11 + ((r() * 9) | 0);
  for (let i = 0; i < blades; i++) {
    const bx = w / 2 + (r() - 0.5) * h * 0.3;
    const bh = h * (0.4 + r() * 0.55);
    const tip = bx + (r() - 0.5) * h * 0.6;
    const bw = 1.2 + r() * 2.2;
    const col = r() < 0.5 ? '#10251a' : r() < 0.75 ? '#163021' : '#203d28';
    g.fillStyle = col;
    g.beginPath(); g.moveTo(bx - bw, h);
    g.quadraticCurveTo(bx + (tip - bx) * 0.2, h - bh * 0.6, tip, h - bh);
    g.quadraticCurveTo(bx + (tip - bx) * 0.25 + bw * 0.4, h - bh * 0.55, bx + bw, h);
    g.fill();
    // backlight running up the sunward edge
    const gr = g.createLinearGradient(0, h, 0, h - bh);
    gr.addColorStop(0, 'rgba(240,200,120,0)'); gr.addColorStop(1, 'rgba(236,198,124,.45)');
    g.strokeStyle = gr; g.lineWidth = 0.8;
    const o = sunRight ? bw * 0.5 : -bw * 0.5;
    g.beginPath(); g.moveTo(bx + o, h - bh * 0.3); g.quadraticCurveTo(bx + (tip - bx) * 0.3 + o, h - bh * 0.62, tip, h - bh); g.stroke();
  }
  const day = soften(c, 0.5 * q);
  return { day, night: silhouette(day, '#050d09'), x: 0, y: 0, w, h };
}

/** Everything static for one window size. */
function build(W: number, H: number, hY: number, sunX: number, q: number) {
  const r = rng(7);
  const ground = H - hY;
  const [streaks, sg] = canvas(W, hY, q);
  sg.filter = `blur(${0.8 * q}px)`;
  for (let i = 0; i < 120; i++) {
    sg.fillStyle = r() < 0.55 ? 'rgba(255,246,222,.07)' : 'rgba(120,170,170,.05)';
    sg.beginPath(); sg.ellipse(r() * W, r() * hY, W * (0.05 + r() * 0.16), 1 + r() * 3.5, (r() - 0.5) * 0.04, 0, 6.29); sg.fill();
  }
  const valley = (x: number, depth: number) => depth * Math.exp(-Math.pow((x - sunX) / (W * 0.17), 2));

  // horizon: a hazy line of tiny spruces the sun goes down behind
  const far = layer(W, hY - 22, H, q, '#0c1d16', 0.12, 1.1, (g) => {
    const t = tone('#94ae98', 0.45);
    // a treeline of fine spires, too far away for anything but its edge
    g.fillStyle = t[1];
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 1.5 + r() * 2.5) {
      const tall = 3 + r() * (r() < 0.2 ? 10 : 5);
      g.lineTo(x, hY + 7); g.lineTo(x + 0.9, hY + 7 - tall); g.lineTo(x + 1.8, hY + 7);
    }
    g.lineTo(W, H); g.fill();
  });

  // forested hills: three packed rows, hazier the further they are
  const ridge1 = wave(r, W);
  const y1 = (x: number) => hY + ground * 0.1 + H * 0.045 * ridge1(x) + valley(x, H * 0.03);
  const l1 = layer(W, hY + ground * 0.1 - H * 0.1, H, q, '#0a1813', 0.3, 0.6, (g) => {
    // rows of canopy stepping down the hillside to the near slope, less haze each row
    const rows = [0.32, 0.25, 0.19, 0.14, 0.1, 0.06, 0.03, 0].map((hz, k) => tone(mixh('#86a58d', '#456e58', k / 7), hz));
    g.fillStyle = rows[1][0];
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) g.lineTo(x, y1(x) + H * 0.015);
    g.lineTo(W, H); g.fill();
    rows.forEach((t, k) => {
      for (let x = -10; x < W + 10; x += H * 0.011 * (0.5 + r()) * (1 + k * 0.15)) {
        const h = H * (0.028 + r() * 0.03) * (1 + k * 0.16);
        spruce(g, r, x, y1(x) + k * ground * 0.045 + h * 0.2, h, t, sunX, true);
      }
    });
    light(g, W, hY, H, sunX, hY, 0.28, 0.5);
  });

  // the near slope: a meadow with groves of full-size spruces
  const ridge2 = wave(r, W);
  const y2 = (x: number) => hY + ground * 0.36 + H * 0.06 * ridge2(x) + valley(x, H * 0.05);
  const l2 = layer(W, hY + ground * 0.36 - H * 0.26, H, q, '#08140f', 0.55, 0, (g) => {
    const t = tone('#3f6d4b');
    const slope = g.createLinearGradient(0, hY + ground * 0.36, 0, H);
    slope.addColorStop(0, '#5f8a52'); slope.addColorStop(0.25, '#3c6844'); slope.addColorStop(1, '#1f4130');
    g.fillStyle = slope;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) g.lineTo(x, y2(x));
    g.lineTo(W, H); g.fill();
    grass(g, r, tone('#4a7a48'), W, y2, H, Math.round(W * 3.2), H * 0.012);
    // folds of the land: long soft shadows lying across the slope
    g.save();
    g.globalCompositeOperation = 'source-atop';
    g.filter = `blur(${14 * q}px)`;
    for (let i = 0; i < 7; i++) {
      const x = r() * W, y = y2(x) + (0.15 + r() * 0.6) * (H - y2(x));
      g.fillStyle = r() < 0.7 ? 'rgba(14,38,26,.32)' : 'rgba(255,224,160,.16)';
      g.beginPath(); g.ellipse(x, y, W * (0.12 + r() * 0.18), H * (0.012 + r() * 0.02), (r() - 0.5) * 0.12, 0, 6.29); g.fill();
    }
    g.restore();
    // a forest edge along the crest, opening where the sun goes down
    const edge = tone('#4c7a5c', 0.1);
    for (let x = -10; x < W + 10; x += H * 0.016 * (0.5 + r())) {
      const open = Math.exp(-Math.pow((x - sunX) / (W * 0.13), 2));
      if (r() < open * 1.4) continue;
      const h = H * (0.05 + r() * 0.05) * (1 - open * 0.5);
      spruce(g, r, x, y2(x) + h * 0.12, h, edge, sunX, h < H * 0.07);
    }
    const groves = [0.06, 0.2, 0.36, 0.7, 0.88].map((f) => f * W + (r() - 0.5) * W * 0.05).filter((x) => Math.abs(x - sunX) > W * 0.09);
    for (const gx of groves) {
      const trees = Array.from({ length: 4 + ((r() * 4) | 0) }, () => gx + (r() - 0.5) * W * 0.1).sort((a, b) => Math.abs(b - gx) - Math.abs(a - gx));
      // the tallest stands at the heart of the grove and is painted last
      trees.forEach((x, i) => { const h = H * (0.08 + 0.15 * (i + 1) / trees.length) * (0.85 + r() * 0.3); spruce(g, r, x, y2(x) + h * 0.08 + H * 0.01, h, t, sunX); });
    }
    light(g, W, hY + ground * 0.2, H, sunX, y2(sunX), 0.32, 0.55);
  });

  // meadow under the camera
  const ridge3 = wave(r, W);
  const y3 = (x: number) => hY + ground * 0.64 + H * 0.025 * ridge3(x);
  const meadow = layer(W, hY + ground * 0.6, H * 1.3, q, '#07110c', 0.85, 0, (g) => {
    const m = g.createLinearGradient(0, hY + ground * 0.64, 0, H);
    m.addColorStop(0, '#5a8447'); m.addColorStop(0.3, '#335e37'); m.addColorStop(1, '#16301f');
    g.fillStyle = m;
    g.beginPath(); g.moveTo(0, H * 1.3);
    for (let x = 0; x <= W; x += 6) g.lineTo(x, y3(x));
    g.lineTo(W, H * 1.3); g.fill();
    grass(g, r, tone('#3f6b3c'), W, y3, H * 1.3, Math.round(W * 5), H * 0.022);
    // a scatter of small pale flowers, round and soft
    for (let i = 0; i < W / 14; i++) {
      const x = r() * W, y = y3(x) + 8 + Math.pow(r(), 1.5) * (H - y3(x));
      g.fillStyle = r() < 0.7 ? 'rgba(246,240,222,.85)' : 'rgba(214,196,232,.8)';
      g.beginPath(); g.arc(x, y, 0.8 + r() * 1.3, 0, 6.29); g.fill();
    }
    light(g, W, hY + ground * 0.6, H * 1.3, sunX, y3(sunX), 0.3, 0.6);
  });

  // near spruces framing the frame; each one its own sprite so it can bend in the wind
  const tree = (left: boolean, i: number): Sprite => {
    const rr = rng(left ? 51 + i : 67 + i);
    const h = H * (0.82 + rr() * 0.36) * (1 - i * 0.12);
    // the widest bough reaches ~0.46 h from the trunk; the margin keeps every needle inside the sprite
    const w = h * 1.15, ch = h * 1.08;
    const [c, g] = canvas(w, ch, q);
    spruce(g, rr, w / 2, ch, h, tone('#1f3d2a'), left ? 1e9 : -1e9);
    light(g, w, 0, ch, left ? w : 0, h * 0.35, 0.22, 0.65);
    // depth: the crown darkens toward the trunk, where little light gets in
    g.save();
    g.globalCompositeOperation = 'source-atop';
    const ao = g.createLinearGradient(w / 2 - h * 0.3, 0, w / 2 + h * 0.3, 0);
    ao.addColorStop(0, 'rgba(5,14,9,0)'); ao.addColorStop(0.5, 'rgba(5,14,9,.38)'); ao.addColorStop(1, 'rgba(5,14,9,0)');
    g.fillStyle = ao; g.fillRect(0, 0, w, ch);
    g.restore();
    // backlight scattering around the foliage, painted at a quarter size and scaled up soft
    const [halo, hg] = canvas(w / 4, ch / 4, 1);
    hg.filter = `blur(${Math.max(3, h * 0.008)}px)`;
    hg.drawImage(silhouette(c, '#ffd08a'), 0, 0, w / 4, ch / 4);
    const cx = left ? W * (0.04 + i * 0.075) - W * 0.03 * i : W * (0.96 - i * 0.075) + W * 0.03 * i;
    return { day: c, night: silhouette(c, '#060f0b'), halo, x: cx - w / 2, y: H - ch + H * 0.02, w, h: ch };
  };
  // the near spruces are the costliest paint; they are made one per frame while the opening is still dark
  const near: (Sprite | undefined)[] = [];
  const jobs = [true, false].flatMap((left, k) => [2, 1, 0].map((i, j) => () => { near[k * 3 + j] = tree(left, i); }));

  const tr = rng(99);
  const tufts = Array.from({ length: Math.round(W / 70) }, (_, i) => {
    const t = tuft(tr, H * (0.07 + tr() * tr() * 0.16), q, true);
    t.x = (i + tr()) * 70 - t.w / 2; t.y = H - t.h * 0.9 + tr() * H * 0.03;
    return t;
  });

  const clouds = [0, 1, 2].map((i) => cloud(W, H * (0.075 - i * 0.017), q, 90 + i)).map((c, i) => ({ c, dusk: silhouette(c, '#5f4c60'), y: hY * (0.03 + i * 0.27), x: W * [-0.12, 0.5, 0.08][i], v: 5 + i * 4 }));
  const [mist, mg] = canvas(W * 1.4, H * 0.08, q);
  mg.filter = `blur(${6 * q}px)`;
  for (let i = 0; i < 22; i++) {
    mg.fillStyle = 'rgba(255,247,230,.32)';
    mg.beginPath(); mg.ellipse(r() * W * 1.4, H * 0.04, W * (0.05 + r() * 0.1), H * (0.008 + r() * 0.012), 0, 0, 6.29); mg.fill();
  }
  const motes = Array.from({ length: 46 }, () => ({ x: r() * W, y: hY + r() * ground, s: 0.6 + r() * 1.2, v: 5 + r() * 12, p: r() * 6.28 }));
  // kept away from the centre so they never sit on the title or the sun
  const bokeh = Array.from({ length: 7 }, (_, i) => ({ x: W * (i % 2 ? 0.62 + r() * 0.34 : 0.04 + r() * 0.34), y: H * (0.45 + r() * 0.5), s: H * (0.05 + r() * 0.07), v: 3 + r() * 6, p: r() * 6.28 }));
  return { streaks, ridges: [far, l1, l2], near, jobs, meadow, tufts, clouds, mist, motes, bokeh, pollen: glow(hex('#fff2cf'), q), fly: glow(AMBER, q), q };
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
    // one near spruce per frame while the screen is still dark; all at once if it is already lit (a resize)
    do s.jobs.shift()?.(); while (s.jobs.length && st > 0.3);
    const shift = dotY - builtY;
    const hY = dotY;
    const night = smooth((st - T.night) / (T.fade + 0.4 - T.night));
    const descend = 1 - smooth(st / 4.6);
    const [top, mid, hor] = skyAt(st);
    const lit = 1 - night;

    g.setTransform(q, 0, 0, q, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // sky
    const sky = g.createLinearGradient(0, 0, 0, hY + 40);
    sky.addColorStop(0, css(top)); sky.addColorStop(0.62, css(mid)); sky.addColorStop(1, css(hor));
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.globalAlpha = lit;
    g.drawImage(s.streaks, 0, shift, W, s.streaks.height / s.q);
    // sun: sinks from above the far line to below it; linear like a real sunset
    const sunR = Math.min(W, H) * 0.06;
    const sunY = hY - sunR * 1.9 + sunR * 2.9 * clamp((st - 0.3) / (T.flash - 0.3), 0, 1.6);
    const glowA = lit * smooth(st / 0.8);
    let gr = g.createRadialGradient(dotX, sunY, 0, dotX, sunY, Math.max(W, H) * 0.55);
    gr.addColorStop(0, css(hex('#fff1c8'), 0.75 * glowA)); gr.addColorStop(0.18, css(hex('#f7c47c'), 0.32 * glowA)); gr.addColorStop(1, css(hor, 0));
    g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
    gr = g.createRadialGradient(dotX, sunY, 0, dotX, sunY, sunR);
    gr.addColorStop(0, css(hex('#fffaf0'), lit)); gr.addColorStop(0.75, css(mixc(hex('#ffeccb'), AMBER, smooth(st / T.flash)), lit)); gr.addColorStop(1, css(mixc(hex('#ffd99a'), AMBER, smooth(st / T.flash)), lit * 0.9));
    g.fillStyle = gr; g.beginPath(); g.arc(dotX, sunY, sunR, 0, 6.29); g.fill();
    // a thin band of warm air lying on the horizon
    g.save(); g.translate(dotX, hY); g.scale(1, 0.09);
    gr = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.6);
    gr.addColorStop(0, `rgba(255,226,170,${0.5 * glowA})`); gr.addColorStop(1, 'rgba(255,226,170,0)');
    g.fillStyle = gr; g.fillRect(-W, -W * 0.6, W * 2, W * 1.2);
    g.restore();
    // clouds drift and cool from gold to mauve
    for (const c of s.clouds) {
      const w = c.c.width / s.q;
      const x = ((c.x + wall * c.v) % (W + w)) - w * 0.15;
      const y = c.y + shift + descend * H * 0.04, h = c.c.height / s.q;
      g.globalAlpha = 0.95 * lit * lit;
      g.drawImage(c.c, x, y, w, h);
      g.globalAlpha *= 0.5 * smooth((st - 3.4) / 1.3);
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
    // planes with aerial haze; the camera settles, so near planes rise more
    const haze = (y: number, a: number) => {
      gr = g.createLinearGradient(0, y, 0, y + H * 0.1);
      gr.addColorStop(0, css(hor, 0)); gr.addColorStop(0.3, css(hor, a)); gr.addColorStop(1, css(hor, 0));
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, y, W, H * 0.1);
    };
    const yOf = (top: number, depth: number) => top + shift + descend * H * 0.35 * depth + night * H * 0.04 * depth;
    const draw = (l: Layer) => {
      const y = yOf(l.top, l.depth);
      const w = l.day.width / s.q, h = l.day.height / s.q;
      g.globalAlpha = 1; g.drawImage(l.day, 0, y, w, h);
      if (night > 0) { g.globalAlpha = night; g.drawImage(l.night, 0, y, w, h); }
      return y;
    };
    // «Play»: from the period two sound waves roll out over the valley, a beat apart.
    // On the ground plane, so the rings are flattened by perspective.
    const waves = [[T.flash + 0.05, 1], [T.flash + 0.05 + BEAT, 0.55]].map(([t0, a]) => ({ R: (st - t0) * W * 1.5, a }));
    const reach = W * 1.7;
    const ripple = (x: number, y: number) => {
      let e = 0;
      const d = Math.hypot(x - dotX, (y - dotY) / 0.45);
      for (const w of waves) if (w.R > 0 && w.R < reach) e += w.a * Math.exp(-Math.pow((d - w.R) / (W * 0.08), 2)) * (1 - smooth(w.R / reach));
      return e;
    };
    s.ridges.forEach((l, i) => {
      const y = draw(l);
      haze(y + (i ? H * 0.07 : 18), [0.5, 0.35, 0.18][i] * (1 - night * 0.5));
      if (i < 2) {
        // a river of mist between the hills carrying a slow waveform; it flattens as the sun goes down
        const mw = s.mist.width / s.q, mh = s.mist.height / s.q;
        const my = y + H * (0.065 + i * 0.05);
        const scroll = (wall * (10 + i * 8)) % (mw - W);
        const flat = 1 - smooth((st - 3.4) / 1.2);
        const amp = H * (0.02 - i * 0.009) * flat * (0.75 + 0.25 * bar(wall));
        const off = (x: number) => amp * waveform(x / W, wall + i * 2) - H * 0.025 * ripple(x, my + mh / 2);
        g.globalAlpha = (0.6 - i * 0.2) * (1 - night * 0.85);
        // exact device-pixel columns: overlapping translucent slices would show seams
        g.setTransform(1, 0, 0, 1, 0, 0);
        const cw = 6, src = Math.round(scroll * s.q);
        for (let px = 0; px < cv.width; px += cw) {
          const w = Math.min(cw, cv.width - px);
          g.drawImage(s.mist, src + px, 0, w, s.mist.height, px, (my + off((px + cw / 2) / q)) * q, w, mh * q);
        }
        g.setTransform(q, 0, 0, q, 0, 0);
        if (i === 0) {
          // the light caught along its crest makes the waveform readable
          g.save();
          g.globalAlpha = 0.5 * lit * flat;
          g.strokeStyle = 'rgba(255,238,196,1)'; g.lineWidth = 1.2;
          g.shadowColor = 'rgba(255,226,170,.9)'; g.shadowBlur = 6 * q;
          g.beginPath();
          for (let x = 0; x <= W; x += 8) g.lineTo(x, my + mh / 2 + off(x));
          g.stroke();
          g.restore();
        }
      }
    });
    draw(s.meadow);
    // pollen in the low light, fireflies at dusk
    const fire = smooth((st - 2.6) / 1.4);
    const motesA = 1 - smooth((st - T.fade) / 0.6);
    // fireflies answer the beat in four groups, one group per beat; the waves light them as they pass
    const beatNo = Math.floor(wall / BEAT), beatF = (wall / BEAT) % 1;
    const mote = (x: number, y: number, size: number, day: number, dusk: number) => {
      g.globalAlpha = clamp(day * (1 - fire) * motesA);
      if (g.globalAlpha > 0) g.drawImage(s.pollen, x - size / 2, y - size / 2, size, size);
      g.globalAlpha = clamp(dusk * fire * motesA);
      if (g.globalAlpha > 0) g.drawImage(s.fly, x - size / 2, y - size / 2, size, size);
    };
    g.globalCompositeOperation = 'lighter';
    s.motes.forEach((m, idx) => {
      const rise = (wall * m.v) % (H * 0.5);
      // fade in at the bottom of the climb and out at the top, so no mote ever pops
      const life = smooth(rise / (H * 0.06)) * smooth((H * 0.5 - rise) / (H * 0.06));
      const y = m.y + shift - rise;
      const x = m.x + Math.sin(wall * 0.6 + m.p) * 12 + Math.sin(wall * 1.3 + m.p * 2) * 4;
      const blink = clamp(0.2 + 0.8 * (beatNo % 4 === idx % 4 ? pluck(beatF) : 0) + ripple(x, y));
      mote(x, y, m.s * 9 * (1 + fire * blink * 0.8), 0.4 * life, blink * life);
    });
    g.globalCompositeOperation = 'source-over';
    // near spruces bend from the root in the wind and part like curtains at night
    const part = smooth((st - T.night) / (T.fade - T.night + 0.6)) * W * 0.36;
    const bendDraw = (sp: Sprite, dx: number, bend: number, lift: number) => {
      const base = sp.y + sp.h; // bends from its own root
      g.setTransform(q, 0, q * bend, q, q * (dx - bend * base), q * lift);
      if (sp.halo && lit > 0) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.2 * lit * smooth(st / 1.5);
        g.drawImage(sp.halo, sp.x, sp.y, sp.w, sp.h);
        g.globalCompositeOperation = 'source-over';
      }
      g.globalAlpha = 1; g.drawImage(sp.day, sp.x, sp.y, sp.w, sp.h);
      if (night > 0) { g.globalAlpha = night; g.drawImage(sp.night, sp.x, sp.y, sp.w, sp.h); }
    };
    const lift = descend * H * 0.35 + night * H * 0.04;
    // wind on the bar, and the sound waves push everything away from the period as they pass
    const centre = (sp: Sprite) => sp.x + sp.w / 2;
    const push = (sp: Sprite, l: number) => ripple(centre(sp), sp.y + sp.h + l) * (centre(sp) > dotX ? 1 : -1);
    s.near.forEach((sp, i) => sp && bendDraw(sp, (centre(sp) < W / 2 ? -1 : 1) * part * (1 + (i % 3) * 0.15), -0.012 * gust(centre(sp), wall) - 0.004 - 0.008 * bar(wall) - 0.045 * push(sp, lift), lift));
    for (const t of s.tufts) bendDraw(t, 0, -0.16 * gust(centre(t), wall) - 0.05 - 0.07 * bar(wall) - 0.35 * push(t, lift * 1.1), lift * 1.1);
    g.setTransform(q, 0, 0, q, 0, 0);
    // a few lights drifting right in front of the lens, far out of focus
    g.globalCompositeOperation = 'lighter';
    for (const b of s.bokeh) {
      const x = b.x + Math.sin(wall * 0.25 + b.p) * W * 0.02;
      const y = b.y + shift - wall * b.v + Math.sin(wall * 0.4 + b.p) * H * 0.01;
      mote(x, y, b.s, 0.09, 0.16 * (0.6 + 0.4 * Math.sin(wall * 1.1 + b.p)));
    }
    g.globalCompositeOperation = 'source-over';
    // night settles into --bg with Home's soft green glow around the hero
    if (night > 0) {
      g.globalAlpha = night * 0.9;
      gr = g.createRadialGradient(dotX, hY, 0, dotX, hY, Math.max(W, H) * 0.6);
      gr.addColorStop(0, '#0d2216'); gr.addColorStop(0.5, css(BG)); gr.addColorStop(1, css(BG));
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    // the waves themselves: a soft band of jade light sweeping over the land, never a drawn line
    for (const w of waves) {
      if (w.R <= 0 || w.R >= reach) continue;
      const a = w.a * (1 - smooth(w.R / reach)) * smooth(w.R / (W * 0.05));
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.shadowColor = css(JADE, 1); g.shadowBlur = 26 * q;
      for (const [width, alpha] of [[14 + w.R * 0.04, 0.12], [4 + w.R * 0.01, 0.2]]) {
        // brightest where it rolls toward the viewer, dissolving into the horizon at its ends
        const fadeIn = g.createLinearGradient(0, dotY, 0, dotY + w.R * 0.45);
        fadeIn.addColorStop(0, css(JADE, 0)); fadeIn.addColorStop(0.6, css(JADE, alpha * a)); fadeIn.addColorStop(1, css(JADE, alpha * a));
        g.lineWidth = width; g.strokeStyle = fadeIn;
        g.beginPath(); g.ellipse(dotX, dotY + 4, w.R, w.R * 0.45, 0, 0.04, Math.PI - 0.04); g.stroke();
      }
      g.restore();
    }
    // the green flash: the sun's last sliver turns jade and rounds up into the period
    const flash = smooth((st - (T.flash - 0.22)) / 0.3);
    if (flash > 0) {
      const settle = smooth((st - T.flash) / 0.45);
      const bloomR = dotR * (1 + 2.4 * (1 - settle) * flash);
      g.globalAlpha = 1;
      gr = g.createRadialGradient(dotX, dotY, 0, dotX, dotY, bloomR * 5);
      gr.addColorStop(0, css(JADE, 0.5 * flash)); gr.addColorStop(1, css(JADE, 0));
      g.fillStyle = gr; g.fillRect(dotX - bloomR * 5, dotY - bloomR * 5, bloomR * 10, bloomR * 10);
      g.fillStyle = css(mixc(AMBER, JADE, smooth((st - T.flash + 0.2) / 0.3)), flash);
      // soft while it flares, crisp once it is the period
      g.shadowColor = css(JADE, 0.9); g.shadowBlur = bloomR * 2.5 * (1 - settle) * q;
      g.beginPath(); g.ellipse(dotX, dotY, bloomR * (1 + 0.7 * (1 - settle)), bloomR * (1 - 0.5 * (1 - settle)), 0, 0, 6.29); g.fill();
      g.shadowBlur = 0;
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
