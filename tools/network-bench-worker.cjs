const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');

async function main() {
  const { kind, origin, dir, executable } = JSON.parse(process.env.AUTOMIX_NETWORK_BENCH);
  let fetcher = fetch, network;
  if (kind.startsWith('electron')) { const electron = require('electron'); electron.app.setPath('userData', path.join(dir, 'electron-profile')); electron.app.disableHardwareAcceleration(); await electron.app.whenReady(); fetcher = electron.net.fetch; }
  if (kind.endsWith('rust')) {
    const { tsImport } = await import('tsx/esm/api');
    const { createRustNetwork } = await tsImport('../apps/server/src/rust-network.ts', __filename);
    network = await createRustNetwork(executable, { default: '' });
    fetcher = network.fetch;
  }
  let peak = process.memoryUsage().rss;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const timings = [];
  for (let i = 0; i < 16; i++) {
    const start = performance.now(); const response = await fetcher(`${origin}/metadata`);
    await response.arrayBuffer(); timings.push(performance.now() - start);
  }
  const probe = path.join(dir, `${kind}-probe`), probeStart = performance.now();
  let firstAudioDiskByteMs;
  const probeTimer = setInterval(() => { void fsp.stat(probe).then(stat => { if (stat.size && firstAudioDiskByteMs === undefined) firstAudioDiskByteMs = performance.now() - probeStart; }).catch(() => {}); }, 1);
  if (network) await network.download(`${origin}/first-byte`, probe, { maxBytes: 65536, priority: 0 });
  else { const response = await fetcher(`${origin}/first-byte`); await pipeline(response.body, fs.createWriteStream(probe)); }
  clearInterval(probeTimer); await fsp.rm(probe);
  const transfer = performance.now();
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `${kind}-${i}`);
    if (network) await network.download(`${origin}/audio`, file, { maxBytes: 64 << 20, priority: 0 });
    else {
      const response = await fetcher(`${origin}/audio`);
      await pipeline(response.body, fs.createWriteStream(file));
    }
  }
  const transferMs = performance.now() - transfer;
  const workloadIncludingStartupMs = process.uptime() * 1000;
  const usage = process.resourceUsage();
  clearInterval(sample);
  let childMetrics = [];
  if (process.platform === 'win32') {
    const script = `$all=Get-CimInstance Win32_Process; $ids=@(${process.pid}); $found=@(); for($i=0;$i -lt 4;$i++){ $next=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $_.Name -in @('electron.exe','mora-network.exe') }); $found += $next; $ids=@($next.ProcessId) }; @($found | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ @{name=$p.ProcessName;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;peakRss=$p.PeakWorkingSet64} } }) | ConvertTo-Json -Compress`;
    const parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim() || '[]');
    childMetrics = Array.isArray(parsed) ? parsed : [parsed];
  }
  const hashes = [];
  for (let i = 0; i < 4; i++) {
    const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(path.join(dir, `${kind}-${i}`))) hash.update(chunk);
    hashes.push(hash.digest('hex'));
  }
  const sorted = timings.slice(1).sort((a,b) => a-b);
  const result = { kind, coldMetadataMs: timings[0], medianWarmMetadataMs: sorted[Math.floor(sorted.length / 2)], firstAudioDiskByteMs, transferMs, workloadIncludingStartupMs,
    throughputMiBs: 128 / (transferMs / 1000), cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
    peakRss: Math.max(peak, process.memoryUsage().rss), childMetrics, hashes };
  await network?.close();
  console.log(JSON.stringify(result));
  if (process.versions.electron) require('electron').app.quit();
}
main().catch(error => { console.error(error); process.exit(1); });
