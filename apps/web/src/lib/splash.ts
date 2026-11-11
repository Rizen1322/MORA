/**
 * Launch intro «Одна линия», silent, 4 s. Out of the app's night a sheet of paper blooms,
 * a brush draws the MORA mark in one stroke, one beat cuts to graph paper, the word is set
 * letter by letter and closed with an amber period. Then the ink floods the sheet back into
 * --bg while the period turns jade and lands on the period of «Моя волна.» on Home.
 * Everything is drawn at startup on one 2D canvas: no assets, no dependencies.
 */
import './splash.css';

type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D;

/** The scene keeps an unheard tempo: every cut sits on this grid, the word lands on a downbeat. */
export const BEAT = 0.25;
/** Scene seconds. HOLD is where the scene waits (logo complete) while the app is still loading. */
export const T = { bloom: 0.5, grid: 1.75, word: 2, dot: 2.5, hold: 2.75, fade: 3.4, end: 4 };
const LINE_END = 1.7, FLOOD = 0.7, MAX_WAIT = 10;

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#050d0a');
const JADE = hex('#4ade9a');
/** --glow, deepened so it holds on paper. */
const SUN = hex('#e8a13a');
// the ink is --bg itself: when it floods the sheet, mark and word dissolve into it without a seam
const PAPER = '#ece3cf', GRAPH = '#f3f1ea', INK = '#050d0a';
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (v: number) => { const x = clamp(v); return x * x * (3 - 2 * x); };
const out = (v: number) => 1 - Math.pow(1 - clamp(v), 3);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Stroke width of the mark, in units of its own width. */
const MARK_W = 157 / 951;
/**
 * Centreline of the MORA mark (traced from logo.png), evenly spaced, in units of the mark's
 * width with the origin at its centre: up, over the big arch, under the turn, over the small arch, down.
 */
