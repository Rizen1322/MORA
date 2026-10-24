// Builds MORA brand assets from the repository's logo.png (green mark, transparent background):
//   apps/desktop/assets: icon.ico, icon.png (app tile), tray.png / @1.5x / @2x (bare mark)
//   apps/web/public:     icon.png (favicon / manifest tile), logo-mark.png (sidebar mark)
// Run: npx electron apps/desktop/scripts/make-icons.mjs
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const logo = `data:image/png;base64,${fs.readFileSync(path.join(root, 'logo.png')).toString('base64')}`;

// Runs inside the page: trims the mark, then draws either a dark tile with the mark or the bare mark.
const draw = `(async (logo, size, tile) => {
  const img = new Image(); img.src = logo; await img.decode();
  const src = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const sx = src.getContext('2d'); sx.drawImage(img, 0, 0);
  const a = sx.getImageData(0, 0, img.width, img.height).data;
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (a[(y * img.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: tile ? size : Math.round(size * h / w) });
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  if (tile) {
    const r = size * 0.22;
    g.beginPath(); g.roundRect(0, 0, size, size, r); g.clip();
    g.fillStyle = '#050d0a'; g.fillRect(0, 0, size, size);
    const glow = g.createRadialGradient(size * 0.3, size * 0.2, 0, size * 0.3, size * 0.2, size * 0.9);
    glow.addColorStop(0, 'rgba(40,110,78,0.55)'); glow.addColorStop(1, 'rgba(40,110,78,0)');
    g.fillStyle = glow; g.fillRect(0, 0, size, size);
    const mw = size * 0.66, mh = mw * h / w;
    g.drawImage(src, x0, y0, w, h, (size - mw) / 2, (size - mh) / 2 + size * 0.02, mw, mh);
  } else {
    g.drawImage(src, x0, y0, w, h, 0, 0, c.width, c.height);
  }
  return c.toDataURL('image/png');
})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const render = async (size, tile) => {
    const url = await win.webContents.executeJavaScript(`${draw}(${JSON.stringify(logo)}, ${size}, ${tile})`);
    return nativeImage.createFromDataURL(url).toPNG();
  };
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await render(s, true));
  // ICO with embedded PNG images (supported since Windows Vista).
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  const assets = path.join(desktop, 'assets');
  const pub = path.join(root, 'apps/web/public');
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([head, ...pngs]));
  fs.writeFileSync(path.join(assets, 'icon.png'), pngs[sizes.indexOf(256)]);
  fs.writeFileSync(path.join(pub, 'icon.png'), pngs[sizes.indexOf(256)]);
  // Tray: bare mark, width-fitted (16 / 24 / 32 px for 100 / 150 / 200 % scale).
  fs.writeFileSync(path.join(assets, 'tray.png'), await render(16, false));
  fs.writeFileSync(path.join(assets, 'tray@1.5x.png'), await render(24, false));
  fs.writeFileSync(path.join(assets, 'tray@2x.png'), await render(32, false));
  fs.writeFileSync(path.join(pub, 'logo-mark.png'), await render(144, false));
  console.log('icons written');
  app.quit();
});
