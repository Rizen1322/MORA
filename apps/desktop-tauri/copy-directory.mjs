import fs from 'node:fs';
import path from 'node:path';

// Node 22 can fail to copy an entire tree when the Windows checkout path contains Cyrillic.
export function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(source, destination);
    else if (entry.isFile()) fs.copyFileSync(source, destination);
  }
}
