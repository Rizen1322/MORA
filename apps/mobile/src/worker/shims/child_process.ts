/**
 * node:child_process. There are no processes on iOS: ffmpeg and yt-dlp are replaced
 * at module level; anything else that spawns fails like a missing binary.
 */
const enoent = (cmd: string) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });

export function spawn(cmd: string): never { throw enoent(cmd); }
export function execFile(cmd: string, ...rest: unknown[]) {
  const cb = rest.find((x) => typeof x === 'function') as ((e: Error) => void) | undefined;
  if (cb) setTimeout(() => cb(enoent(cmd)), 0);
  return { on() {}, once() {}, kill() {} };
}
export function exec(cmd: string): never { throw enoent(cmd); }
export function execSync(cmd: string): never { throw enoent(cmd); }
export function spawnSync(cmd: string): never { throw enoent(cmd); }
export default { spawn, execFile, exec, execSync, spawnSync };
