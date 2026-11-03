/** Repair only export controls; review manifest, audio and plans stay intact. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absoluteExportBrowserScript } from './review-absolute-browser.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
for (const argument of process.argv.slice(2)) {
  const directory = path.resolve(argument), index = path.join(directory, 'index.html');
  const bytes = fs.readFileSync(path.join(directory, 'manifest.json')), manifestSha256 = hash(bytes);
  const manifest = JSON.parse(bytes.toString('utf8')), html = fs.readFileSync(index, 'utf8');
  if (!html.includes(manifestSha256)) throw Error('Page does not match manifest');
  for (const group of manifest.groups) for (const variant of group.variants) {
    for (const [file, expected] of [[variant.file, variant.sha256], [variant.planFile, variant.planSha256]]) {
      if (typeof file !== 'string' || path.basename(file) !== file || hash(fs.readFileSync(path.join(directory, file))) !== expected) throw Error('Review asset identity mismatch');
    }
  }
  const start = html.indexOf("    document.getElementById('export').onclick=");
  const end = html.indexOf('\n', start);
  if (start < 0 || end < 0) throw Error('Original handler missing or already fixed');
  const script = absoluteExportBrowserScript({ reviewId: manifest.reviewId, manifestSha256, groups: manifest.groups });
  const fixed = html.slice(0, start) + script + html.slice(end);
  fs.writeFileSync(path.join(directory, 'index.before-export-fix.html'), html, { flag: 'wx' });
  fs.writeFileSync(index, fixed);
  const record = { fixedAt: new Date().toISOString(), reviewId: manifest.reviewId, manifestSha256,
    beforeHtmlSha256: hash(html), afterHtmlSha256: hash(fixed), assetsVerified: true, change: 'export-controls-only' };
  fs.writeFileSync(path.join(directory, 'export-ui-fix.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(record));
}
