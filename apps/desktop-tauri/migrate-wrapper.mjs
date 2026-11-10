Object.defineProperty(process, 'parentPort', { value: { postMessage: value => process.stdout.write(`${JSON.stringify(value)}\n`) } });
await import('../desktop/src/migrate.mjs');
