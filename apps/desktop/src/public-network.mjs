/** Use Chromium's first PAC route; DIRECT must not select a later proxy. */
export function proxyFromPac(pac) {
  const first = String(pac).split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+(\[[\da-f:]+\]|[\w.-]+):(\d{1,5})$/i.exec(first);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return undefined;
  const kind = match[1].toUpperCase();
  const scheme = kind === 'PROXY' ? 'http' : kind === 'HTTPS' ? 'https' : kind === 'SOCKS4' ? 'socks4' : 'socks5';
  return `${scheme}://${match[2]}:${match[3]}`;
}