export function markPath(step = 4): [number, number][] {
  const p: [number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step);
    for (let i = 0; i < n; i++) p.push([mix(x0, x1, i / n), mix(y0, y1, i / n)]);
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const n = Math.ceil((Math.abs(a1 - a0) * r) / step);
    for (let i = 0; i < n; i++) { const a = mix(a0, a1, i / n); p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  line(245, 870, 245, 558);
  arc(418, 558, 173, Math.PI, 2 * Math.PI);
  line(591, 558, 591, 786);
  arc(682, 786, 91, Math.PI, 0);
  line(773, 786, 773, 694);
  arc(907, 694, 134, Math.PI, 2 * Math.PI);
  line(1041, 694, 1041, 890);
  p.push([1041, 890]);
  return p.map(([x, y]) => [(x - 640) / 951, (y - 628) / 951]);
}

/** Paper tooth: specks and a few fibres, tiled. */
function paperTile() {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  const r = rng(11);
  for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(70,50,20,${0.02 + r() * 0.05})`; g.fillRect(r() * 160, r() * 160, 1, 1); }
  g.lineWidth = 0.6;
  for (let i = 0; i < 26; i++) {
    const x = r() * 160, y = r() * 160, a = r() * 6.28, l = 3 + r() * 7;
    g.strokeStyle = r() < 0.5 ? 'rgba(255,252,240,.35)' : 'rgba(80,60,30,.07)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return c;
}

/** Lit cells on the graph-paper beat, in grid cells from the mark's centre; all clear of the stroke. */
const CELLS = [[-7, 2], [-3, 0], [1, -4], [6, -3], [4, 5], [-1, 5]];

/** Where the ink breaks through on the iPhone, as [x, y, delay] in screen and flood fractions; the first sits on the period. */
const ERODE = [[0, 0, 0], [0.16, 0.2, 0.1], [0.84, 0.76, 0.16], [0.24, 0.84, 0.24], [0.8, 0.14, 0.3], [0.5, 0.5, 0.36], [0.08, 0.52, 0.42]];

export interface SplashOptions {
  /** True once the interface underneath is worth revealing. */
  ready: () => boolean;
  /** Home's jade period, the point the amber period lands on. */
  target: () => Element | null;
}

/** True while the intro owns the screen: the iPhone native shell steps aside (native-ui.ts). */
export let splashing = false;
const release = () => { if (splashing) { splashing = false; dispatchEvent(new Event('mora-splash')); } };

export function playSplash({ ready, target }: SplashOptions) {
  const root = document.createElement('div');
  root.className = 'splash';
  root.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas');
  root.append(cv);
  const g = cv.getContext('2d') as Ctx | null;
  if (!g) return;
  document.body.append(root);
  splashing = true;

  const P = markPath();
  const fringe = Array.from({ length: 181 }, rng(5));
  const tooth = g.createPattern(paperTile(), 'repeat');
  let W = 0, H = 0, q = 1;
  let dotX = 0, dotY = 0, dotR = 0, aimed = false;
  // `?splash=2.6` holds the scene at that second, for design review
  const freeze = Number(new URLSearchParams(location.search).get('splash')) || 0;
  let st = 0, last = 0, wall = 0, fade = -1, fadeLen = T.end - T.fade, revealed = false, done = false;

  const reduced = () => {
    const m = document.documentElement.dataset.motion;
    return m === 'reduced' || (m === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };
  const measure = () => {
    const el = target();
    const b = el?.getBoundingClientRect();
    if (!b || !b.width) return;
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
    root.removeEventListener('pointerdown', skip);
    removeEventListener('keydown', skip, true);
    root.remove();
    release();
  };
  root.addEventListener('pointerdown', skip);
  addEventListener('keydown', skip, true);
  // nothing on the page uses the display face this early; the scene waits for it before the word
  void document.fonts.load('700 40px "Unbounded Variable"');

  /** The stroke so far: a filled ribbon with a round heel, a breathing width and a tapered brush tip. */
  const stroke = (head: number, s: number, paper: string) => {
    const n = Math.min(P.length - 1, Math.floor(head));
    const w = MARK_W * s;
    const tip = (w * 0.55) / ((4 / 951) * s); // taper length, in path points
    const L: number[] = [], R: number[] = [];
    const at = (i: number) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [P[i][0] * s, P[i][1] * s, -(b[1] - a[1]) / d, (b[0] - a[0]) / d];
    };
    for (let i = 0; i <= n; i++) {
      const [x, y, nx, ny] = at(i);
      // the hand is never a ruler: pressure drifts a little along the stroke
      const hw = 0.5 * w * (0.955 + 0.045 * Math.sin(i * 0.05 + 1)) * Math.sqrt(clamp((head - i) / tip));
      L.push(x + nx * hw, y + ny * hw); R.push(x - nx * hw, y - ny * hw);
    }
    g.fillStyle = INK;
    g.beginPath(); g.arc(P[0][0] * s, P[0][1] * s, 0.5 * w * 0.955 * Math.sqrt(clamp(head / tip)), 0, 6.29); g.fill();
    g.beginPath();
    for (let i = 0; i < L.length; i += 2) g.lineTo(L[i], L[i + 1]);
    for (let i = R.length - 2; i >= 0; i -= 2) g.lineTo(R[i], R[i + 1]);
    g.fill();
    // the brush runs dry toward the end: hairlines of paper show through
    const from = Math.floor(P.length * 0.6), to = Math.min(n, head - tip * 1.6);
    g.strokeStyle = paper; g.lineWidth = Math.max(0.6, w * 0.014);
    [-0.31, -0.12, 0.09, 0.27].forEach((o, k) => {
      for (let c = 0; c < 3; c++) {
        const a = Math.floor(mix(from, P.length, c / 3)) + k * 9, b = Math.min(to, Math.floor(mix(from, P.length, (c + 1) / 3)) - k * 5);
        if (b <= a) continue;
        g.globalAlpha = 0.1 + c * 0.11;
        g.beginPath();
        for (let i = a; i <= b; i += 2) { const [x, y, nx, ny] = at(i); g.lineTo(x + nx * w * o, y + ny * w * o); }
        g.stroke();
      }
    });
    g.globalAlpha = 1;
  };

  const frame = (now: number) => {
    if (done) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    wall += dt;
    if (document.hidden && fade < 0) skip();
    if (reduced() && fade < 0) { fade = st; fadeLen = 0.25; }
    if (W !== innerWidth || H !== innerHeight) {
      W = innerWidth; H = innerHeight;
      // weak GPUs and 4K screens: cap the backing store at ~3.6 MP
      q = Math.min(devicePixelRatio || 1, 3, Math.sqrt(3.6e6 / (W * H)));
      cv.width = Math.round(W * q); cv.height = Math.round(H * q);
    }
    measure();
    // iPhone: native screens take over instead of the web Home, so there is nothing to aim at
    const cover = document.documentElement.classList.contains('mora-native-shell');

    // layout: mark over word, the pair centred a touch above the middle
    const mw = Math.min(W * 0.52, H * 0.36), fs = mw * 0.19;
    const cx = W / 2, cy = (H - mw * 0.68 - fs * 1.55) / 2 + mw * 0.34 - H * 0.015;
    const font = `700 ${fs}px "Unbounded Variable", Unbounded, sans-serif`;
    const fontOk = document.fonts.check(font);
    const waiting = wall < MAX_WAIT && ((st >= LINE_END && st < T.grid && !fontOk) || (st >= T.hold && !(ready() && (aimed || cover))));
    if (freeze) st = freeze;
    else if (!waiting) st += dt;

    // a slow push-in keeps the still frames alive
    const zoom = 1 + 0.025 * smooth(st / T.hold);
    const flood = clamp((st - T.hold) / FLOOD);
    const graph = st >= T.grid && st < T.word;
    const paper = graph ? GRAPH : PAPER;

    g.setTransform(q, 0, 0, q, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = flood >= 1 ? css(BG) : paper;
    g.fillRect(0, 0, W, H);

    // the word's geometry, measured in its own font
    g.font = font;
    const track = fs * 0.14, letters = [...'MORA'].map((ch) => ({ ch, w: g.measureText(ch).width }));
    const pr = fs * 0.09, wordW = letters.reduce((a, l) => a + l.w + track, 0) + pr * 2;
    const baseY = cy + mw * 0.34 + fs * 1.55;
    const px = cx + wordW / 2 - pr, py = baseY - pr;

    if (flood < 1) {
      if (!graph) {
        if (tooth) { g.fillStyle = tooth; g.fillRect(0, 0, W, H); }
        const v = g.createRadialGradient(cx, H * 0.45, Math.min(W, H) * 0.3, cx, H * 0.45, Math.hypot(W, H) * 0.62);
        v.addColorStop(0, 'rgba(120,88,40,0)'); v.addColorStop(1, 'rgba(120,88,40,.2)');
        g.fillStyle = v; g.fillRect(0, 0, W, H);
      }
      g.translate(cx, H / 2); g.scale(zoom, zoom); g.translate(-cx, -H / 2);
      if (graph) {
        // one beat on graph paper: the same mark, read as a score
        const c = mw / 10, k = (st - T.grid) / (T.word - T.grid);
        g.strokeStyle = 'rgba(16,26,20,.15)'; g.lineWidth = 1 / zoom;
        g.beginPath();
        for (let x = cx - Math.ceil(cx / c) * c; x <= W; x += c) { g.moveTo(x, -H); g.lineTo(x, 2 * H); }
        for (let y = cy - Math.ceil((cy + H) / c) * c; y <= 2 * H; y += c) { g.moveTo(-W, y); g.lineTo(2 * W, y); }
        g.stroke();
        g.fillStyle = css(SUN);
        CELLS.forEach(([i, j], n) => { if (k >= n / 8) g.fillRect(cx + i * c, cy + j * c, c, c); });
      }
      if (st > T.bloom) {
        g.save(); g.translate(cx, cy);
        const breathe = waiting ? 1 + 0.01 * Math.sin(wall * 2.4) : 1;
        stroke((P.length - 1) * smooth((st - T.bloom) / (LINE_END - T.bloom)), mw * breathe, paper);
        g.restore();
      }
      // MORA, set letter by letter: each one drops into place on its own tenth of a second
      g.fillStyle = INK; g.textBaseline = 'alphabetic';
      let x = cx - wordW / 2;
      letters.forEach((l, i) => {
        const k = (st - T.word - i * 0.1) / 0.16;
        if (k > 0) g.fillText(l.ch, x, baseY + (1 - out(k)) * fs * 0.16);
        x += l.w + track;
      });
      g.setTransform(q, 0, 0, q, 0, 0);
    }

    // the period's place on screen, through the push-in
    const sx = cx + (px - cx) * zoom, sy = H / 2 + (py - H / 2) * zoom;

    // ink soaks out from the period, slowly at first, then takes the whole sheet
    if (flood > 0 && flood < 1) {
      const R = Math.hypot(Math.max(sx, W - sx), Math.max(sy, H - sy)) * 1.2 * Math.pow(flood, 2.1);
      // the wet edge: soft lobes where the paper drinks faster, layered so the rim bleeds instead of ending
      const lobe = (u: number) => { const i = Math.floor(u), v = mix(fringe[i % 180], fringe[(i + 1) % 180], smooth(u - i)); return v * v; };
      const blot = (x: number, y: number, R: number, turn: number, feather: number) => {
        g.beginPath();
        for (let i = 0; i <= 720; i += cover ? 2 : 1) {
          const a = (i / 720) * 6.2832 + turn;
          const r = R * (1 + 0.05 * Math.sin(5 * a + 1.3) + 0.035 * Math.sin(9 * a + 4.1) + 0.02 * Math.sin(17 * a + 0.7) + feather * (0.02 + 0.1 * lobe(i / 4 + turn * 20) + 0.03 * lobe(i / 1.5 + 60))) + feather * 4;
          g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        g.fill();
      };
      // iPhone: no period to land on, so the sheet is eaten away from several spots at once
      const spots = cover
        ? ERODE.map(([u, v, d], n) => [n ? u * W : sx, n ? v * H : sy, Math.hypot(W, H) * 0.62 * Math.pow(clamp((flood - d) / (1 - d)), 1.9), n * 1.7])
        : [[sx, sy, R, 0]];
      for (const [f, a] of [[1, 0.14], [0.7, 0.2], [0.42, 0.3], [0.18, 0.5], [0, 1]]) {
        g.fillStyle = css(BG, a);
        for (const [x, y, r, turn] of spots) if (r > 0) blot(x, y, r, turn, f);
      }
    }

    // the sheet is already gone by now; native screens need no long dissolve
    if (fade < 0 && st >= T.fade && !freeze) { fade = T.fade; if (cover) fadeLen = 0.2; }
    const k = fade < 0 ? 0 : smooth((st - fade) / fadeLen);

    // the period: stamped amber, turns jade in the ink and travels to Home's own period
    if (st >= T.dot) {
      const fly = cover || !aimed ? 0 : smooth((st - T.hold - 0.05) / 0.8);
      const x = mix(sx, dotX, fly), y = mix(sy, dotY, fly);
      const r = mix(pr * zoom * (1 + 1.3 * (1 - out((st - T.dot) / 0.22))), dotR, fly);
      const c: RGB = [0, 1, 2].map((i) => mix(SUN[i], JADE[i], cover ? 0 : smooth((st - T.hold) / 0.45))) as RGB;
      // on the iPhone the ink simply takes the period with the rest of the sheet
      g.globalAlpha = out((st - T.dot) / 0.12) * (cover ? 1 - smooth(flood / 0.3) : 1);
      const lit = cover ? 0 : smooth((st - T.hold) / 0.4) * (1 - 0.75 * smooth((st - T.fade) / 0.5));
      if (lit > 0) {
        const halo = g.createRadialGradient(x, y, 0, x, y, r * 7);
        halo.addColorStop(0, css(c, 0.4 * lit)); halo.addColorStop(1, css(c, 0));
        g.fillStyle = halo; g.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);
      }
      g.fillStyle = css(c);
      g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
      g.globalAlpha = 1;
    }

    // opening: the sheet blooms out of the app's night from the point the brush will touch
    const open = smooth(st / T.bloom);
    if (open < 1) {
      const ox = cx + P[0][0] * mw, oy = cy + P[0][1] * mw, far = Math.hypot(W, H);
      const r0 = far * 1.3 * open * open;
      const m = g.createRadialGradient(ox, oy, r0 * 0.55, ox, oy, r0 + far * 0.12);
      m.addColorStop(0, css(BG, 0)); m.addColorStop(1, css(BG, 1));
      g.fillStyle = m; g.fillRect(0, 0, W, H);
      const spark = smooth(st / 0.18) * (1 - smooth((st - 0.22) / 0.26));
      const sr = mw * 0.016;
      const halo = g.createRadialGradient(ox, oy, 0, ox, oy, sr * 9);
      halo.addColorStop(0, css(SUN, 0.5 * spark)); halo.addColorStop(1, css(SUN, 0));
      g.fillStyle = halo; g.fillRect(ox - sr * 9, oy - sr * 9, sr * 18, sr * 18);
      g.fillStyle = css(SUN, spark);
      g.beginPath(); g.arc(ox, oy, sr, 0, 6.29); g.fill();
    }

    if (fade >= 0) {
      if (waiting) st += dt; // a skip runs on wall time even while the scene waits for the app
      if (cover) {
        // native screens appear over the page: go dark first, then let them in
        g.fillStyle = css(BG, k); g.fillRect(0, 0, W, H);
        if (k >= 1) { done = true; release(); setTimeout(stop, 300); return; }
      } else {
        if (!revealed) { revealed = true; root.style.pointerEvents = 'none'; document.documentElement.classList.add('splash-reveal'); }
        root.style.opacity = String(1 - k);
        if (k >= 1) { done = true; stop(); setTimeout(() => document.documentElement.classList.remove('splash-reveal'), 1200); return; }
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const SPLASH_KEY = 'mora.splash';
export function splashEnabled() {
  try { return localStorage.getItem(SPLASH_KEY) !== 'off'; } catch { return true; }
}
export function setSplashEnabled(on: boolean) {
  try { localStorage.setItem(SPLASH_KEY, on ? 'on' : 'off'); } catch { /* kept until restart */ }
}
