import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 required');
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(here, 'toolchain');
const archive = 'node-v22.23.4-win-x64.zip';
const hash = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20';
const file = path.join(directory, archive);
const executable = path.join(directory, 'node-v22.23.4-win-x64', 'node.exe');
const valid = () => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === hash;
fs.mkdirSync(directory, { recursive: true });
if (!valid()) {
  const response = await fetch(`https://nodejs.org/dist/v22.23.4/${archive}`);
  if (!response.ok) throw Error(`Node download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('Node archive checksum mismatch');
  fs.writeFileSync(file, bytes);
}
const executableHash = 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f';
if (!fs.existsSync(executable) || createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== executableHash) {
  const extraction = spawnSync('tar', ['-xf', file, '-C', directory], { stdio: 'inherit', windowsHide: true });
  if (extraction.status !== 0) throw Error('Node archive extraction failed');
}
if (createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== executableHash) throw Error('Node executable checksum mismatch');
const command = "if ((Get-AuthenticodeSignature -LiteralPath $env:MORA_NODE_EXE).Status -ne 'Valid') { exit 1 }";
const signature = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
  { env: { ...process.env, MORA_NODE_EXE: executable, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules') }, windowsHide: true });
if (signature.status !== 0) throw Error(`Node executable signature invalid: ${signature.error?.message ?? signature.stderr.toString()}`);
console.log(`Verified Node: ${executable}`);
