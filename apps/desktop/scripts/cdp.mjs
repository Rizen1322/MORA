// Minimal Chrome DevTools Protocol client for driving the desktop app in tests.
// The app must be started with --remote-debugging-port=<port>.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForPage(port, { timeoutMs = 60_000, match = /^http:\/\/127\.0\.0\.1:\d+\// } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && match.test(t.url));
      if (page) return page;
    } catch { /* not listening yet */ }
    await sleep(50);
  }
  throw new Error('page did not appear');
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression, { timeoutMs = 60_000 } = {}) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => { throw new Error(`evaluate timeout: ${expression.slice(0, 80)}`); }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, { timeoutMs = 60_000, intervalMs = 100 } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const v = await evaluate(expression); if (v) return v; } catch { /* page navigating */ }
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timeout: ${expression.slice(0, 120)}`);
  };
  return { ws, send, evaluate, waitFor, on: (fn) => listeners.add(fn), close: () => ws.close() };
}

export { sleep };
