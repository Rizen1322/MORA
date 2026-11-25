const path = require('node:path');

const PATCHED = Symbol.for('mora.electronBuilderWinEnvPatched');

if (process.platform === 'win32') {
  const wineVmPath = path.resolve(__dirname, '../node_modules/app-builder-lib/out/vm/WineVm.js');
  try {
    const mod = require(wineVmPath);
    const proto = mod?.WineVmManager?.prototype;
    if (proto && typeof proto.execWine === 'function' && !proto.execWine[PATCHED]) {
      const original = proto.execWine;
      const wrapped = function execWine(params) {
        if (params && params.options && params.options.env) {
          return original.call(this, {
            ...params,
            options: {
              ...params.options,
              env: { ...process.env, ...params.options.env },
            },
          });
        }
        return original.call(this, params);
      };
      wrapped[PATCHED] = true;
      proto.execWine = wrapped;
    }
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}
