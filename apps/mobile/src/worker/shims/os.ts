/** node:os */
const os = {
  platform: () => 'ios',
  cpus: () => Array.from({ length: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) }, () => ({ model: 'apple' })),
  totalmem: () => 4 * 1024 ** 3,
  freemem: () => 1024 ** 3,
  tmpdir: () => '/tmp',
  homedir: () => '/',
  EOL: '\n',
};
export const { platform, cpus, totalmem, freemem, tmpdir, homedir, EOL } = os;
export default os;
