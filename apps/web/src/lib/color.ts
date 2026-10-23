const cache = new Map<string, [number, number, number][]>();

/** Dominant and dark companion colour of an artwork image (same-origin). */
export async function artColors(url: string): Promise<[number, number, number][]> {
  const hit = cache.get(url);
  if (hit) return hit;
  const img = new Image();
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  // weight saturated mid-bright pixels: they define the cover's character
  let r = 0, gg = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const sat = mx ? (mx - mn) / mx : 0;
    const lum = (R + G + B) / 3;
    const k = 0.15 + sat * sat * (lum > 30 && lum < 230 ? 1 : 0.2);
    r += R * k; gg += G * k; b += B * k; w += k;
  }
  let main: [number, number, number] = [r / w, gg / w, b / w];
  // keep it dark enough for white text on top (contrast)
  const lum = 0.2126 * main[0] + 0.7152 * main[1] + 0.0722 * main[2];
  if (lum > 110) main = main.map((v) => v * (110 / lum)) as [number, number, number];
  const dark = main.map((v) => v * 0.35) as [number, number, number];
  const res = [main.map(Math.round), dark.map(Math.round)] as [number, number, number][];
  cache.set(url, res);
  return res;
}

/** Deterministic placeholder colours for tracks without artwork. */
export function seedColors(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const hsl = (l: number) => {
    const a = (0.35 * Math.min(l, 1 - l));
    const f = (n: number) => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `${f(0)} ${f(8)} ${f(4)}`;
  };
  return [hsl(0.32), hsl(0.12)];
}
